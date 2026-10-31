/** Exported SDK preparation isolates its build and caches from producer environment overrides. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('SDK preparation ignores producer storage overrides without touching their directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-sdk-prepare-'))
  try {
    const sdk = join(root, 'sdk')
    const product = join(root, 'product')
    const output = join(root, 'prepared')
    const scripts = join(sdk, 'apps/desktop/scripts')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(product)
    copyFileSync(new URL('../scripts/sdk/prepare.mjs', import.meta.url), join(sdk, 'prepare.mjs'))
    writeFileSync(join(sdk, 'package.json'), '{"type":"module"}')
    writeFileSync(join(sdk, 'dsh-desktop-sdk.json'), JSON.stringify({
      schemaVersion: 'dsh.desktop-sdk/2', version: 'fixture',
      target: { platform: process.platform, arch: process.arch }, layout: { app: 'apps/desktop' },
    }))
    writeFileSync(join(product, 'desktop-product.json'), '{}')
    const storageKeys = ['DSH_DESKTOP_BUILD_ROOT', 'DSH_DESKTOP_DOWNLOAD_CACHE', 'DSH_DESKTOP_PNPM_STORE_ROOT']
    const overrides = Object.fromEntries(storageKeys.map((key, index) => {
      const directory = join(root, `producer-${index}`)
      mkdirSync(directory)
      writeFileSync(join(directory, 'sentinel'), 'untouched')
      return [key, directory]
    }))
    for (const script of ['prepare-package-set.js', 'prepare-dsh.js']) {
      writeFileSync(join(scripts, script), `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const keys = ${JSON.stringify(storageKeys)}
for (const key of keys) {
  if (process.env[key] !== undefined) writeFileSync(join(process.env[key], 'sentinel'), 'redirected')
}
writeFileSync(${JSON.stringify(script + '.json')}, JSON.stringify({
  overrides: keys.filter(key => process.env[key] !== undefined),
  lock: process.env.DSH_DESKTOP_RUNTIME_LOCK,
  lockOutput: process.env.DSH_DESKTOP_RUNTIME_LOCK_OUTPUT,
  product: process.env.DSH_DESKTOP_PRODUCT_ROOT,
}))
`)
    }
    const lock = join(root, 'selected-lock.yaml')
    writeFileSync(lock, 'lockfileVersion: 9.0\n')
    const result = spawnSync(process.execPath, [join(sdk, 'prepare.mjs'), '--product', product,
      '--output', output, '--app-id', 'fixture.sdk', '--runtime-lock', lock], {
      env: { ...process.env, ...overrides, DSH_DESKTOP_RUNTIME_LOCK: join(root, 'unselected-lock.yaml') },
      encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    for (const directory of Object.values(overrides)) assert.equal(readFileSync(join(directory, 'sentinel'), 'utf8'), 'untouched')
    for (const script of ['prepare-package-set.js', 'prepare-dsh.js']) {
      assert.deepEqual(JSON.parse(readFileSync(join(output, script + '.json'), 'utf8')), {
        overrides: [], lock, lockOutput: join(output, 'runtime-pnpm-lock.yaml'), product,
      })
    }
    assert.equal(JSON.parse(readFileSync(join(output, 'desktop-preparation.json'), 'utf8')).version, 'fixture')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
