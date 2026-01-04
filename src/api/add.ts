import fs from 'fs-extra'
import path from 'path'

import { runOperation } from '../core/runner.js'
import { planReplaceTargetWithTmp } from '../core/backup.js'
import { detectKind, isSymlinkTo, planCopy, planEnsureSource, planUnlink, tmpPathForTarget } from '../core/plan.js'
import { getManifestBaseDir } from '../manifest/types.js'
import { loadOrCreateManifest, saveManifest, upsertEntry } from '../manifest/io.js'
import type { Manifest } from '../manifest/types.js'
import { CommonOptions, LinkKind, Result, Step } from '../types.js'
import type { ManifestInputOptions } from './manifest-input.js'
import { normalizeManifestJson, resolveBaseDir } from './manifest-input.js'

export interface Mapping {
  source: string
  target: string
  kind?: LinkKind
  atomic?: boolean
}

function mkLogger(opts?: CommonOptions) {
  return opts?.logger
}

function mkResult(operation: Result['operation'], manifestPath: string): Result {
  const now = new Date()
  return {
    ok: true,
    operation,
    manifestPath,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: 0,
    steps: [],
    warnings: [],
    errors: [],
    changes: [],
  }
}

function linkSteps(sourceAbs: string, targetAbs: string, kind: LinkKind, atomic: boolean): Step[] {
  const steps: Step[] = []
  steps.push({ kind: 'mkdirp', message: 'Ensure target parent directory exists', paths: { dir: path.dirname(targetAbs) } })
  const tmp = atomic ? tmpPathForTarget(targetAbs) : targetAbs
  steps.push({ kind: 'symlink', message: atomic ? 'Create symlink at temp path' : 'Create symlink', paths: { source: sourceAbs, target: tmp, kind } })
  if (atomic) {
    steps.push({ kind: 'move', message: 'Atomically move temp symlink into place', paths: { from: tmp, to: targetAbs } })
  }
  return steps
}

/**
 * add: write manifest + converge target to symlink(source).
 *
 * Safety rules:
 * - If source and target both exist AND target is not already a symlink to source => reject.
 * - If target exists and is not a symlink AND source is missing => migrate:
 *   copy(target -> source), move original target aside to backup, then link target -> source.
 * - If symlink creation fails => error (no copy fallback).
 */
export interface AddOptions extends CommonOptions, ManifestInputOptions {}

export async function add(manifest: string | unknown, mapping: Mapping, opts?: AddOptions): Promise<{ result: Result; manifest: Manifest }> {
  if (typeof manifest === 'string') {
    return await addFromPath(manifest, mapping, opts)
  }
  return await addFromJson(manifest, mapping, opts)
}

