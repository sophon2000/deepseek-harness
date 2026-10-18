import { mkdtempSync, readFile, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { verifyDesktopRuntime, writeDesktopRuntimeAsync } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFile: vi.fn(),
}))

it.each(['verification', 'sealing'] as const)('drains outstanding reads before rejecting and stops scheduling after a read failure: %s', async (operation) => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-runtime-read-failure-'))
  const pending: ((error?: Error) => void)[] = []
  vi.mocked(readFile).mockImplementation((...args: unknown[]) => {
    const path = args[0]
    const callback = args.at(-1)
    if (typeof path !== 'string' || typeof callback !== 'function') throw new Error('unexpected readFile arguments')
    const complete = callback as (error: Error | null, body: Buffer | undefined) => void
    pending.push((error) => { complete(error ?? null, error === undefined ? readFileSync(path) : undefined) })
  })
  let outcome: Promise<unknown> | undefined
  try {
    const fixture = runtimeFixture(root)
    const original = readFileSync(join(root, 'desktop-runtime.json'), 'utf8')
    let settled = false
    outcome = (operation === 'verification'
      ? verifyDesktopRuntime(root, '1.0.0')
      : writeDesktopRuntimeAsync(root, fixture.release, fixture.sharedPackages.map(item => item.name)))
      .finally(() => { settled = true }).catch((error: unknown) => error)
    const inFlight = pending.length
    expect(inFlight).toBeGreaterThan(1)
    const failure = new Error('runtime read failed')
    pending.shift()!(failure)
    try {
      // Pending callbacks keep the reads open across a complete event-loop turn.
      await setImmediate()
      expect(settled).toBe(false)
      expect(pending).toHaveLength(inFlight - 1)
    } finally {
      for (const complete of pending.splice(0)) complete()
    }
    expect(await outcome).toBe(failure)
    expect(pending).toHaveLength(0)
    expect(readFileSync(join(root, 'desktop-runtime.json'), 'utf8')).toBe(original)
  } finally {
    for (const complete of pending.splice(0)) complete(new Error('test cleanup'))
    await outcome
    vi.mocked(readFile).mockReset()
    rmSync(root, { recursive: true, force: true })
  }
})
