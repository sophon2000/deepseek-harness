import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { runtimeFixture } from './runtime-fixture.ts'

it('uses the product-declared readiness budget during actual runtime smoke', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-product-smoke-budget-'))
  try {
    const resources = join(root, 'products', 'fixture', 'resources')
    mkdirSync(resources, { recursive: true })
    // Without the declared budget this child exits later with a different failure.
    writeFileSync(join(resources, 'service.mjs'), 'setTimeout(() => process.exit(17), 500)\n')
    const runtime = runtimeFixture(root, '1.0.0', process.versions.node, {
      id: 'fixture', profileBundles: ['fixture'], resourcesRoot: 'products/fixture/resources',
      service: { entrypoint: 'service.mjs', exportedEnvironment: ['FIXTURE_URL'], readyTimeoutMs: 50 },
    })
    await expect(smokeDesktopRuntime(root, process.execPath, runtime, {}, join(root, 'runtime')))
      .rejects.toThrow('did not become ready within 50 ms')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
