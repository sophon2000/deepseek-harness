import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  desktopTargetBuildPaths,
  desktopTargetPlatform,
  developmentRuntimeDirectory,
  resolveDesktopBuildTarget,
} from '../scripts/desktop-build-paths.mjs'

const fixtures: string[] = []
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop paths ')))
  fixtures.push(root)
  const appRoot = join(root, 'source', 'apps', 'desktop')
  mkdirSync(appRoot, { recursive: true })
  return { root, appRoot }
}

describe('desktop build paths', () => {
  it.skipIf(process.platform !== 'win32')('rejects an unavailable volume without looping during path resolution', () => {
    const missing = ['Z', 'Y', 'X', 'W', 'V'].map(drive => `${drive}:\\`).find(path => !existsSync(path))
    expect(missing).toBeDefined()
    const moduleUrl = new URL('../scripts/desktop-build-paths.mjs', import.meta.url).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { desktopTargetBuildPaths } from ${JSON.stringify(moduleUrl)}; desktopTargetBuildPaths('win-x64', ${JSON.stringify({ DSH_DESKTOP_BUILD_ROOT: `${missing}build` })});`,
    ], { encoding: 'utf8', timeout: 2000 })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/filesystem root is unavailable/u)
  })

  it('uses explicit directories consistently for targets, journals and development runtime', () => {
    const { root, appRoot } = fixture()
    const env = {
      DSH_DESKTOP_BUILD_ROOT: join(root, 'build'),
      DSH_DESKTOP_DOWNLOAD_CACHE: join(root, 'downloads'),
      DSH_DESKTOP_PNPM_STORE_ROOT: join(root, 'store'),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
    }
    const paths = desktopTargetBuildPaths('win-x64', env, appRoot)
    expect(paths.root).toBe(join(root, 'build', 'targets', 'win-x64'))
    expect(paths.packagingRuns).toBe(join(root, 'build', 'packaging-runs'))
    expect(paths.uploadRecords).toBe(join(root, 'build', 'upload-records'))
    expect(paths.downloads).toBe(env.DSH_DESKTOP_DOWNLOAD_CACHE)
    expect(paths.pnpmStore).toBe(join(root, 'store', 'win-x64'))
    expect(desktopTargetBuildPaths('mac-arm64', env, appRoot).pnpmStore).toBe(join(root, 'store', 'mac-arm64'))
    expect(developmentRuntimeDirectory(env, 'win32', 'arm64')).toBe(join(paths.runtime, 'primary-runtime'))
    expect(existsSync(paths.buildRoot)).toBe(false)
    expect(existsSync(paths.downloads)).toBe(false)
  })

  it('keeps the original defaults for an explicitly selected app root', () => {
    const { appRoot } = fixture()
    const paths = desktopTargetBuildPaths('win-x64', {}, appRoot)
    expect(paths.buildRoot).toBe(join(appRoot, '.desktop-build'))
    expect(paths.downloads).toBe(join(appRoot, '.desktop-build', 'downloads'))
    expect(paths.pnpmStore).toBeUndefined()
  })

  it.each(['DSH_DESKTOP_BUILD_ROOT', 'DSH_DESKTOP_DOWNLOAD_CACHE', 'DSH_DESKTOP_PNPM_STORE_ROOT'])(
    'rejects empty, relative and source-owning %s directories before creating files', (name) => {
      const { root, appRoot } = fixture()
      for (const value of ['', ' ', 'relative', parse(root).root, appRoot, dirname(appRoot)]) {
        expect(() => desktopTargetBuildPaths('win-x64', { [name]: value }, appRoot)).toThrow(/desktop build paths/u)
      }
      expect(existsSync(join(appRoot, '.desktop-build'))).toBe(false)
    },
  )

  it('rejects cache overlap with any mutable target and with another cache', () => {
    const { root, appRoot } = fixture()
    const buildRoot = join(root, 'build')
    for (const name of ['DSH_DESKTOP_DOWNLOAD_CACHE', 'DSH_DESKTOP_PNPM_STORE_ROOT']) {
      for (const cache of [buildRoot, join(buildRoot, 'targets'), join(buildRoot, 'targets', 'mac-x64', 'runtime')]) {
        expect(() => desktopTargetBuildPaths('win-x64', { DSH_DESKTOP_BUILD_ROOT: buildRoot, [name]: cache }, appRoot))
          .toThrow(/caches must not overlap/u)
      }
    }
    expect(() => desktopTargetBuildPaths('win-x64', {
      DSH_DESKTOP_DOWNLOAD_CACHE: join(root, 'cache'), DSH_DESKTOP_PNPM_STORE_ROOT: join(root, 'cache', 'store'),
    }, appRoot)).toThrow(/separate directories/u)
  })

  it('resolves existing parent junctions before checking cache overlap', () => {
    const { root, appRoot } = fixture()
    const buildRoot = join(root, 'build')
    mkdirSync(join(buildRoot, 'targets'), { recursive: true })
    symlinkSync(join(buildRoot, 'targets'), join(root, 'cache-alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => desktopTargetBuildPaths('win-x64', {
      DSH_DESKTOP_BUILD_ROOT: buildRoot, DSH_DESKTOP_DOWNLOAD_CACHE: join(root, 'cache-alias', 'new-cache'),
    }, appRoot)).toThrow(/caches must not overlap/u)
  })

  it('rejects redirected mutable output before preparation can reset another directory', () => {
    const { root, appRoot } = fixture()
    const buildRoot = join(root, 'build')
    const targetRoot = join(buildRoot, 'targets', 'win-x64')
    mkdirSync(targetRoot, { recursive: true })
    symlinkSync(appRoot, join(targetRoot, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => desktopTargetBuildPaths('win-x64', { DSH_DESKTOP_BUILD_ROOT: buildRoot }, appRoot))
      .toThrow(/symbolic links or junctions/u)
    expect(existsSync(appRoot)).toBe(true)
  })

  it('rejects a persistent store target redirected into mutable output', () => {
    const { root, appRoot } = fixture()
    const buildRoot = join(root, 'build')
    const storeRoot = join(root, 'store')
    mkdirSync(join(buildRoot, 'targets'), { recursive: true })
    mkdirSync(storeRoot)
    symlinkSync(join(buildRoot, 'targets'), join(storeRoot, 'win-x64'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => desktopTargetBuildPaths('win-x64', {
      DSH_DESKTOP_BUILD_ROOT: buildRoot, DSH_DESKTOP_PNPM_STORE_ROOT: storeRoot,
    }, appRoot)).toThrow(/symbolic links or junctions/u)
  })

  it('isolates every mutable build directory by complete target', () => {
    const arm64 = desktopTargetBuildPaths('mac-arm64')
    const x64 = desktopTargetBuildPaths('mac-x64')
    const windows = desktopTargetBuildPaths('win-x64')
    const mutableKeys = [
      'root',
      'artifacts',
      'unsignedArtifacts',
      'unnotarizedArtifacts',
      'runtime',
      'packageSet',
      'dsh',
      'dshPnpm',
      'electron',
      'packedDsh',
      'packedVendor',
      'packedLandlock',
    ] as const

    for (const key of mutableKeys) {
      expect(new Set([arm64[key], x64[key], windows[key]]).size).toBe(3)
    }
    expect(arm64.artifacts).toContain(join('targets', 'mac-arm64', 'artifacts'))
    expect(x64.dsh).toContain(join('targets', 'mac-x64', 'dsh'))
    expect(windows.runtime).toContain(join('targets', 'win-x64', 'runtime'))
  })

  it('shares only the immutable upstream download cache', () => {
    const arm64 = desktopTargetBuildPaths('mac-arm64')
    const x64 = desktopTargetBuildPaths('mac-x64')
    expect(arm64.downloads).toBe(x64.downloads)
    expect(arm64.downloads).not.toContain(`${sep}targets${sep}`)
  })

  it('resolves the development primary runtime from the build target rather than the host architecture', () => {
    expect(developmentRuntimeDirectory({}, 'darwin', 'arm64'))
      .toContain(join('targets', 'mac-arm64', 'runtime', 'primary-runtime'))
    expect(developmentRuntimeDirectory({}, 'darwin', 'x64'))
      .toContain(join('targets', 'mac-x64', 'runtime', 'primary-runtime'))
    expect(developmentRuntimeDirectory({}, 'win32', 'arm64'))
      .toContain(join('targets', 'win-x64', 'runtime', 'primary-runtime'))
  })

  it('maps every target to the platform and architecture of the payload it prepares', () => {
    expect(desktopTargetPlatform('mac-arm64')).toEqual({ platform: 'darwin', arch: 'arm64' })
    expect(desktopTargetPlatform('mac-x64')).toEqual({ platform: 'darwin', arch: 'x64' })
    expect(desktopTargetPlatform('win-x64')).toEqual({ platform: 'win32', arch: 'x64' })
    expect(() => desktopTargetPlatform('linux-x64' as 'mac-x64')).toThrow(/unsupported target/u)
  })

  it('resolves environment overrides and rejects unsupported targets', () => {
    expect(resolveDesktopBuildTarget({
      DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
    }, 'darwin', 'arm64')).toBe('mac-x64')
    expect(resolveDesktopBuildTarget({}, 'win32', 'x64')).toBe('win-x64')
    expect(() => resolveDesktopBuildTarget({}, 'linux', 'x64')).toThrow(/unsupported target/u)
    expect(() => desktopTargetBuildPaths('linux-x64' as 'mac-x64')).toThrow(/unsupported target/u)
  })
})
