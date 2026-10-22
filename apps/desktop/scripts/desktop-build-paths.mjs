/** Resolve build-owned Desktop paths without sharing mutable state across release targets. */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const APP_ROOT = resolve(import.meta.dirname, '..')
const SUPPORTED_TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64', 'linux-x64'])

function canonicalDirectory(path) {
  let existing = resolve(path)
  const suffix = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new Error('desktop build paths: filesystem root is unavailable')
    suffix.unshift(basename(existing))
    existing = parent
  }
  if (!statSync(existing).isDirectory()) throw new Error('desktop build paths: directory path contains a file')
  return resolve(realpathSync.native(existing), ...suffix)
}

function contains(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function overlaps(left, right) {
  return contains(left, right) || contains(right, left)
}

function mutableDirectory(path) {
  if (relative(path, canonicalDirectory(path)) !== '') {
    throw new Error('desktop build paths: mutable build directories must not contain symbolic links or junctions')
  }
  return path
}

function configuredDirectory(env, name, fallback, appRoot) {
  const value = env[name]
  if (value === undefined) return canonicalDirectory(fallback)
  if (value.trim() === '' || !isAbsolute(value)) throw new Error(`desktop build paths: ${name} must be an absolute directory`)
  const directory = canonicalDirectory(value)
  if (dirname(directory) === directory || contains(directory, canonicalDirectory(appRoot))) {
    throw new Error(`desktop build paths: ${name} cannot be a filesystem root or an ancestor of the desktop source`)
  }
  return directory
}

/**
 * Resolve the fixed build target selected by a packaging environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no target override exists.
 * @param {string} hostArch - Build-host architecture used when no target override exists.
 * @returns {'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x64'} Supported Desktop target name.
 */
export function resolveDesktopBuildTarget(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  const platform = env.DSH_DESKTOP_TARGET_PLATFORM ?? env.npm_config_platform ?? hostPlatform
  const arch = env.DSH_DESKTOP_TARGET_ARCH ?? env.npm_config_arch
    ?? (platform === 'win32' || platform === 'win' ? 'x64' : hostArch)
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' || platform === 'win' ? 'win' : platform
  const target = `${os}-${arch}`
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`desktop build paths: unsupported target ${target}`)
  }
  return /** @type {'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x64'} */ (target)
}

function assertSupportedTarget(target) {
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`desktop build paths: unsupported target ${String(target)}`)
  }
}

/**
 * Return the mutable preparation and artifact directories owned by one release target.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x64'} target - Supported Desktop target name.
 * @param {NodeJS.ProcessEnv} env - Optional absolute build and cache directory overrides.
 * @param {string} appRoot - Desktop source directory used for defaults and source protection.
 * @returns {{ buildRoot: string, packagingRuns: string, uploadRecords: string, root: string, artifacts: string, unsignedArtifacts: string, unnotarizedArtifacts: string, runtime: string, packageSet: string, dsh: string, dshPnpm: string, electron: string, packedDsh: string, packedVendor: string, packedLandlock: string, downloads: string, pnpmStore?: string }} Target paths and persistent caches; caches never overlap mutable target directories.
 */
