import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { verifyDesktopRuntime, writeDesktopRuntime, writeDesktopRuntimeAsync } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

it('seals asynchronously to the exact synchronous descriptor bytes and detects later changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-runtime-async-seal-'))
  try {
    const fixture = runtimeFixture(root)
    writeFileSync(join(root, 'payload.bin'), Buffer.from([0, 255, 1, 128]), { mode: 0o755 })
    const names = fixture.sharedPackages.map(item => item.name)
    const expected = writeDesktopRuntime(root, fixture.release, names)
    const bytes = readFileSync(join(root, 'desktop-runtime.json'), 'utf8')
    expect(await writeDesktopRuntimeAsync(root, fixture.release, names)).toEqual(expected)
    expect(readFileSync(join(root, 'desktop-runtime.json'), 'utf8')).toBe(bytes)
    await expect(verifyDesktopRuntime(root, fixture.release.version)).resolves.toEqual(expected)
    writeFileSync(join(root, 'payload.bin'), Buffer.from([0, 255, 1, 129]))
    await expect(verifyDesktopRuntime(root, fixture.release.version)).rejects.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
