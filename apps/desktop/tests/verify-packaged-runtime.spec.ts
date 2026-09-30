import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { verifyPackagedDesktopRuntime } from '../scripts/verify-packaged-runtime.mjs'

function fixture(): { root: string; context: Parameters<typeof verifyPackagedDesktopRuntime>[0] } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packaged-runtime-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const runtime = join(root, 'resources', 'dsh')
  const host = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib')
  const service = join(runtime, 'products', 'fixture', 'resources', 'control')
  mkdirSync(host, { recursive: true })
  mkdirSync(service, { recursive: true })
  writeFileSync(join(host, 'index.js'), '')
  writeFileSync(join(host, 'cli.js'), '')
  writeFileSync(join(service, 'service.mjs'), '')
  writeFileSync(join(runtime, 'desktop-runtime.json'), JSON.stringify({
    product: {
      resourcesRoot: 'products/fixture/resources',
      service: { entrypoint: 'control/service.mjs' },
    },
  }))
  return {
    root,
    context: { appOutDir: root, packager: { getResourcesDir: directory => join(directory, 'resources') } },
  }
}

describe('packaged Desktop runtime verification', () => {
  it('accepts the official Desktop runtime without a product service', () => {
    const { root, context } = fixture()
    writeFileSync(join(root, 'resources', 'dsh', 'desktop-runtime.json'), JSON.stringify({ schemaVersion: 1 }))
    expect(() => { verifyPackagedDesktopRuntime(context) }).not.toThrow()
  })

  it('accepts complete Host and product child-process entrypoints', () => {
    const { context } = fixture()
    expect(() => { verifyPackagedDesktopRuntime(context) }).not.toThrow()
  })

  it.each(['index.js', 'cli.js'])('rejects a missing Host entrypoint %s', (file) => {
    const { root, context } = fixture()
    rmSync(join(root, 'resources', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', file))
    expect(() => { verifyPackagedDesktopRuntime(context) }).toThrow(/missing child-process entrypoint/u)
  })

  it('rejects a product service left inside ASAR', () => {
    const { root, context } = fixture()
    writeFileSync(join(root, 'resources', 'dsh', 'desktop-runtime.json'), JSON.stringify({
      product: {
        resourcesRoot: 'products/fixture/resources',
        service: { entrypoint: 'control/missing.mjs' },
      },
    }))
    expect(() => { verifyPackagedDesktopRuntime(context) }).toThrow(/missing child-process entrypoint/u)
  })
})
