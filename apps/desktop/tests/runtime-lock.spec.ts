import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { preserveDesktopRuntimeLock, selectDesktopRuntimeLock } from '../scripts/runtime-lock.ts'

it('uses supplied lock bytes without resolving public dependency ranges again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-frozen-lock-'))
  try {
    const input = join(root, 'fixed.yaml')
    writeFileSync(input, 'lockfileVersion: 9.0\n# qualified bytes\n')
    const resolve = vi.fn(async () => {})
    await selectDesktopRuntimeLock(root, input, resolve)
    expect(resolve).not.toHaveBeenCalled()
    expect(readFileSync(join(root, 'pnpm-lock.yaml'))).toEqual(readFileSync(input))
    const output = join(root, 'result', 'runtime-pnpm-lock.yaml')
    preserveDesktopRuntimeLock(root, output)
    expect(readFileSync(output)).toEqual(readFileSync(input))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('resolves only explicit discovery and stops on a missing supplied lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-resolve-lock-'))
  try {
    const resolve = vi.fn(async () => { writeFileSync(join(root, 'pnpm-lock.yaml'), 'discovered\n') })
    await selectDesktopRuntimeLock(root, undefined, resolve)
    expect(resolve).toHaveBeenCalledTimes(1)
    await expect(selectDesktopRuntimeLock(root, join(root, 'missing'), resolve)).rejects.toThrow()
    expect(resolve).toHaveBeenCalledTimes(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
