/** Linux SDK verification selects explicit resources and never invokes macOS metadata tools. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('Linux verification selects prepared Electron or an explicitly named packaged executable', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-sdk-verify-'))
  try {
    const scripts = join(root, 'apps/desktop/scripts')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(join(root, 'apps/desktop/src'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    copyFileSync(new URL('../scripts/sdk/verify.mjs', import.meta.url), join(root, 'verify.mjs'))
    writeFileSync(join(root, 'dsh-desktop-sdk.json'), JSON.stringify({
      schemaVersion: 'dsh.desktop-sdk/2', version: 'fixture', target: { platform: 'linux', arch: process.arch },
      layout: { build: 'build' },
    }))
    writeFileSync(join(root, 'apps/desktop/src/runtime-tree.js'), 'export async function verifyDesktopRuntime(path, version, target) { return { path, version, target } }')
    writeFileSync(join(scripts, 'smoke-prepared-runtime.js'), `import { writeFileSync } from 'node:fs'; export async function smokePreparedRuntime(...args) { writeFileSync(${JSON.stringify(join(root, 'observed.json'))}, JSON.stringify(args)) }`)
    const run = args => spawnSync(process.execPath, [join(root, 'verify.mjs'), '--prepared', root, ...args], { encoding: 'utf8', timeout: 30_000 })
    let result = run([])
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'observed.json'), 'utf8')).slice(0, 3), [join(root, 'build/dsh'), join(root, 'build/electron/electron'), join(root, 'build/runtime')])
    const app = join(root, 'linux-unpacked')
    for (const executable of [undefined, '../outside', '/outside']) {
      result = run(['--app', app, ...(executable === undefined ? [] : ['--executable', executable])])
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /requires --executable/u)
    }
    result = run(['--app', app, '--executable', 'video-harness'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'observed.json'), 'utf8')).slice(0, 3), [join(app, 'resources/dsh'), join(app, 'video-harness'), join(app, 'resources/runtime')])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
