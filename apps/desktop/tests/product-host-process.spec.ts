import { describe, expect, it, vi, type TestContext } from 'vitest'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDesktopRuntimeProduct } from '../src/desktop-product.ts'
import { DesktopHostProcess, DesktopHostUncleanExitError } from '../src/host-process.ts'
import { DesktopProductHostProcess, isDesktopBackendUncleanExit } from '../src/product-host-process.ts'
import { DesktopProductProcess, DesktopProductUncleanExitError } from '../src/product-process.ts'

function backend(test: TestContext) {
  test.onTestFinished(() => { vi.restoreAllMocks() })
  const hostStart = vi.spyOn(DesktopHostProcess.prototype, 'start').mockResolvedValue({ url: 'http://127.0.0.1:1234' })
  const productStart = vi.spyOn(DesktopProductProcess.prototype, 'start').mockResolvedValue({ environment: {} })
  const hostStop = vi.spyOn(DesktopHostProcess.prototype, 'stop').mockResolvedValue(undefined)
  const productStop = vi.spyOn(DesktopProductProcess.prototype, 'stop').mockResolvedValue(undefined)
  const process = new DesktopProductHostProcess('node', 'runtime', 'product-runtime', 'project', 'data', {
    id: 'fixture', profileBundles: [], resourcesRoot: 'resources',
    service: { entrypoint: 'service.mjs', exportedEnvironment: [] },
  })
  return { process, hostStart, productStart, hostStop, productStop }
}

