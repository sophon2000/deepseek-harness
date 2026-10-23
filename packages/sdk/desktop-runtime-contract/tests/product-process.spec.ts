import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProductProcess, DesktopProductUncleanExitError } from '../testing/product-process.ts'
import type { DesktopRuntimeProduct } from '../src/desktop-product.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(source: string): Promise<{ root: string; data: string; product: DesktopRuntimeProduct }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-product-process-'))
  temporaryDirectories.push(root)
  const resources = join(root, 'products', 'fixture', 'resources')
  await mkdir(join(resources, 'control'), { recursive: true })
  await writeFile(join(resources, 'control', 'service.mjs'), source)
  return {
    root,
    data: join(root, 'data'),
    product: {
      id: 'fixture', profileBundles: ['fixture'],
      resourcesRoot: 'products/fixture/resources',
      service: { entrypoint: 'control/service.mjs', exportedEnvironment: ['FIXTURE_URL'] },
    },
  }
}

describe('Desktop product process', () => {
  it('accepts the exact declared environment and shuts down cooperatively', async () => {
    const setup = await fixture(`
      if (process.env.ELECTRON_RUN_AS_NODE !== '1') process.exit(41)
      process.send({ type: 'ready', environment: { FIXTURE_URL: 'http://127.0.0.1:1234' } })
      process.on('message', message => { if (message?.type === 'shutdown') process.exit(0) })
      setInterval(() => {}, 1000)
    `)
    const processHandle = new DesktopProductProcess(
      process.execPath, setup.root, setup.product, setup.data, { NODE_OPTIONS: '--bad', SAFE: 'yes' },
    )
    await expect(processHandle.start()).resolves.toEqual({ environment: { FIXTURE_URL: 'http://127.0.0.1:1234' } })
    await expect(processHandle.stop(true)).resolves.toBeUndefined()
  })

  it.each([false, true])('cleans up an unsuccessful exit and refuses it only for update handoff: %s', async (requireGraceful) => {
    const setup = await fixture(`
      process.send({ type: 'ready', environment: { FIXTURE_URL: 'ok' } })
      process.on('message', message => { if (message?.type === 'shutdown') process.exit(17) })
      setInterval(() => {}, 1000)
    `)
    const processHandle = new DesktopProductProcess(process.execPath, setup.root, setup.product, setup.data)
    await processHandle.start()
    if (requireGraceful) await expect(processHandle.stop(true)).rejects.toBeInstanceOf(DesktopProductUncleanExitError)
    else await expect(processHandle.stop()).resolves.toBeUndefined()
    // A later update check cannot reinterpret an already completed unsuccessful stop as clean.
    await expect(processHandle.stop(true)).rejects.toThrow('exit 17')
  })

  it('refuses update handoff when the product required termination even if its TERM handler exits zero', async () => {
    const setup = await fixture(`
      process.on('message', () => {})
      process.on('SIGTERM', () => process.exit(0))
      process.send({ type: 'ready', environment: { FIXTURE_URL: 'ok' } })
      setInterval(() => {}, 1000)
    `)
    const processHandle = new DesktopProductProcess(process.execPath, setup.root, setup.product, setup.data)
    await processHandle.start()
    await expect(processHandle.stop(true)).rejects.toThrow('forced termination true')
    await expect(processHandle.stop()).resolves.toBeUndefined()
  }, 20_000)

  it('rejects undeclared environment returned over IPC', async () => {
    const setup = await fixture(`
      process.send({ type: 'ready', environment: { FIXTURE_URL: 'ok', EXTRA: 'no' } })
      setInterval(() => {}, 1000)
    `)
    const processHandle = new DesktopProductProcess(process.execPath, setup.root, setup.product, setup.data)
    await expect(processHandle.start()).rejects.toThrow('invalid IPC event')
    await processHandle.stop()
  })

  it('terminates a product service that never reports ready', async () => {
    const setup = await fixture('setInterval(() => {}, 1000)')
    const processHandle = new DesktopProductProcess(
      process.execPath, setup.root, setup.product, setup.data, process.env, undefined, 50,
    )
    await expect(processHandle.start()).rejects.toThrow('did not become ready within 50 ms')
    await expect(processHandle.stop()).resolves.toBeUndefined()
  })

  it('cancels startup before spawning while the data directory is being prepared', async () => {
    const setup = await fixture('process.exit(42)')
    const processHandle = new DesktopProductProcess(process.execPath, setup.root, setup.product, setup.data)
    const starting = expect(processHandle.start()).rejects.toThrow('startup was cancelled')
    await processHandle.stop()
    await starting
    await expect(processHandle.start()).rejects.toThrow('service is stopped')
  })

  it('settles pending readiness when stopped and shares child teardown', async () => {
    const setup = await fixture(`
      import { writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      process.on('message', message => { if (message?.type === 'shutdown') process.exit(0) })
      writeFileSync(join(process.argv.at(-1), 'started'), '')
      setInterval(() => {}, 1000)
    `)
    const failure = vi.fn()
    const processHandle = new DesktopProductProcess(process.execPath, setup.root, setup.product, setup.data, {}, failure)
    const starting = expect(processHandle.start()).rejects.toThrow('startup was cancelled')
    await vi.waitFor(() => { expect(existsSync(join(setup.data, 'started'))).toBe(true) })
    const stopping = processHandle.stop()
    expect(processHandle.stop()).toBe(stopping)
    await stopping
    await starting
    expect(failure).not.toHaveBeenCalled()
  })
})
