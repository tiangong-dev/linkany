import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs-extra'

import { add } from '../src/api/add.js'
import { remove } from '../src/api/remove.js'

vi.mock('fs-extra')

describe('in-memory manifest APIs', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any)
    vi.mocked(fs.appendFile).mockResolvedValue(undefined as any)
    vi.mocked(fs.writeFile).mockResolvedValue(undefined as any)
    vi.mocked(fs.rename).mockResolvedValue(undefined as any)
    vi.mocked(fs.pathExists).mockResolvedValue(false as any)
    vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false } as any)
  })

  it('in-memory add upserts entry without writing manifest file', async () => {
    const manifest = { version: 1, installs: [] as any[] }

    // No filesystem writes should happen when dryRun=true (applyPlan skips ops).
    const { result, manifest: updated } = await add(
      manifest,
      { source: 's', target: 't' },
      { baseDir: '/', dryRun: true },
    )

    expect(result.operation).toBe('add')
    expect(updated.installs.length).toBe(1)
    expect(updated.installs[0].source).toBe('s')
    expect(updated.installs[0].target).toBe('t')

    // Manifest file IO should not occur in in-memory API.
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('in-memory remove removes entry without writing manifest file', async () => {
    const manifest = { version: 1, installs: [{ source: 's', target: 't' }] }
    vi.mocked(fs.pathExists).mockResolvedValue(true as any)
    vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => true } as any)
    vi.mocked(fs.readlink).mockResolvedValue('/s' as any)

    const { result, manifest: updated } = await remove(manifest, 't', {
      baseDir: '/',
      dryRun: true,
      keepLink: true,
    })

    expect(result.operation).toBe('remove')
    expect(result.ok).toBe(true)
    expect(updated.installs.length).toBe(0)

    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(fs.rename).not.toHaveBeenCalled()
  })
})


