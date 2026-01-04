import path from 'path'
import { Manifest, normalizeManifest } from '../manifest/types.js'

export interface ManifestInputOptions {
  /**
   * Base dir for resolving relative paths in manifest entries / mappings.
   * Default: process.cwd()
   */
  baseDir?: string
  /**
   * Optional manifestPath for observability/audit only.
   * - If provided, it will be set on Result.manifestPath.
   * - If opts.auditLogPath is NOT provided, audit default path will use this manifestPath.
   */
  manifestPath?: string
}

export function normalizeManifestJson(raw: unknown): Manifest {
  return normalizeManifest(raw)
}

export function resolveBaseDir(opts?: ManifestInputOptions): string {
  return path.resolve(opts?.baseDir ?? process.cwd())
}


