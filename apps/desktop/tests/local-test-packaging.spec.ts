import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppInfo } from 'app-builder-lib/out/appInfo.js'
import { Packager } from 'app-builder-lib'
import { describe, it, expect } from 'vitest'
import { localTestPackageEnvironment, isLocalTestPackaging } from '../scripts/local-test-packaging.mjs'
import { LOCAL_TEST_METADATA, readLocalTestPackage } from '../src/local-test-package.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { parseDesktopPackageInvocation, desktopElectronBuilderEnvironment } from '../scripts/package-target.ts'
import { resolveDesktopAutoUpdateConfig, resolveDesktopUploadConfig } from '../scripts/desktop-auto-update-environment.mjs'

const product = { schemaVersion: 2, id: 'video-harness', product: { mode: 'local' },
  preflight: { entrypoint: 'control/desktop-local-preflight.mjs', exportedEnvironment: ['VIDEO_HARNESS_PROJECT_MODE'] },
  requiredServices: ['projectBff'] }
async function fixture(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'local-test-package-'))
  try { await writeFile(join(root, 'desktop-product.json'), JSON.stringify(product)); await run(root) }
  finally { await rm(root, { recursive: true, force: true }) }
}
describe('explicit local desktop test packaging', () => {
  it('keeps unconfigured ordinary Windows unsigned and prepare modes rejected', async () => {
    await fixture((root) => {
      for (const options of [{ unsigned: true }, { prepareOnly: true }]) {
        expect(() => loadDesktopPackageEnvironment('win32', {}, root, options)).toThrow('cannot read')
        expect(() => {
          validateDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'ai.videoharness.desktop' }, { platform: 'win32', arch: 'x64' }, options)
        }).toThrow('MANDATORY_UPDATE')
      }
    })
  })
  it('requires explicit unsigned Windows selection and excludes publishing configuration', async () => {
    expect(() => parseDesktopPackageInvocation(['win-x64', '--local-test'], 'win32', 'x64')).toThrow('unsigned Windows')
    expect(() => parseDesktopPackageInvocation(['mac-x64', '--unsigned', '--local-test'], 'darwin', 'x64')).toThrow('unsigned Windows')
    expect(() => parseDesktopPackageInvocation(['win-x64', '--unsigned', '--local-test', '--publish', 'always'], 'win32', 'x64')).toThrow()
    expect(parseDesktopPackageInvocation(['win-x64', '--local-test', '--prepare-only'], 'win32', 'x64')).toMatchObject({ localTest: true, unsigned: true, prepareOnly: true })
    await fixture((root) => {
      for (const field of ['DSH_DESKTOP_APP_ID', 'DSH_PACKAGING_PRESET', 'DOWNLOAD_TEST_ORIGIN', 'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', 'DSH_DESKTOP_UPDATE_CHANNEL', 'DSH_DESKTOP_WINDOWS_TOKEN_PIN']) {
        expect(() => localTestPackageEnvironment({ DSH_DESKTOP_PRODUCT_ROOT: root, [field]: 'mixed' })).toThrow('release configuration')
      }
      const environment = localTestPackageEnvironment({ DSH_DESKTOP_PRODUCT_ROOT: root })
      expect(() => localTestPackageEnvironment({ DSH_DESKTOP_PRODUCT_ROOT: root, DSH_DESKTOP_UNSIGNED: '0' })).toThrow('unsigned mode')
      expect(isLocalTestPackaging(environment, 'win32', true)).toBe(true)
      const generated = { ...desktopElectronBuilderEnvironment(environment, true), DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: '0' }
      expect(isLocalTestPackaging(generated, 'win32', true)).toBe(true)
      expect(() => isLocalTestPackaging({ ...generated, CSC_IDENTITY_AUTO_DISCOVERY: 'true' }, 'win32', true)).toThrow('disabled')
      expect(() => localTestPackageEnvironment({ DSH_DESKTOP_PRODUCT_ROOT: root, CSC_IDENTITY_AUTO_DISCOVERY: 'false' })).toThrow('release configuration')
      expect(() => isLocalTestPackaging(environment, 'win32', false)).toThrow('incompatible')
      expect(() => resolveDesktopAutoUpdateConfig(environment, 'win32', 'x64')).toThrow('no release')
      expect(() => resolveDesktopUploadConfig(environment, 'win32', 'x64')).toThrow('no release')
    })
  })
  it('rejects a service, remote product, and mismatched marker instead of changing modes', async () => {
    await fixture(async (root) => {
      for (const invalid of [{ ...product, id: 'other' }, { ...product, product: { mode: 'legacy-pg' } }, { ...product, service: product.preflight }]) {
        await writeFile(join(root, 'desktop-product.json'), JSON.stringify(invalid))
        expect(() => localTestPackageEnvironment({ DSH_DESKTOP_PRODUCT_ROOT: root })).toThrow('local-test')
      }
    })
    const metadata = { name: LOCAL_TEST_METADATA.name, productName: LOCAL_TEST_METADATA.productName,
      dshDesktopAppId: LOCAL_TEST_METADATA.appId, dshLocalTest: LOCAL_TEST_METADATA }
    expect(readLocalTestPackage(metadata)).toEqual(LOCAL_TEST_METADATA)
    for (const invalid of [{ ...metadata, dshDesktopUpdateChannel: 'nightly' }, { ...metadata, dshMandatoryUpdatePolicy: {} }, { ...metadata, name: '@deepseek-ai/dsh-desktop' }, { ...metadata, dshLocalTest: { ...LOCAL_TEST_METADATA, extra: true } }, { ...metadata, dshLocalTest: undefined }]) expect(() => readLocalTestPackage(invalid)).toThrow('local-test')
  })
  it('retains registry validation before local-test preparation', async () => {
    await fixture((root) => {
      const environment = localTestPackageEnvironment({ DSH_DESKTOP_PRODUCT_ROOT: root })
      for (const registry of ['http://registry.example', 'https://user:pass@registry.example', 'https://registry.example/path',
        'https://registry.example/?query=1', 'https://registry.example/#fragment', 'not-a-url']) {
        expect(() => {
          validateDesktopPackageEnvironment({ ...environment, DSH_DESKTOP_NPM_REGISTRY: registry },
            { platform: 'win32', arch: 'x64' }, { unsigned: true })
        }).toThrow('HTTPS origin')
      }
      for (const registry of [undefined, 'https://registry.npmjs.org']) {
        validateDesktopPackageEnvironment({ ...environment, DSH_DESKTOP_NPM_REGISTRY: registry },
          { platform: 'win32', arch: 'x64' }, { unsigned: true })
      }
    })
  })
  it('isolates installer identity, protocol, output and every expanded uninstall data name', async () => {
    await fixture((root) => {
      const env = { ...localTestPackageEnvironment({ DSH_DESKTOP_PRODUCT_ROOT: root }), DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64' }
      validateDesktopPackageEnvironment(env, { platform: 'win32', arch: 'x64' }, { unsigned: true })
      const config = createElectronBuilderConfig(env, 'win32', 'x64')
      expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: LOCAL_TEST_METADATA.appId }, 'win32', 'x64')).toThrow('reserved')
      expect(config.appId).toBe(LOCAL_TEST_METADATA.appId)
      expect(config.productName).toBe(LOCAL_TEST_METADATA.productName)
      expect(config.protocols[0]?.schemes).toEqual([LOCAL_TEST_METADATA.protocol])
      expect(config.extraMetadata).not.toHaveProperty('dshDesktopUpdateChannel')
      expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
      expect(config.publish).toBeNull()
      expect(config.artifactName).toContain('-local-test-unsigned')
      expect(config.directories.output).toMatch(/[\\/]unsigned-artifacts[\\/]local-test$/u)
      expect(config.nsis).toMatchObject({ perMachine: false, allowElevation: false })
      const packager = new Packager({ projectDir: root })
      Object.defineProperties(packager, { metadata: { value: { version: '0.2.1', ...config.extraMetadata } }, config: { value: config } })
      const info = new AppInfo(packager, undefined)
      expect(info.productFilename).toBe(LOCAL_TEST_METADATA.homeName)
      expect(info.name).toBe(LOCAL_TEST_METADATA.name)
      expect(info.updaterCacheDirName).toBe('video-harness-local-test-updater')
      expect(info.id).not.toBe('com.deepseek.harness')
      expect(info.productFilename).not.toBe('DeepSeek Harness')
    })
  })
})
