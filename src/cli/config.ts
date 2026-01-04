import fs from 'fs-extra'
import os from 'os'
import path from 'path'

export interface LinkanyConfig {
  manifestPath?: string
}

export interface ConfigEnv {
  env?: NodeJS.ProcessEnv
  /**
   * For tests or embedding, override home dir (default: os.homedir()).
   */
  homeDir?: string
}

export function getGlobalConfigPath(opts: ConfigEnv = {}): string {
  const env = opts.env ?? process.env
  const base = env.XDG_CONFIG_HOME || path.join(opts.homeDir ?? os.homedir(), '.config')
  return path.join(base, 'linkany', 'config.json')
}

export async function readGlobalConfig(opts: ConfigEnv = {}): Promise<LinkanyConfig> {
  const p = getGlobalConfigPath(opts)
  if (!await fs.pathExists(p)) return {}
  const json = await fs.readJson(p)
  if (!json || typeof json !== 'object') return {}
  const manifestPath = (json as any).manifestPath
  return typeof manifestPath === 'string' ? { manifestPath } : {}
}

export async function writeGlobalConfig(config: LinkanyConfig, opts: ConfigEnv = {}): Promise<void> {
  const p = getGlobalConfigPath(opts)
  await fs.ensureDir(path.dirname(p))
  await fs.writeJson(p, config, { spaces: 2 })
}

export async function setDefaultManifestPath(manifestPath: string, opts: ConfigEnv = {}): Promise<string> {
  const abs = path.resolve(manifestPath)
  await writeGlobalConfig({ manifestPath: abs }, opts)
  return abs
}

export async function getDefaultManifestPath(opts: ConfigEnv = {}): Promise<string | undefined> {
  const cfg = await readGlobalConfig(opts)
  return cfg.manifestPath
}

export async function clearDefaultManifestPath(opts: ConfigEnv = {}): Promise<void> {
  const p = getGlobalConfigPath(opts)
  if (!await fs.pathExists(p)) return
  await fs.remove(p)
}


