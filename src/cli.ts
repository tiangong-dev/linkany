#!/usr/bin/env node
import path from 'path'
import { fileURLToPath } from 'url'

import { add } from './api/add.js'
import { install } from './api/install.js'
import { remove } from './api/remove.js'
import { uninstall } from './api/uninstall.js'
import type { CommonOptions } from './types.js'
import { clearDefaultManifestPath, getDefaultManifestPath, setDefaultManifestPath } from './cli/config.js'

type Argv = string[]

class CliExit extends Error {
  exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

function die(msg: string, code = 1): never {
  throw new CliExit(msg, code)
}

function popFlagValue(args: Argv, names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!names.includes(a)) continue
    const v = args[i + 1]
    if (!v || v.startsWith('-')) return undefined
    args.splice(i, 2)
    return v
  }
  return undefined
}

function hasFlag(args: Argv, names: string[]): boolean {
  const idx = args.findIndex(a => names.includes(a))
  if (idx >= 0) {
    args.splice(idx, 1)
    return true
  }
  return false
}

function parseCommonOptions(args: Argv): CommonOptions & { auditLogPath?: string } {
  const dryRun = hasFlag(args, ['--dry-run'])
  const includePlanText = hasFlag(args, ['--plan'])
  const auditLogPath = popFlagValue(args, ['--audit-log'])
  return { dryRun, includePlanText, auditLogPath }
}

async function resolveManifestPath(args: Argv): Promise<string> {
  const m = popFlagValue(args, ['-m', '--manifest'])
  if (m) return path.resolve(m)
  const d = await getDefaultManifestPath()
  if (d) return d
  die('No manifest specified. Please run `linkany manifest set <path>` or pass `--manifest <path>`.')
}

function printHelp(): void {
  const msg = `
linkany

Usage:
  linkany manifest set <path>
  linkany manifest show
  linkany manifest clear

  linkany add --source <path> --target <path> [--kind file|dir] [--atomic|--no-atomic] [-m <manifest>] [--dry-run] [--plan]
  linkany remove <key> [--keep-link] [-m <manifest>] [--dry-run] [--plan]
  linkany install [-m <manifest>] [--dry-run] [--plan]
  linkany uninstall [-m <manifest>] [--dry-run] [--plan]
`
  process.stdout.write(msg.trimStart())
  process.stdout.write('\n')
}

function parseAddArgs(args: Argv): { source: string; target: string; kind?: 'file' | 'dir'; atomic?: boolean } {
  const source = popFlagValue(args, ['--source'])
  const target = popFlagValue(args, ['--target'])
  const kind = popFlagValue(args, ['--kind']) as any

  const atomic = hasFlag(args, ['--atomic']) ? true : (hasFlag(args, ['--no-atomic']) ? false : undefined)

  if (!source || !target) {
    die('add requires --source and --target')
  }
  if (kind && kind !== 'file' && kind !== 'dir') {
    die(`Invalid --kind: ${kind} (expected file|dir)`)
  }
  return { source, target, kind, atomic }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = [...argv]
    if (args.length === 0 || hasFlag(args, ['-h', '--help'])) {
      printHelp()
      return 0
    }

    const cmd = args.shift()
    if (!cmd) {
      printHelp()
      return 1
    }

    if (cmd === 'manifest') {
      const sub = args.shift()
      if (sub === 'set') {
        const p = args.shift()
        if (!p) die('manifest set requires a path')
        const abs = await setDefaultManifestPath(p)
        process.stdout.write(abs + '\n')
        return 0
      }
      if (sub === 'show') {
        const p = await getDefaultManifestPath()
        if (!p) die('No default manifest set. Run `linkany manifest set <path>`.', 2)
        process.stdout.write(p + '\n')
        return 0
      }
      if (sub === 'clear') {
        await clearDefaultManifestPath()
        return 0
      }
      die('Unknown manifest subcommand. Expected: set|show|clear')
    }

    if (cmd === 'add') {
      const opts = parseCommonOptions(args)
      const manifestPath = await resolveManifestPath(args)
      const mapping = parseAddArgs(args)
      if (args.length) die(`Unknown arguments: ${args.join(' ')}`)
      const res = await add(manifestPath, mapping, opts)
      process.stdout.write(JSON.stringify(res, null, 2) + '\n')
      return res.ok ? 0 : 1
    }

    if (cmd === 'remove') {
      const opts = parseCommonOptions(args)
      const manifestPath = await resolveManifestPath(args)
      const keepLink = hasFlag(args, ['--keep-link'])
      const key = args.shift()
      if (!key) die('remove requires <key>')
      if (args.length) die(`Unknown arguments: ${args.join(' ')}`)
      const res = await remove(manifestPath, key, { ...opts, keepLink })
      process.stdout.write(JSON.stringify(res, null, 2) + '\n')
      return res.ok ? 0 : 1
    }

    if (cmd === 'install') {
      const opts = parseCommonOptions(args)
      const manifestPath = await resolveManifestPath(args)
      if (args.length) die(`Unknown arguments: ${args.join(' ')}`)
      const res = await install(manifestPath, opts)
      process.stdout.write(JSON.stringify(res, null, 2) + '\n')
      return res.ok ? 0 : 1
    }

    if (cmd === 'uninstall') {
      const opts = parseCommonOptions(args)
      const manifestPath = await resolveManifestPath(args)
      if (args.length) die(`Unknown arguments: ${args.join(' ')}`)
      const res = await uninstall(manifestPath, opts)
      process.stdout.write(JSON.stringify(res, null, 2) + '\n')
      return res.ok ? 0 : 1
    }

    die(`Unknown command: ${cmd}`)
  } catch (e: any) {
    if (e instanceof CliExit) {
      const msg = e.message || 'Command failed'
      process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n')
      return e.exitCode
    }
    throw e
  }
}

// Only run when executed as a script, not when imported (e.g., tests).
const isEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isEntry) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      const msg = err?.stack ? String(err.stack) : String(err)
      process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n')
      process.exit(1)
    },
  )
}