async function addFromPath(manifestPath: string, mapping: Mapping, opts?: AddOptions): Promise<{ result: Result; manifest: Manifest }> {
  const baseDir = getManifestBaseDir(manifestPath)

  const sourceAbs = path.isAbsolute(mapping.source) ? mapping.source : path.resolve(baseDir, mapping.source)
  const targetAbs = path.isAbsolute(mapping.target) ? mapping.target : path.resolve(baseDir, mapping.target)

  if (await isSymlinkTo(targetAbs, sourceAbs)) {
    const manifest = await loadOrCreateManifest(manifestPath)
    upsertEntry(manifest, { source: mapping.source, target: mapping.target, kind: mapping.kind as any, atomic: mapping.atomic })
    await saveManifest(manifestPath, manifest)
    const result = await runOperation({
      operation: 'add',
      manifestPath,
      steps: [],
      opts,
      finalize: async (res) => {
        res.steps.push({ kind: 'write_manifest', message: 'Update manifest', status: 'executed', paths: { file: path.resolve(manifestPath) } })
        res.changes.push({ action: 'manifest_upsert', source: sourceAbs, target: targetAbs })
        return res
      },
    })
    return { result, manifest }
  }

  const sourceExists = await fs.pathExists(sourceAbs)
  const targetExists = await fs.pathExists(targetAbs)

  if (sourceExists && targetExists) {
    const current = await loadOrCreateManifest(manifestPath)
    const res = mkResult('add', manifestPath)
    res.ok = false
    res.errors.push(`Refusing to proceed: source and target both exist: source=${sourceAbs} target=${targetAbs}`)
    res.steps.push({ kind: 'noop', message: 'Safety refusal', status: 'failed', error: res.errors[0] })
    return { result: res, manifest: current }
  }

  let kind: LinkKind = mapping.kind ?? 'file'
  if (targetExists) {
    const st = await fs.lstat(targetAbs)
    if (st.isSymbolicLink()) {
      const current = await loadOrCreateManifest(manifestPath)
      const res = mkResult('add', manifestPath)
      res.ok = false
      res.errors.push(`Refusing to migrate: target is an existing symlink: ${targetAbs}`)
      res.steps.push({ kind: 'noop', message: 'Safety refusal', status: 'failed', error: res.errors[0] })
      return { result: res, manifest: current }
    }
    kind = st.isDirectory() ? 'dir' : 'file'
  } else if (sourceExists) {
    kind = await detectKind(sourceAbs)
  }

  const atomic = mapping.atomic ?? true
  const steps: Step[] = []

  if (!sourceExists && targetExists) {
    steps.push(...await planCopy({ fromAbs: targetAbs, toAbs: sourceAbs, kind, atomic }))
    // Move original target to backup, then put symlink into place.
    const { tmpAbs, steps: replaceSteps } = planReplaceTargetWithTmp({ targetAbs, atomic: true })
    steps.push(...replaceSteps.slice(0, 1)) // move target -> backup
    steps.push(...linkSteps(sourceAbs, targetAbs, kind, atomic)) // creates tmp + move tmp -> target
  } else {
    steps.push(...await planEnsureSource({ sourceAbs, kind }))
    if (targetExists) {
      steps.push(...await planUnlink({ targetAbs }))
    }
    steps.push(...linkSteps(sourceAbs, targetAbs, kind, atomic))
  }

  const manifest = await loadOrCreateManifest(manifestPath)
  upsertEntry(manifest, { source: mapping.source, target: mapping.target, kind: kind as any, atomic })

  const result = await runOperation({
    operation: 'add',
    manifestPath,
    steps,
    opts,
    finalize: async (res) => {
      if (!res.ok) return res
      try {
        await saveManifest(manifestPath, manifest)
        res.steps.push({ kind: 'write_manifest', message: 'Update manifest', status: 'executed', paths: { file: path.resolve(manifestPath) } })
        res.changes.push({ action: 'manifest_upsert', source: sourceAbs, target: targetAbs })
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e)
        res.ok = false
        res.errors.push(`Failed to write manifest: ${msg}`)
        res.steps.push({ kind: 'write_manifest', message: 'Update manifest', status: 'failed', error: msg, paths: { file: path.resolve(manifestPath) } })
      }
      return res
    },
  })
  return { result, manifest }
}

