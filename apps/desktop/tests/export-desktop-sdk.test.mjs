/** Source-independent tooling checks for the Desktop SDK exporter. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, globSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { DESKTOP_SDK_API, writeDesktopSdkApi } from '../scripts/sdk-api.mjs'
import { desktopSdkOptionalPackageMatches } from '../scripts/export-desktop-sdk.mjs'
import { assertDesktopSdkBuildIdentity, assertDesktopSdkExportHost, assertRuntimeSdkLayout, compileDesktopSdkModule, createDesktopSdkToolingExporter, desktopSdkPackageDirectory, desktopSdkDeclarationDependency, desktopSdkPackedPath, desktopSdkPublishedImports, exportDesktopSdk } from '../scripts/export-desktop-sdk.mjs'

test('versioned API imports the real tooling closure after archive relocation without the export source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-sdk-api-'))
  try {
    const source = join(root, 'export'), moved = join(root, 'moved')
    mkdirSync(source)
    writeFileSync(join(source, 'package.json'), '{"type":"module"}\n')
    const copied = new Map()
    const linkPackage = (name, from, owner = source) => {
      const directory = desktopSdkPackageDirectory(name, from)
      let destination = copied.get(directory)
      if (destination === undefined) {
        destination = join(source, 'node_modules/.closure', String(copied.size))
        copied.set(directory, destination)
        cpSync(directory, destination, { recursive: true, filter: file => !relative(directory, file).split(/[\\/]/u).some(part => ['node_modules', 'src', 'tests'].includes(part)) })
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        for (const dependency of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])) {
          if (manifest.peerDependenciesMeta?.[dependency]?.optional) continue
          linkPackage(dependency, directory, destination)
        }
      }
      const link = join(owner, 'node_modules', name)
      mkdirSync(dirname(link), { recursive: true })
      if (!existsSync(link)) symlinkSync(relative(dirname(link), destination), link, 'dir')
    }
    const exportModule = createDesktopSdkToolingExporter(source, linkPackage)
    for (const entry of ['src/project-profile.ts', 'src/runtime-tree.ts', 'scripts/verify-packaged-runtime.mjs']) {
      exportModule(resolve(import.meta.dirname, '..', entry))
    }
    linkPackage('electron-builder', resolve(import.meta.dirname, '..'))
    writeDesktopSdkApi(source)
    mkdirSync(moved)
    for (const args of [['-czf', join(root, 'sdk.tgz'), '-C', source, '.'], ['-xzf', join(root, 'sdk.tgz'), '-C', moved]]) {
      const result = spawnSync('tar', args, { encoding: 'utf8' })
      assert.ifError(result.error)
      assert.equal(result.signal, null)
      assert.equal(result.status, 0, result.stderr)
    }
    rmSync(source, { recursive: true })
    const load = name => import(pathToFileURL(join(moved, DESKTOP_SDK_API[name])).href)
    const { createPluginProfile } = await load('profile')
    const profile = join(root, 'profile')
    createPluginProfile(profile)
    assert.ok(existsSync(join(profile, 'package.json')))
    assert.throws(() => createPluginProfile(join(root, 'duplicate'), ['duplicate', 'duplicate']), /duplicate built-in profile bundle/u)
    const { verifyDesktopRuntime } = await load('runtime')
    await assert.rejects(verifyDesktopRuntime(join(root, 'missing'), '1.0.0', { platform: 'darwin', arch: 'arm64' }), /ENOENT|runtime descriptor/u)
    const { verifyPackagedDesktopRuntime } = await load('packagedRuntime')
    assert.throws(() => verifyPackagedDesktopRuntime({ appOutDir: moved, packager: { getResourcesDir: () => moved } }), /missing runtime descriptor/u)
    const { loadAsar } = await load('tools')
    assert.equal(typeof (await loadAsar()).extractFile, 'function')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('optional native tooling honors allow lists, exclusions and Linux glibc', () => {
  const linux = { platform: 'linux', arch: 'x64' }
  for (const manifest of [{}, { os: ['linux'], cpu: ['x64'], libc: ['glibc'] }, { os: ['!darwin'], cpu: ['any'] }]) {
    assert.equal(desktopSdkOptionalPackageMatches(manifest, linux), true)
  }
  for (const manifest of [{ os: ['darwin'] }, { os: ['any', '!linux'] }, { cpu: ['arm64'] }, { cpu: ['!x64'] }, { libc: ['musl'] }, { libc: ['!glibc'] }]) {
    assert.equal(desktopSdkOptionalPackageMatches(manifest, linux), false)
  }
  assert.equal(desktopSdkOptionalPackageMatches({ os: ['darwin'], cpu: ['arm64'] }, { platform: 'darwin', arch: 'arm64' }), true)
})

test('SDK identity requires a clean matching official build and one release version', () => {
  const commit = 'a'.repeat(40)
  const source = { commit, status: '', version: 'fixture.1', desktopVersion: 'fixture.1' }
  const environment = { DSH_CLIENT_BUILD_PROFILE: 'official', DSH_CLIENT_VERSION: 'fixture.1' }
  assert.doesNotThrow(() => assertDesktopSdkBuildIdentity(source, environment, commit))
  for (const status of [' M apps/desktop/package.json', 'M  packages/example/package.json', '?? untracked.ts']) {
    assert.throws(() => assertDesktopSdkBuildIdentity({ ...source, status }, environment, commit), /source must be clean/u)
  }
  assert.throws(() => assertDesktopSdkBuildIdentity(source, { ...environment, DSH_CLIENT_GIT_DIRTY: 'true' }, commit), /dirty source/u)
  assert.throws(() => assertDesktopSdkBuildIdentity(source, { ...environment, DSH_CLIENT_BUILD_PROFILE: undefined }, commit), /official build/u)
  assert.throws(() => assertDesktopSdkBuildIdentity(source, environment, 'b'.repeat(40)), /commit differs/u)
  assert.throws(() => assertDesktopSdkBuildIdentity(source, { ...environment, DSH_CLIENT_VERSION: 'fixture.0' }, commit), /versions must match/u)
  assert.throws(() => assertDesktopSdkBuildIdentity({ ...source, desktopVersion: 'fixture.0' }, environment, commit), /versions must match/u)
})

test('SDK refuses another host before creating output rather than copying its native tools', () => {
  assert.doesNotThrow(() => assertDesktopSdkExportHost('darwin', 'arm64'))
  assert.doesNotThrow(() => assertDesktopSdkExportHost('linux', 'x64', 'linux-x64'))
  assert.throws(() => assertDesktopSdkExportHost('darwin', 'arm64', 'linux-x64'), /producer installation/u)
  assert.throws(() => assertDesktopSdkExportHost('linux', 'arm64', 'linux-x64'), /producer installation/u)
  assert.throws(() => assertDesktopSdkExportHost('linux', 'x64', 'linux-arm64'), /unsupported export target/u)
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'x64']]) {
    assert.throws(() => assertDesktopSdkExportHost(platform, arch), /producer installation/u)
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') return
  const root = mkdtempSync(join(tmpdir(), 'desktop-sdk-host-'))
  try {
    const output = join(root, 'sdk')
    assert.throws(() => exportDesktopSdk(output, 'mac-arm64'), /producer installation/u)
    assert.equal(existsSync(output), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('real preparation tooling exports an executable workspace helper without source imports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-sdk-tooling-'))
  try {
    const dependencies = new Set()
    const exportModule = createDesktopSdkToolingExporter(root, name => dependencies.add(name))
    exportModule(resolve(import.meta.dirname, '../scripts/prepare-dsh.ts'))
    const entry = readFileSync(join(root, 'apps/desktop/scripts/prepare-dsh.js'), 'utf8')
    assert.match(entry, /from ['"]\.\/desktop-preparation-workspace\.js['"]/u)
    assert.ok(dependencies.has('@deepseek-ai/dsh-tool-workspace-dependencies'))
    const modules = globSync('**/*.{js,mjs}', { cwd: root })
    assert.ok(modules.includes('apps/desktop/scripts/desktop-build-paths.mjs'))
    for (const filename of modules) {
      assert.doesNotMatch(readFileSync(join(root, filename), 'utf8'), /(?:from\s*|import\s*)['"][^'"]+\.ts['"]/u, filename)
    }
    const helper = await import(pathToFileURL(join(root, 'apps/desktop/scripts/desktop-preparation-workspace.js')).href)
    const workspace = helper.createDesktopPreparationWorkspace({})
    try {
      assert.ok(existsSync(workspace.directory))
      assert.equal(workspace.store, join(workspace.directory, 'store'))
    } finally { workspace.cleanup() }
    assert.equal(existsSync(workspace.directory), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('packed inventory locates copied tarballs independently of an external producer build root', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-sdk-packed-'))
  try {
    const packed = join(root, 'external-build', 'targets/mac-arm64/packed')
    const sdk = join(root, 'sdk')
    for (const family of ['dsh', 'vendor', 'landlock']) {
      const file = join(packed, family, 'fixture.tgz')
      mkdirSync(join(packed, family), { recursive: true })
      writeFileSync(file, family)
      const archived = desktopSdkPackedPath(file, packed, 'mac-arm64')
      assert.equal(archived, `apps/desktop/.desktop-build/targets/mac-arm64/packed/${family}/fixture.tgz`)
    }
    cpSync(packed, join(sdk, 'apps/desktop/.desktop-build/targets/mac-arm64/packed'), { recursive: true })
    for (const family of ['dsh', 'vendor', 'landlock']) {
      const archived = desktopSdkPackedPath(join(packed, family, 'fixture.tgz'), packed, 'mac-arm64')
      assert.equal(readFileSync(join(sdk, archived), 'utf8'), family)
    }
    assert.throws(() => desktopSdkPackedPath(join(packed, '../outside.tgz'), packed, 'mac-arm64'), /outside packed directory/u)
    assert.throws(() => desktopSdkPackedPath(packed, packed, 'mac-arm64'), /outside packed directory/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

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
    for (const path of ['apps/desktop/lib', 'apps/desktop/.desktop-build/targets/mac-arm64/runtime/cli', 'apps/desktop/.desktop-build/targets/linux-x64/runtime/cli']) {
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

test('published UI imports include bundler externals without leaking builtin or local modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-sdk-ui-imports-'))
  try {
    mkdirSync(join(root, 'lib'))
    writeFileSync(join(root, 'lib/index.js'), `import clsx from 'clsx'; import { jsx } from 'react/jsx-runtime'; import './atoms.css'; import 'node:fs'; export { icon } from '@scope/icons/all';`)
    writeFileSync(join(root, 'lib/index.d.ts'), `import type { Root } from 'mdast'; export type Value = import('@scope/schema').Value;`)
    assert.deepEqual(desktopSdkPublishedImports(root, 'lib/**/*.js'), ['clsx', 'react', '@scope/icons'])
    assert.deepEqual(desktopSdkPublishedImports(root, 'lib/**/*.d.ts', true), ['mdast', '@scope/schema'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
