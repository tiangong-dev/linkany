import fs from 'fs-extra'
import path from 'path'

import { planReplaceTargetWithTmp } from '../core/backup.js'
import { runOperation } from '../core/runner.js'
import { detectKind, isSymlinkTo, tmpPathForTarget } from '../core/plan.js'
import { getManifestBaseDir, loadManifest, resolveEntry } from '../manifest/types.js'
import type { Manifest } from '../manifest/types.js'
import { CommonOptions, LinkKind, Result, Step } from '../types.js'
import type { ManifestInputOptions } from './manifest-input.js'
import { normalizeManifestJson, resolveBaseDir } from './manifest-input.js'

function mkLogger(opts?: CommonOptions) {
  return opts?.logger
}

function mkResult(operation: Result['operation'], manifestPath?: string): Result {
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
 * Ensure all targets are symlinks to sources. Never mutates manifest.
 * Safety: if any target exists and is not a symlink, abort without changes.
 */
export interface InstallOptions extends CommonOptions, ManifestInputOptions {}

export async function install(manifest: string | unknown, opts?: InstallOptions): Promise<{ result: Result; manifest: Manifest }> {
  if (typeof manifest === 'string') {
    return await installFromPath(manifest, opts)
  }
  return await installFromJson(manifest, opts)
}

async function installFromPath(manifestPath: string, opts?: InstallOptions): Promise<{ result: Result; manifest: Manifest }> {
  const logger = mkLogger(opts)
  const result = await (async (): Promise<{ result: Result; manifest: Manifest }> => {
    const manifest = await loadManifest(manifestPath)
    const baseDir = getManifestBaseDir(manifestPath)

    const allSteps: Step[] = []
    for (const entry of manifest.installs) {
      const r = resolveEntry(baseDir, entry)

      if (!await fs.pathExists(r.sourceAbs)) {
        const res = mkResult('install', manifestPath)
        res.ok = false
        res.errors.push(`Source missing: ${r.sourceAbs}`)
        res.steps.push({ kind: 'noop', message: 'Source missing; aborting without changes', status: 'failed', error: res.errors[0], paths: { source: r.sourceAbs } })
        return { result: res, manifest }
      }

      const targetExists = await fs.pathExists(r.targetAbs)
      if (targetExists) {
        const st = await fs.lstat(r.targetAbs)
        if (!st.isSymbolicLink()) {
          const res = mkResult('install', manifestPath)
          res.ok = false
          res.errors.push(`Conflict: target exists and is not a symlink: ${r.targetAbs}`)
          res.steps.push({ kind: 'noop', message: 'Conflict detected; aborting without changes', status: 'failed', error: res.errors[0], paths: { target: r.targetAbs } })
          return { result: res, manifest }
        }
      }

      const kind: LinkKind = (r.kind as LinkKind | undefined) ?? await detectKind(r.sourceAbs)

      if (await isSymlinkTo(r.targetAbs, r.sourceAbs)) continue

      if (targetExists) {
        // Stronger atomic replace: move old target aside to backup, then replace with tmp.
        if (r.atomic) {
          const { steps: replaceSteps } = planReplaceTargetWithTmp({ targetAbs: r.targetAbs, atomic: true })
          allSteps.push(...replaceSteps.slice(0, 1)) // move target -> backup
        } else {
          allSteps.push({ kind: 'unlink', message: 'Remove existing target symlink before linking', paths: { target: r.targetAbs } })
        }
      }
      allSteps.push(...linkSteps(r.sourceAbs, r.targetAbs, kind, r.atomic))
    }

    const result = await runOperation({
      operation: 'install',
      manifestPath,
      steps: allSteps,
      opts,
    })
    return { result, manifest }
  })()
  logger // keep logger referenced (existing pattern)
  return result
}

async function installFromJson(manifestJson: unknown, opts?: InstallOptions): Promise<{ result: Result; manifest: Manifest }> {
  const manifest: Manifest = normalizeManifestJson(manifestJson)
  const baseDir = resolveBaseDir(opts)

  const allSteps: Step[] = []
  for (const entry of manifest.installs) {
    const r = resolveEntry(baseDir, entry)

    if (!await fs.pathExists(r.sourceAbs)) {
      const res = mkResult('install', opts?.manifestPath)
      res.ok = false
      res.errors.push(`Source missing: ${r.sourceAbs}`)
      res.steps.push({ kind: 'noop', message: 'Source missing; aborting without changes', status: 'failed', error: res.errors[0], paths: { source: r.sourceAbs } })
      return { result: res, manifest }
    }

    const targetExists = await fs.pathExists(r.targetAbs)
    if (targetExists) {
      const st = await fs.lstat(r.targetAbs)
      if (!st.isSymbolicLink()) {
        const res = mkResult('install', opts?.manifestPath)
        res.ok = false
        res.errors.push(`Conflict: target exists and is not a symlink: ${r.targetAbs}`)
        res.steps.push({ kind: 'noop', message: 'Conflict detected; aborting without changes', status: 'failed', error: res.errors[0], paths: { target: r.targetAbs } })
        return { result: res, manifest }
      }
    }

    const kind: LinkKind = (r.kind as LinkKind | undefined) ?? await detectKind(r.sourceAbs)

    if (await isSymlinkTo(r.targetAbs, r.sourceAbs)) continue

    if (targetExists) {
      if (r.atomic) {
        const { steps: replaceSteps } = planReplaceTargetWithTmp({ targetAbs: r.targetAbs, atomic: true })
        allSteps.push(...replaceSteps.slice(0, 1))
      } else {
        allSteps.push({ kind: 'unlink', message: 'Remove existing target symlink before linking', paths: { target: r.targetAbs } })
      }
    }
    allSteps.push(...linkSteps(r.sourceAbs, r.targetAbs, kind, r.atomic))
  }

  const result = await runOperation({
    operation: 'install',
    manifestPath: opts?.manifestPath,
    steps: allSteps,
    opts,
  })
  return { result, manifest }
}


