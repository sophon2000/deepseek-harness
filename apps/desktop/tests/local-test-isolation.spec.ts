import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DesktopRuntimeProduct } from '../src/desktop-product.ts'
import { configureLocalTestIsolation } from '../src/local-test-isolation.ts'
import { LOCAL_TEST_METADATA } from '../src/local-test-package.mjs'

const runtime = vi.hoisted(() => ({ read: vi.fn<(root: string) => { product?: DesktopRuntimeProduct }>() }))
vi.mock('../src/runtime-tree.ts', () => ({ readDesktopRuntime: runtime.read }))

const localProduct = {
  id: 'video-harness', resourcesRoot: 'product-resources', profileBundles: ['@video-harness/profile'],
  preflight: { entrypoint: 'control/desktop-local-preflight.mjs',
    exportedEnvironment: ['VIDEO_HARNESS_PROJECT_MODE', 'VIDEO_HARNESS_DSH_HOME'] },
  requiredServices: ['projectBff'],
} satisfies DesktopRuntimeProduct
const { preflight: _preflight, ...localProductWithoutPreflight } = localProduct

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-local-test-isolation-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const paths = new Map([['appData', root], ['userData', join(root, 'formal-user-data')], ['home', 'original-os-home']])
  const app = {
    isPackaged: true,
    getPath: vi.fn((name: string) => paths.get(name) ?? `original-${name}`),
    setPath: vi.fn((name: string, path: string) => { paths.set(name, path) }),
    setName: vi.fn(), setAppUserModelId: vi.fn(),
  }
  const environment: NodeJS.ProcessEnv = {
    DSH_HOME: 'formal-dsh-home', VIDEO_HARNESS_DSH_HOME: 'formal-video-home',
    DSH_AGENTS_HOME: 'formal-agents-home',
    HOME: 'original-os-home', USERPROFILE: 'original-os-home', PATH: 'original-tool-path',
  }
  return {
    app, root, paths, environment, resourcesPath: root, argv: ['local-test.exe'],
    manifest: { name: LOCAL_TEST_METADATA.name, productName: LOCAL_TEST_METADATA.productName,
      dshDesktopAppId: LOCAL_TEST_METADATA.appId, dshLocalTest: { ...LOCAL_TEST_METADATA } },
  }
}

beforeEach(() => {
  runtime.read.mockReset()
  runtime.read.mockReturnValue({ product: localProduct })
})

