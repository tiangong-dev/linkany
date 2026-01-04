import { runOperation } from '../core/runner.js'
import { planUnlink } from '../core/plan.js'
import { getManifestBaseDir, loadManifest, resolveEntry } from '../manifest/types.js'
import type { Manifest } from '../manifest/types.js'
import { CommonOptions, Result, Step } from '../types.js'
import type { ManifestInputOptions } from './manifest-input.js'
import { normalizeManifestJson, resolveBaseDir } from './manifest-input.js'

function mkLogger(opts?: CommonOptions) {
  return opts?.logger
}

/**
 * Remove all target symlinks listed in manifest. Never deletes sources.
 */
export interface UninstallOptions extends CommonOptions, ManifestInputOptions {}

export async function uninstall(manifest: string | unknown, opts?: UninstallOptions): Promise<{ result: Result; manifest: Manifest }> {
  if (typeof manifest === 'string') {
    return await uninstallFromPath(manifest, opts)
  }
  return await uninstallFromJson(manifest, opts)
}

async function uninstallFromPath(manifestPath: string, opts?: UninstallOptions): Promise<{ result: Result; manifest: Manifest }> {
  const manifest = await loadManifest(manifestPath)
  const baseDir = getManifestBaseDir(manifestPath)

  const allSteps: Step[] = []
  for (const entry of manifest.installs) {
    const r = resolveEntry(baseDir, entry)
    allSteps.push(...await planUnlink({ targetAbs: r.targetAbs }))
  }

  const result = await runOperation({
    operation: 'uninstall',
    manifestPath,
    steps: allSteps,
    opts,
  })
  return { result, manifest }
}

async function uninstallFromJson(manifestJson: unknown, opts?: UninstallOptions): Promise<{ result: Result; manifest: Manifest }> {
  const manifest: Manifest = normalizeManifestJson(manifestJson)
  const baseDir = resolveBaseDir(opts)

  const allSteps: Step[] = []
  for (const entry of manifest.installs) {
    const r = resolveEntry(baseDir, entry)
    allSteps.push(...await planUnlink({ targetAbs: r.targetAbs }))
  }

  const result = await runOperation({
    operation: 'uninstall',
    manifestPath: opts?.manifestPath,
    steps: allSteps,
    opts,
  })
  return { result, manifest }
}