async function addFromJson(manifestJson: unknown, mapping: Mapping, opts?: AddOptions): Promise<{ result: Result; manifest: Manifest }> {
  const manifest = normalizeManifestJson(manifestJson)
  const baseDir = resolveBaseDir(opts)

  const sourceAbs = path.isAbsolute(mapping.source) ? mapping.source : path.resolve(baseDir, mapping.source)
  const targetAbs = path.isAbsolute(mapping.target) ? mapping.target : path.resolve(baseDir, mapping.target)

  const sourceExists = await fs.pathExists(sourceAbs)
  const targetExists = await fs.pathExists(targetAbs)

  if (await isSymlinkTo(targetAbs, sourceAbs)) {
    upsertEntry(manifest, { source: mapping.source, target: mapping.target, kind: mapping.kind as any, atomic: mapping.atomic })
    const result = await runOperation({
      operation: 'add',
      manifestPath: opts?.manifestPath,
      steps: [],
      opts,
      finalize: async (res) => {
        res.steps.push({ kind: 'write_manifest', message: 'In-memory manifest; not writing to disk', status: 'skipped' })
        res.changes.push({ action: 'manifest_upsert', source: sourceAbs, target: targetAbs })
        return res
      },
    })
    return { result, manifest }
  }

  if (sourceExists && targetExists) {
    const now = new Date().toISOString()
    const res: Result = {
      ok: false,
      operation: 'add',
      manifestPath: opts?.manifestPath,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      steps: [{ kind: 'noop', message: 'Safety refusal', status: 'failed', error: `Refusing to proceed: source and target both exist: source=${sourceAbs} target=${targetAbs}` }],
      warnings: [],
      errors: [`Refusing to proceed: source and target both exist: source=${sourceAbs} target=${targetAbs}`],
      changes: [],
    }
    return { result: res, manifest }
  }

  let kind: LinkKind = mapping.kind ?? 'file'
  if (targetExists) {
    const st = await fs.lstat(targetAbs)
    if (st.isSymbolicLink()) {
      const now = new Date().toISOString()
      const res: Result = {
        ok: false,
        operation: 'add',
        manifestPath: opts?.manifestPath,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        steps: [{ kind: 'noop', message: 'Safety refusal', status: 'failed', error: `Refusing to migrate: target is an existing symlink: ${targetAbs}` }],
        warnings: [],
        errors: [`Refusing to migrate: target is an existing symlink: ${targetAbs}`],
        changes: [],
      }
      return { result: res, manifest }
    }
    kind = st.isDirectory() ? 'dir' : 'file'
  } else if (sourceExists) {
    kind = await detectKind(sourceAbs)
  }

  const atomic = mapping.atomic ?? true
  const steps: Step[] = []

  if (!sourceExists && targetExists) {
    steps.push(...await planCopy({ fromAbs: targetAbs, toAbs: sourceAbs, kind, atomic }))
    // Move original target to backup, then put symlink into place.
    const { steps: replaceSteps } = planReplaceTargetWithTmp({ targetAbs, atomic: true })
    steps.push(...replaceSteps.slice(0, 1)) // move target -> backup
    steps.push(...(function linkSteps(sourceAbs: string, targetAbs: string, kind: LinkKind, atomic: boolean): Step[] {
      const s: Step[] = []
      s.push({ kind: 'mkdirp', message: 'Ensure target parent directory exists', paths: { dir: path.dirname(targetAbs) } })
      const tmp = atomic ? tmpPathForTarget(targetAbs) : targetAbs
      s.push({ kind: 'symlink', message: atomic ? 'Create symlink at temp path' : 'Create symlink', paths: { source: sourceAbs, target: tmp, kind } })
      if (atomic) s.push({ kind: 'move', message: 'Atomically move temp symlink into place', paths: { from: tmp, to: targetAbs } })
      return s
    })(sourceAbs, targetAbs, kind, atomic))
  } else {
    steps.push(...await planEnsureSource({ sourceAbs, kind }))
    if (targetExists) {
      steps.push(...await planUnlink({ targetAbs }))
    }
    steps.push(...(function linkSteps(sourceAbs: string, targetAbs: string, kind: LinkKind, atomic: boolean): Step[] {
      const s: Step[] = []
      s.push({ kind: 'mkdirp', message: 'Ensure target parent directory exists', paths: { dir: path.dirname(targetAbs) } })
      const tmp = atomic ? tmpPathForTarget(targetAbs) : targetAbs
      s.push({ kind: 'symlink', message: atomic ? 'Create symlink at temp path' : 'Create symlink', paths: { source: sourceAbs, target: tmp, kind } })
      if (atomic) s.push({ kind: 'move', message: 'Atomically move temp symlink into place', paths: { from: tmp, to: targetAbs } })
      return s
    })(sourceAbs, targetAbs, kind, atomic))
  }

  upsertEntry(manifest, { source: mapping.source, target: mapping.target, kind: kind as any, atomic })

  const result = await runOperation({
    operation: 'add',
    manifestPath: opts?.manifestPath,
    steps,
    opts,
    finalize: async (res) => {
      if (!res.ok) return res
      res.steps.push({ kind: 'write_manifest', message: 'In-memory manifest; not writing to disk', status: 'skipped' })
      res.changes.push({ action: 'manifest_upsert', source: sourceAbs, target: targetAbs })
      return res
    },
  })

  return { result, manifest }
}


