import { describe, expect, it } from 'vitest'
import { existsSync, watch } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopProductHostProcess } from '../src/product-host-process.ts'
import type { DesktopRuntimeProduct } from '../src/desktop-product.ts'

async function fixture(module: string, readyTimeoutMs?: number) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-product-preflight-'))
  const resources = join(root, 'resources')
  const host = join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/lib')
  await mkdir(resources); await mkdir(host, { recursive: true })
  await writeFile(join(resources, 'prepare.mjs'), module)
  await writeFile(join(host, 'index.js'), `
    const fs = require('node:fs'), path = require('node:path')
    fs.writeFileSync(path.join(process.argv[3], 'host-environment.json'),
      JSON.stringify({ value: process.env.FIXTURE_RESOURCE }))
    process.on('message', message => {
      if (message?.type !== 'shutdown') return
      process.send({ type: 'shutdown-complete' }, () => process.disconnect())
    })
    process.send({ type: 'ready', url: 'http://127.0.0.1:9/synthetic-no-listener' })
  `)
  const product: DesktopRuntimeProduct = {
    id: 'fixture', profileBundles: ['fixture'], resourcesRoot: 'resources',
    preflight: { entrypoint: 'prepare.mjs', exportedEnvironment: ['FIXTURE_RESOURCE'], ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }) },
  }
  const environment = { ...process.env, FIXTURE_RESOURCE: 'unqualified' }
  const handle = new DesktopProductHostProcess(process.execPath, root, root, root,
    join(root, 'data'), product, undefined, environment)
  return { root, resources, product, environment, handle }
}

describe('Desktop resource preflight before Host creation', () => {
  it('starts the Host only with qualified launch facts and leaves the parent environment intact', async () => {
    const f = await fixture(`
      const runtimeRoot = process.argv[process.argv.indexOf('--runtime-root') + 1]
      process.send({ type: 'ready', environment: { FIXTURE_RESOURCE: runtimeRoot } }, () => process.disconnect())
    `)
    try {
      await expect(f.handle.start()).resolves.toMatchObject({ url: 'http://127.0.0.1:9/synthetic-no-listener' })
      expect(JSON.parse(await readFile(join(f.root, 'host-environment.json'), 'utf8'))).toEqual({ value: f.resources })
      expect(f.environment.FIXTURE_RESOURCE).toBe('unqualified')
      await expect(f.handle.stop(true)).resolves.toBeUndefined()
    } finally {
      await f.handle.stop()
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it.each([
    'throw new Error("resource missing")',
    'process.send({ type: "ready", environment: { FIXTURE_RESOURCE: "ok", EXTRA: "forged" } })',
    'process.send({ type: "ready", environment: { FIXTURE_RESOURCE: "" } })',
    'process.disconnect()',
    'process.send({ type: "ready", environment: { FIXTURE_RESOURCE: "qualified" } }, () => { process.exitCode = 7; process.disconnect() })',
    'process.send({ type: "ready", environment: { FIXTURE_RESOURCE: "qualified" } }, () => process.kill(process.pid, "SIGTERM"))',
    'process.send({ type: "ready", environment: { FIXTURE_RESOURCE: "qualified" } }); process.send({ type: "ready", environment: { FIXTURE_RESOURCE: "qualified" } })',
  ])('rejects failed or invalid preparation before a Host is created: %s', async (module) => {
    const f = await fixture(module)
    try {
      await expect(f.handle.start()).rejects.toThrow()
      expect(existsSync(join(f.root, 'host-environment.json'))).toBe(false)
    } finally {
      await f.handle.stop()
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('keeps the deadline active after ready until the preflight has closed', async () => {
    const f = await fixture(`
      process.send({ type: 'ready', environment: { FIXTURE_RESOURCE: 'qualified' } })
      setInterval(() => {}, 1000)
    `, 500)
    try {
      await expect(f.handle.start()).rejects.toThrow('within 500 ms')
      expect(existsSync(join(f.root, 'host-environment.json'))).toBe(false)
    } finally {
      await f.handle.stop()
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('cancels and awaits a checking child before returning from stop, without starting the Host', async () => {
    const f = await fixture(`
      import { execFile } from 'node:child_process'
      import { writeFile } from 'node:fs/promises'
      import { join } from 'node:path'
      const runtimeRoot = process.argv[process.argv.indexOf('--runtime-root') + 1]
      const abort = new AbortController()
      const child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: abort.signal })
      child.on('error', error => { if (error.name !== 'AbortError') throw error })
      const closed = new Promise(resolve => child.once('close', resolve))
      process.on('message', message => { if (message?.type === 'shutdown') abort.abort() })
      await writeFile(join(runtimeRoot, 'checking.pid'), String(child.pid))
      await closed
      await writeFile(join(runtimeRoot, 'checking.closed'), '')
      process.disconnect()
    `)
    const watcher = watch(f.resources)
    const started = new Promise<void>((resolve, reject) => {
      watcher.on('change', () => { if (existsSync(join(f.resources, 'checking.pid'))) resolve() })
      watcher.once('error', reject)
    })
    const settled = f.handle.start().then(value => ({ ready: value }), (error: unknown) => ({ error }))
    try {
      await Promise.race([started, settled.then(() => { throw new Error('Host started before resource preparation') })])
      await f.handle.stop(true)
      expect(await settled).toHaveProperty('error')
      expect(existsSync(join(f.resources, 'checking.closed'))).toBe(true)
      expect(existsSync(join(f.root, 'host-environment.json'))).toBe(false)
      const pid = Number(await readFile(join(f.resources, 'checking.pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      watcher.close()
      await f.handle.stop()
      await settled
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
