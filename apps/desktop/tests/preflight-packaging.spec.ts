import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { verifyPackagedDesktopRuntime } from '../scripts/verify-packaged-runtime.mjs'

it('refuses a package missing its declared resource preflight entrypoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-preflight-package-'))
  const runtime = join(root, 'dsh')
  const host = join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib')
  const control = join(runtime, 'products/product/resources/control')
  try {
    mkdirSync(host, { recursive: true }); mkdirSync(control, { recursive: true })
    for (const file of ['index.js', 'cli.js']) writeFileSync(join(host, file), '')
    writeFileSync(join(runtime, 'desktop-runtime.json'), JSON.stringify({
      product: { resourcesRoot: 'products/product/resources', preflight: { entrypoint: 'control/prepare.mjs' } },
    }))
    const context = { appOutDir: root, packager: { getResourcesDir: () => root } }
    expect(() => { verifyPackagedDesktopRuntime(context) }).toThrow('entrypoint')
    writeFileSync(join(control, 'prepare.mjs'), '')
    expect(() => { verifyPackagedDesktopRuntime(context) }).not.toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
