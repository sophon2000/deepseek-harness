import { describe, expect, it, vi, type TestContext } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DesktopProductHostProcess } from '../src/product-host-process.ts'
import { DesktopProductProcess } from '../src/product-process.ts'

function backend(test: TestContext) {
  test.onTestFinished(() => { vi.restoreAllMocks() })
  vi.spyOn(DesktopHostProcess.prototype, 'start').mockResolvedValue({ url: 'http://127.0.0.1:1234' })
  vi.spyOn(DesktopProductProcess.prototype, 'start').mockResolvedValue({ environment: {} })
  const hostStop = vi.spyOn(DesktopHostProcess.prototype, 'stop').mockResolvedValue(undefined)
  const productStop = vi.spyOn(DesktopProductProcess.prototype, 'stop').mockResolvedValue(undefined)
  const process = new DesktopProductHostProcess('node', 'runtime', 'product-runtime', 'project', 'data', {
    id: 'fixture', profileBundles: [], resourcesRoot: 'resources',
    service: { entrypoint: 'service.mjs', exportedEnvironment: [] },
  })
  return { process, hostStop, productStop }
}

describe('Desktop product backend cleanup failures', () => {
  it('resolves with no failures and clears both stopped processes', async (test) => {
    const fixture = backend(test)
    await fixture.process.start()
    await expect(fixture.process.stop()).resolves.toBeUndefined()
    await expect(fixture.process.stop()).resolves.toBeUndefined()
    expect(fixture.hostStop).toHaveBeenCalledExactlyOnceWith(false)
    expect(fixture.productStop).toHaveBeenCalledExactlyOnceWith()
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
    await expect(fixture.process.stop()).resolves.toBeUndefined()
  })

  it('preserves the single product Error after successful Host cleanup', async (test) => {
    const fixture = backend(test)
    const failure = new Error('product cleanup failed')
    fixture.productStop.mockRejectedValue(failure)
    await fixture.process.start()
    await expect(fixture.process.stop()).rejects.toBe(failure)
    expect(fixture.hostStop).toHaveBeenCalledOnce()
    await expect(fixture.process.stop()).resolves.toBeUndefined()
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
    await expect(fixture.process.stop()).resolves.toBeUndefined()
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
  })
})