describe('Desktop product backend cleanup failures', () => {
  it.for([
    { readyTimeoutMs: 90_000, outcome: 'ready' },
    { readyTimeoutMs: 120_000, outcome: 'ready' },
    { readyTimeoutMs: 90_000, outcome: 'timeout' },
    { readyTimeoutMs: 90_000, outcome: 'cancel' },
    { readyTimeoutMs: undefined, outcome: 'timeout' },
  ] as const)('enforces service budget $readyTimeoutMs and $outcome before starting the Host', async ({ readyTimeoutMs, outcome }, test) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-product-budget-'))
    const owned: { handle?: DesktopProductHostProcess; watcher?: FSWatcher; settled?: Promise<unknown> } = {}
    test.onTestFinished(async () => {
      owned.watcher?.close()
      vi.useRealTimers()
      try { await owned.handle?.stop(); await owned.settled }
      finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) }
    })
    const resources = join(root, 'resources'), data = join(root, 'data', 'fixture')
    await mkdir(resources); await mkdir(data, { recursive: true })
    await writeFile(join(resources, 'service.mjs'), `
      import { existsSync, watch, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      const release = join(process.cwd(), 'release')
      const watcher = watch(process.cwd(), () => {
        if (!existsSync(release)) return
        watcher.close()
        process.send({ type: 'ready', environment: { FIXTURE_URL: 'fixture' } })
      })
      process.on('message', message => {
        if (message?.type === 'shutdown') { watcher.close(); process.disconnect() }
      })
      writeFileSync(join(process.cwd(), 'started'), '')
    `)
    const dataWatcher = watch(data)
    owned.watcher = dataWatcher
    const started = new Promise<void>((resolve, reject) => {
      dataWatcher.on('change', () => { if (existsSync(join(data, 'started'))) resolve() })
      dataWatcher.once('error', reject)
    })
    const product = parseDesktopRuntimeProduct({
      id: 'fixture', profileBundles: ['fixture'], resourcesRoot: 'resources',
      service: { entrypoint: 'service.mjs', exportedEnvironment: ['FIXTURE_URL'], readyTimeoutMs },
    })
    const hostStart = vi.spyOn(DesktopHostProcess.prototype, 'start').mockResolvedValue({ url: 'http://127.0.0.1:1234' })
    vi.spyOn(DesktopHostProcess.prototype, 'stop').mockResolvedValue(undefined)
    const failed = vi.fn()
    const handle = new DesktopProductHostProcess(process.execPath, root, root, root, join(root, 'data'), product,
      undefined, process.env, failed)
    owned.handle = handle
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const settled = handle.start().then(value => ({ ready: value }), (error: unknown) => ({ error }))
    owned.settled = settled
    await started
    await vi.advanceTimersByTimeAsync((readyTimeoutMs ?? 30_000) - 1)
    expect(failed).not.toHaveBeenCalled()
    expect(hostStart).not.toHaveBeenCalled()
    if (outcome === 'timeout') {
      await vi.advanceTimersByTimeAsync(1)
      await expect(settled).resolves.toMatchObject({ error: {
        message: `desktop product service did not become ready within ${readyTimeoutMs ?? 30_000} ms`,
      } })
      expect(failed).toHaveBeenCalledOnce()
      expect(hostStart).not.toHaveBeenCalled()
      return
    }
    if (outcome === 'cancel') {
      await handle.stop(true)
      await expect(settled).resolves.toMatchObject({ error: { message: 'desktop product service startup was cancelled' } })
      await vi.advanceTimersByTimeAsync(1)
      expect(failed).not.toHaveBeenCalled()
      expect(hostStart).not.toHaveBeenCalled()
      return
    }
    await writeFile(join(data, 'release'), '')
    await expect(settled).resolves.toEqual({ ready: { url: 'http://127.0.0.1:1234' } })
    await expect(handle.stop(true)).resolves.toBeUndefined()
  })

  it('resolves with no failures and clears both stopped processes', async (test) => {
    const fixture = backend(test)
    await fixture.process.start()
    await expect(fixture.process.stop()).resolves.toBeUndefined()
    await expect(fixture.process.stop()).resolves.toBeUndefined()
    expect(fixture.hostStop).toHaveBeenCalledExactlyOnceWith(false)
    expect(fixture.productStop).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('preserves the single Host Error and still stops the product before rejecting', async (test) => {
    const fixture = backend(test)
    const failure = new Error('Host cleanup failed')
    const stopped: string[] = []
    fixture.hostStop.mockImplementation(async () => { stopped.push('host'); throw failure })
    fixture.productStop.mockImplementation(async () => { stopped.push('product') })
    await fixture.process.start()
    await expect(fixture.process.stop(true)).rejects.toBe(failure)
    expect(stopped).toEqual(['host', 'product'])
    expect(fixture.hostStop).toHaveBeenCalledExactlyOnceWith(true)
    expect(fixture.productStop).toHaveBeenCalledExactlyOnceWith(true)
    await expect(fixture.process.stop()).rejects.toBe(failure)
  })

  it('classifies only confirmed unsuccessful exits as recoverable update failures', () => {
    const host = new DesktopHostUncleanExitError('host exited')
    const product = new DesktopProductUncleanExitError('product exited')
    expect(isDesktopBackendUncleanExit(host)).toBe(true)
    expect(isDesktopBackendUncleanExit(product)).toBe(true)
    expect(isDesktopBackendUncleanExit(new AggregateError([host, product]))).toBe(true)
    expect(isDesktopBackendUncleanExit(new AggregateError([host, new Error('product did not exit')]))).toBe(false)
    expect(isDesktopBackendUncleanExit(new AggregateError([]))).toBe(false)
  })

  it('preserves the single product Error after successful Host cleanup', async (test) => {
    const fixture = backend(test)
    const failure = new Error('product cleanup failed')
    fixture.productStop.mockRejectedValue(failure)
    await fixture.process.start()
    await expect(fixture.process.stop()).rejects.toBe(failure)
    expect(fixture.hostStop).toHaveBeenCalledOnce()
    await expect(fixture.process.stop()).rejects.toBe(failure)
  })

  it('aggregates both original Errors in Host then product order', async (test) => {
    const fixture = backend(test)
    const hostFailure = new Error('Host cleanup failed')
    const productFailure = new Error('product cleanup failed')
    fixture.hostStop.mockRejectedValue(hostFailure)
    fixture.productStop.mockRejectedValue(productFailure)
    await fixture.process.start()
    const failure: unknown = await fixture.process.stop().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregated cleanup failures')
    expect(failure.message).toBe('desktop product backend cleanup failed')
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0]).toBe(hostFailure)
    expect(failure.errors[1]).toBe(productFailure)
    await expect(fixture.process.stop()).rejects.toBe(failure)
  })

  it('normalizes a single non-Error rejection without wrapping an existing Error', async (test) => {
    const fixture = backend(test)
    fixture.hostStop.mockRejectedValue('plain failure')
    await fixture.process.start()
    await expect(fixture.process.stop()).rejects.toEqual(new Error('plain failure'))
  })

  it('resolves before startup without invoking either child cleanup', async (test) => {
    const fixture = backend(test)
    await expect(fixture.process.stop()).resolves.toBeUndefined()
    expect(fixture.hostStop).not.toHaveBeenCalled()
    expect(fixture.productStop).not.toHaveBeenCalled()
    await expect(fixture.process.start()).rejects.toThrow('backend is stopped')
  })

  it('does not start the Host when stopped during product readiness', async (test) => {
    const fixture = backend(test)
    let ready!: () => void
    fixture.productStart.mockReturnValue(new Promise((resolve) => {
      ready = () => { resolve({ environment: {} }) }
    }))
    const starting = expect(fixture.process.start()).rejects.toThrow('startup was cancelled')
    const stopping = fixture.process.stop()
    expect(fixture.process.stop()).toBe(stopping)
    ready()
    await stopping
    await starting
    expect(fixture.hostStart).not.toHaveBeenCalled()
    expect(fixture.productStop).toHaveBeenCalledOnce()
  })

  it('retains startup and cleanup failures together', async (test) => {
    const fixture = backend(test)
    const startup = new Error('product startup failed')
    const cleanup = new Error('product cleanup failed')
    fixture.productStart.mockRejectedValue(startup)
    fixture.productStop.mockRejectedValue(cleanup)
    const failure: unknown = await fixture.process.start().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected combined startup and cleanup failures')
    expect(failure.errors).toEqual([startup, cleanup])
  })
})
