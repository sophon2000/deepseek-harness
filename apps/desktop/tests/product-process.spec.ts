import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopProductProcess } from '../src/product-process.ts'
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
      id: 'fixture', profileBundles: ['fixture'], systemPresetRoots: [],
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
    await expect(processHandle.stop()).resolves.toBeUndefined()
  })

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
})