describe('local-test desktop isolation', () => {
  it('keeps ordinary package directories, environment, and runtime loading unchanged', () => {
    const input = fixture()
    const original = { ...input.environment }
    expect(configureLocalTestIsolation({ ...input, manifest: { dshDesktopAppId: 'com.deepseek.dsh' } })).toBeUndefined()
    expect(input.app.setPath).not.toHaveBeenCalled()
    expect(input.app.setName).not.toHaveBeenCalled()
    expect(input.app.setAppUserModelId).not.toHaveBeenCalled()
    expect(input.environment).toEqual(original)
    expect(runtime.read).not.toHaveBeenCalled()
    expect(readdirSync(input.root)).toEqual([])
  })

  it('isolates profiles and browser storage while retaining the OS home and executable search path', () => {
    const input = fixture()
    expect(configureLocalTestIsolation(input)).toEqual(LOCAL_TEST_METADATA)
    const userData = join(input.root, LOCAL_TEST_METADATA.homeName)
    expect(input.paths.get('userData')).toBe(userData)
    expect(input.paths.get('sessionData')).toBe(join(userData, 'session-data'))
    expect(input.paths.get('crashDumps')).toBe(join(userData, 'Crashpad'))
    expect(input.app.setName).toHaveBeenCalledWith('Video Harness Local Test')
    expect(input.app.setAppUserModelId).toHaveBeenCalledWith('ai.videoharness.localtest')
    expect(input.environment).toEqual({ DSH_HOME: join(userData, 'dsh'), VIDEO_HARNESS_DSH_HOME: join(userData, 'dsh'),
      DSH_AGENTS_HOME: join(userData, 'agents'),
      HOME: 'original-os-home', USERPROFILE: 'original-os-home', PATH: 'original-tool-path' })
    expect(input.app.getPath('home')).toBe('original-os-home')
    expect(runtime.read).toHaveBeenCalledWith(join(input.root, 'dsh'))
    expect(readdirSync(input.root)).toEqual([LOCAL_TEST_METADATA.homeName])
  })

  it('rejects a local-test marker in an unpackaged launch before writing data', () => {
    const input = fixture()
    input.app.isPackaged = false
    expect(() => configureLocalTestIsolation(input)).toThrow('requires a packaged application')
    expect(input.app.setPath).not.toHaveBeenCalled()
    expect(readdirSync(input.root)).toEqual([])
  })

  it('passes a canonical OS data path to product preflight while retaining the local-test namespace', () => {
    const input = fixture()
    const physicalAppData = join(input.root, 'physical-app-data')
    const osAppDataAlias = join(input.root, 'os-app-data')
    mkdirSync(physicalAppData)
    symlinkSync(physicalAppData, osAppDataAlias, process.platform === 'win32' ? 'junction' : 'dir')
    input.paths.set('appData', osAppDataAlias)
    const nativeCanonical = vi.spyOn(realpathSync, 'native')
    configureLocalTestIsolation(input)
    const canonical = realpathSync.native(join(physicalAppData, LOCAL_TEST_METADATA.homeName))
    expect(nativeCanonical).toHaveBeenCalledWith(join(osAppDataAlias, LOCAL_TEST_METADATA.homeName))
    expect(input.paths.get('userData')).toBe(canonical)
    expect(input.paths.get('sessionData')).toBe(join(canonical, 'session-data'))
    expect(input.environment.DSH_HOME).toBe(join(canonical, 'dsh'))
    expect(input.environment.DSH_AGENTS_HOME).toBe(join(canonical, 'agents'))
    expect(input.environment.VIDEO_HARNESS_DSH_HOME).toBe(join(canonical, 'dsh'))
    expect(readdirSync(physicalAppData)).toEqual([LOCAL_TEST_METADATA.homeName])
  })

  it.each(['', 'session-data', 'Crashpad', 'dsh', 'agents'])('rejects a redirected test data directory %s before changing paths', (child) => {
    const input = fixture()
    const formalHome = join(input.root, 'formal-home')
    mkdirSync(formalHome)
    writeFileSync(join(formalHome, 'marker'), 'formal-data')
    const userData = join(input.root, LOCAL_TEST_METADATA.homeName)
    if (child !== '') mkdirSync(userData)
    symlinkSync(formalHome, child === '' ? userData : join(userData, child), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => configureLocalTestIsolation(input)).toThrow('data directory must not be a link or non-directory')
    expect(input.app.setPath).not.toHaveBeenCalled()
    expect(input.app.setName).not.toHaveBeenCalled()
    expect(input.environment.DSH_HOME).toBe('formal-dsh-home')
    expect(readdirSync(formalHome)).toEqual(['marker'])
    expect(readFileSync(join(formalHome, 'marker'), 'utf8')).toBe('formal-data')
  })

  it.each(['', 'session-data', 'Crashpad', 'dsh', 'agents'])('rejects a non-directory test data path %s before creating directories', (child) => {
    const input = fixture()
    const userData = join(input.root, LOCAL_TEST_METADATA.homeName)
    if (child !== '') mkdirSync(userData)
    writeFileSync(child === '' ? userData : join(userData, child), 'existing-file')
    expect(() => configureLocalTestIsolation(input)).toThrow('data directory must not be a link or non-directory')
    expect(input.app.setPath).not.toHaveBeenCalled()
    expect(input.environment.DSH_HOME).toBe('formal-dsh-home')
    if (child !== '') expect(readdirSync(userData)).toEqual([child])
  })

  it.each(['--user-data-dir=C:/formal', '--user-data-dir', '--USER-DATA-DIR=C:/formal', '--disk-cache-dir=C:/formal'])(
    'rejects Chromium storage override %s before writing data', (argument) => {
      const input = fixture()
      input.argv.push(argument)
      expect(() => configureLocalTestIsolation(input)).toThrow('user-data overrides are forbidden')
      expect(input.app.setPath).not.toHaveBeenCalled()
      expect(readdirSync(input.root)).toEqual([])
    })

  it.each(['DSH_DESKTOP_USER_DATA_DIR', 'ELECTRON_USER_DATA_DIR'])('rejects inherited %s', (key) => {
    const input = fixture()
    input.environment[key] = 'formal-user-data'
    expect(() => configureLocalTestIsolation(input)).toThrow('user-data overrides are forbidden')
    expect(readdirSync(input.root)).toEqual([])
  })

  it.each([
    { dshMandatoryUpdatePolicy: {} }, { dshDesktopUpdateChannel: 'latest' }, { publish: [] },
    { name: 'formal-application' }, { dshLocalTest: { ...LOCAL_TEST_METADATA, mode: 'remote' } },
    { dshLocalTest: { ...LOCAL_TEST_METADATA, unexpected: true } }, { dshLocalTest: undefined },
  ])('rejects mixed or malformed local-test package fields %j before runtime startup', (fields) => {
    const input = fixture()
    expect(() => configureLocalTestIsolation({ ...input, manifest: { ...input.manifest, ...fields } })).toThrow()
    expect(runtime.read).not.toHaveBeenCalled()
    expect(input.app.setPath).not.toHaveBeenCalled()
    expect(readdirSync(input.root)).toEqual([])
  })

  it('rejects an injected app-update.yml before runtime loading or data creation', () => {
    const input = fixture()
    writeFileSync(join(input.root, 'app-update.yml'), 'provider: generic\nurl: https://updates.invalid/\n')
    expect(() => configureLocalTestIsolation(input)).toThrow('packaged update source is forbidden')
    expect(runtime.read).not.toHaveBeenCalled()
    expect(input.app.setPath).not.toHaveBeenCalled()
    expect(readdirSync(input.root)).toEqual(['app-update.yml'])
  })

  it.each([
    undefined,
    { ...localProduct, id: 'other-product' },
    localProductWithoutPreflight,
    { ...localProduct, service: localProduct.preflight },
    { ...localProduct, requiredServices: ['remoteService'] },
    { ...localProduct, preflight: { entrypoint: 'control/remote-service.mjs', exportedEnvironment: ['VIDEO_HARNESS_PROJECT_MODE'] } },
  ])('rejects an incompatible packaged runtime %j before data creation', (product) => {
    const input = fixture()
    runtime.read.mockReturnValue(product === undefined ? {} : { product })
    expect(() => configureLocalTestIsolation(input)).toThrow()
    expect(input.app.setName).not.toHaveBeenCalled()
    expect(input.app.setPath).not.toHaveBeenCalled()
    expect(input.environment.DSH_HOME).toBe('formal-dsh-home')
    expect(readdirSync(input.root)).toEqual([])
  })
})