export function desktopTargetBuildPaths(target, env = process.env, appRoot = APP_ROOT) {
  assertSupportedTarget(target)
  const buildRoot = configuredDirectory(env, 'DSH_DESKTOP_BUILD_ROOT', join(appRoot, '.desktop-build'), appRoot)
  const downloads = configuredDirectory(env, 'DSH_DESKTOP_DOWNLOAD_CACHE', join(buildRoot, 'downloads'), appRoot)
  const storeRoot = env.DSH_DESKTOP_PNPM_STORE_ROOT === undefined ? undefined
    : configuredDirectory(env, 'DSH_DESKTOP_PNPM_STORE_ROOT', '', appRoot)
  const targets = mutableDirectory(join(buildRoot, 'targets'))
  for (const cache of [downloads, ...(storeRoot === undefined ? [] : [storeRoot])]) {
    if (overlaps(cache, targets)) throw new Error('desktop build paths: caches must not overlap mutable target directories')
  }
  if (storeRoot !== undefined && overlaps(storeRoot, downloads)) {
    throw new Error('desktop build paths: download and pnpm caches must be separate directories')
  }
  const root = mutableDirectory(join(targets, target))
  const packed = mutableDirectory(join(root, 'packed'))
  return {
    buildRoot,
    packagingRuns: join(buildRoot, 'packaging-runs'),
    uploadRecords: join(buildRoot, 'upload-records'),
    root,
    artifacts: mutableDirectory(join(root, 'artifacts')),
    unsignedArtifacts: mutableDirectory(join(root, 'unsigned-artifacts')),
    unnotarizedArtifacts: mutableDirectory(join(root, 'unnotarized-artifacts')),
    runtime: mutableDirectory(join(root, 'runtime')),
    packageSet: mutableDirectory(join(root, 'package-set')),
    dsh: mutableDirectory(join(root, 'dsh')),
    dshPnpm: mutableDirectory(join(root, 'dsh-pnpm')),
    electron: mutableDirectory(join(root, 'electron')),
    packedDsh: mutableDirectory(join(packed, 'dsh')),
    packedVendor: mutableDirectory(join(packed, 'vendor')),
    packedLandlock: mutableDirectory(join(packed, 'landlock')),
    downloads,
    ...(storeRoot === undefined ? {} : { pnpmStore: mutableDirectory(join(storeRoot, target)) }),
  }
}

/**
 * Return the platform and architecture of the payload one release target prepares.
 * Windows is prepared as x64 only, so this differs from the build host on an arm64 Windows machine.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x64'} target - Supported Desktop target name.
 * @returns {{ platform: 'darwin' | 'win32' | 'linux', arch: 'arm64' | 'x64' }} Platform and architecture of the prepared payload.
 */
export function desktopTargetPlatform(target) {
  assertSupportedTarget(target)
  return {
    platform: /** @type {'darwin' | 'win32' | 'linux'} */ (target === 'win-x64' ? 'win32' : target === 'linux-x64' ? 'linux' : 'darwin'),
    arch: /** @type {'arm64' | 'x64'} */ (target === 'mac-arm64' ? 'arm64' : 'x64'),
  }
}

/**
 * Resolve the paths owned by the target selected in a packaging environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no target override exists.
 * @param {string} hostArch - Build-host architecture used when no target override exists.
 * @returns {ReturnType<typeof desktopTargetBuildPaths>} Selected target paths.
 */
export function resolveDesktopTargetBuildPaths(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  return desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch), env)
}

/**
 * Resolve the primary-runtime directory an unpackaged development launch uses.
 * The build target fixes Windows to x64, so the shell cannot derive this directory from
 * the architecture of the process that launched it.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no target override exists.
 * @param {string} hostArch - Build-host architecture used when no target override exists.
 * @returns {string} Primary-runtime directory prepared for the selected target.
 */
export function developmentRuntimeDirectory(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  return join(resolveDesktopTargetBuildPaths(env, hostPlatform, hostArch).runtime, 'primary-runtime')
}

/**
 * Select the output directory and filename suffix for one packaging mode.
 * @param {{ artifacts: string, unsignedArtifacts: string, unnotarizedArtifacts: string }} paths Target artifact directories.
 * @param {{ unsigned: boolean, skipNotarization: boolean }} mode Validated packaging mode.
 * @returns {{ directory: string, suffix: string }} Matching artifact destination and filename marker.
 */
export function desktopArtifactOutput(paths, mode) {
  if (mode.unsigned) return { directory: paths.unsignedArtifacts, suffix: '-unsigned' }
  if (mode.skipNotarization) return { directory: paths.unnotarizedArtifacts, suffix: '-unnotarized' }
  return { directory: paths.artifacts, suffix: '' }
}
