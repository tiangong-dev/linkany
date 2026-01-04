import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'

vi.mock('../src/api/add.js', () => ({ add: vi.fn() }))
vi.mock('../src/api/install.js', () => ({ install: vi.fn() }))
vi.mock('../src/api/remove.js', () => ({ remove: vi.fn() }))
vi.mock('../src/api/uninstall.js', () => ({ uninstall: vi.fn() }))

import { add } from '../src/api/add.js'
import { install } from '../src/api/install.js'
import { main } from '../src/cli.js'
import { getGlobalConfigPath } from '../src/cli/config.js'

describe('cli default manifest (global)', () => {
  let tmp: string
  let origXdg: string | undefined
  let origCwd: string
  const canon = (p: string) => (p.startsWith('/private/') ? p.slice('/private'.length) : p)

  beforeEach(async () => {
    vi.resetAllMocks()
    origXdg = process.env.XDG_CONFIG_HOME
    origCwd = process.cwd()

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'linkany-test-'))
    process.env.XDG_CONFIG_HOME = tmp
    process.chdir(tmp)

    // Ensure clean slate for config
    const cfgPath = getGlobalConfigPath({ env: process.env, homeDir: tmp })
    await fs.remove(cfgPath)

    vi.mocked(add as any).mockResolvedValue({ result: { ok: true }, manifest: { version: 1, installs: [] } } as any)
    vi.mocked(install as any).mockResolvedValue({ result: { ok: true }, manifest: { version: 1, installs: [] } } as any)
  })

  it('manifest set writes absolute path into XDG config and show prints it', async () => {
    const codeSet = await main(['manifest', 'set', 'm.json'])
    expect(codeSet).toBe(0)

    const cfgPath = getGlobalConfigPath({ env: process.env, homeDir: tmp })
    const cfg = await fs.readJson(cfgPath)
    expect(canon(cfg.manifestPath)).toBe(canon(path.join(tmp, 'm.json')))

    const codeShow = await main(['manifest', 'show'])
    expect(codeShow).toBe(0)
  })

  it('commands use --manifest over default', async () => {
    await main(['manifest', 'set', 'default.json'])
    const code = await main(['install', '--manifest', 'override.json'])
    expect(code).toBe(0)
    expect(install).toHaveBeenCalledTimes(1)
    expect(canon(vi.mocked(install as any).mock.calls[0][0])).toBe(canon(path.join(tmp, 'override.json')))
  })

  it('commands use default when --manifest not provided', async () => {
    await main(['manifest', 'set', 'default.json'])
    const code = await main(['add', '--source', 's', '--target', 't'])
    expect(code).toBe(0)
    expect(add).toHaveBeenCalledTimes(1)
    expect(canon(vi.mocked(add as any).mock.calls[0][0])).toBe(canon(path.join(tmp, 'default.json')))
  })

  it('manifest clear removes config so show fails', async () => {
    await main(['manifest', 'set', 'default.json'])
    const codeClear = await main(['manifest', 'clear'])
    expect(codeClear).toBe(0)

    const codeShow = await main(['manifest', 'show'])
    expect(codeShow).toBe(2)
  })

  it('without default and without --manifest, command fails with non-zero', async () => {
    const code = await main(['install'])
    expect(code).not.toBe(0)
    expect(install).not.toHaveBeenCalled()
  })

  // Restore env/cwd
  afterEach(async () => {
    process.chdir(origCwd)
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = origXdg
    await fs.remove(tmp)
  })
})


