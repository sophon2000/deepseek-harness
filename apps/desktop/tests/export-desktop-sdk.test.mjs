/** Source-independent tooling checks for the Desktop SDK exporter. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertRuntimeSdkLayout, compileDesktopSdkModule, desktopSdkPackageDirectory, desktopSdkDeclarationDependency } from '../scripts/export-desktop-sdk.mjs'

test('compiled tooling uses executable local imports and the packed runtime API', () => {
  const result = compileDesktopSdkModule(`
import { value } from './helper.ts'
import { parsePrimaryRuntime } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
export const read = (value: unknown) => parsePrimaryRuntime(value)
export const other = value
`, 'fixture.ts')
  assert.match(result, /helper\.js/u)
  assert.match(result, /@deepseek-ai\/dsh-tool-workspace-dependencies/u)
  assert.doesNotMatch(result, /packages\/skill|: unknown|helper\.ts/u)
})

test('dependency export resolves the owning package version and rejects missing inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-sdk-resolution-'))
  try {
    for (const directory of ['node_modules/example', 'nested/node_modules/example']) {
      mkdirSync(join(root, directory), { recursive: true })
      writeFileSync(join(root, directory, 'package.json'), '{"name":"example","version":"1.0.0"}')
    }
    assert.equal(desktopSdkPackageDirectory('example', join(root, 'nested')), realpathSync(join(root, 'nested/node_modules/example')))
    assert.throws(() => desktopSdkPackageDirectory('not-present-desktop-sdk-fixture', root), /missing dependency/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('runtime SDK refuses both app bundles and shell CLI payloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-sdk-layout-'))
  try {
    assertRuntimeSdkLayout(root)
    for (const path of ['apps/desktop/lib', 'apps/desktop/.desktop-build/targets/mac-arm64/runtime/cli']) {
      mkdirSync(join(root, path), { recursive: true })
      assert.throws(() => assertRuntimeSdkLayout(root), /shell-owned path is forbidden/u)
      rmSync(join(root, path), { recursive: true })
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('generated declarations resolve workspace type imports and DefinitelyTyped packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-sdk-types-'))
  try {
    const types = join(root, 'node_modules/@types/markdown')
    mkdirSync(types, { recursive: true })
    writeFileSync(join(types, 'package.json'), '{"name":"@types/markdown","version":"1.0.0"}')
    assert.deepEqual(desktopSdkDeclarationDependency('@scope/shared', root, new Map([['@scope/shared', '/known/workspace']])),
      { name: '@scope/shared', directory: '/known/workspace' })
    assert.deepEqual(desktopSdkDeclarationDependency('markdown', root), { name: '@types/markdown', directory: realpathSync(types) })
    assert.throws(() => desktopSdkDeclarationDependency('absent-desktop-sdk-types', root), /missing dependency/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
