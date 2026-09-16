/** Prepare the disposable npm-project view used by an unpackaged Electron shell. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createDevelopmentProjectMetadata } from '../src/project-manager.ts'
import type { DesktopRelease } from '../src/release.ts'
import { DESKTOP_RUNTIME_FILE, type DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

interface PackageManifest {
  readonly name?: string
  readonly version?: string
  readonly dsh?: { readonly bundle?: unknown }
}

/** Inputs whose locations differ between the launcher and isolated tests. */
export interface DevelopmentProjectOptions {
  /** Directory replaced with the generated development project. */
  readonly projectDir: string
  /** Current workspace's `apps/cli` package directory. */
  readonly cliDir: string
  /** Current workspace's private Desktop Host application directory. */
  readonly hostDir: string
  /** pnpm's workspace-wide virtual-hoist directory. */
  readonly dependencyDir: string
  /** Release identity written into the disposable project metadata. */
  readonly release: DesktopRelease
  /** Built external packages linked into this disposable development profile. */
  readonly profilePackageDirs?: readonly string[]
  /** Additional system-trusted preset roots, accepted only by linked development hosts. */
  readonly systemPresetRoots?: readonly string[]
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function removeOwnedPath(path: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (stat.isDirectory()) {
    rmSync(path, { recursive: true })
    return
  }
  unlinkSync(path)
}

function linkDirectory(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(realpathSync(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
}

function mirrorDependencyLinks(sourceRoot: string, destinationRoot: string): string[] {
  const names: string[] = []
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const source = join(sourceRoot, entry.name)
    if (entry.name.startsWith('@') && (entry.isDirectory() || entry.isSymbolicLink())) {
      mkdirSync(join(destinationRoot, entry.name), { recursive: true })
      for (const scoped of readdirSync(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        linkDirectory(join(source, scoped.name), join(destinationRoot, entry.name, scoped.name))
        names.push(`${entry.name}/${scoped.name}`)
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      linkDirectory(source, join(destinationRoot, entry.name))
      names.push(entry.name)
    }
  }
  return names
}

/**
 * Replace one disposable project with links to the current built workspace.
 * @param options - Project destination, CLI package, and release identity.
 * @returns the absolute project directory supplied by the caller.
 */
export function prepareDevelopmentProject(options: DevelopmentProjectOptions): string {
  const cliManifest = readManifest(join(options.cliDir, 'package.json'))
  if (cliManifest.name !== '@deepseek-ai/dsh' || cliManifest.version !== options.release.version) {
    throw new Error(
      `desktop development: apps/cli must be @deepseek-ai/dsh@${options.release.version}, found `
      + `${String(cliManifest.name)}@${String(cliManifest.version)}`,
    )
  }
  if (!existsSync(options.dependencyDir)) {
    throw new Error('desktop development: workspace dependency links are missing; run pnpm install')
  }
  const hostManifest = readManifest(join(options.hostDir, 'package.json'))
  if (hostManifest.name !== '@deepseek-ai/dsh-desktop-host' || hostManifest.version !== options.release.version) {
    throw new Error(
      `desktop development: apps/desktop-host must be @deepseek-ai/dsh-desktop-host@${options.release.version}, found `
      + `${String(hostManifest.name)}@${String(hostManifest.version)}`,
    )
  }
  if (!existsSync(join(options.hostDir, 'lib', 'index.js'))) {
    throw new Error('desktop development: apps/desktop-host/lib/index.js is missing; run pnpm run build')
  }

  removeOwnedPath(options.projectDir)
  createDevelopmentProjectMetadata(options.projectDir, options.release)
  const profilePackages = (options.profilePackageDirs ?? []).map(packageDir => ({
    packageDir: realpathSync(packageDir),
    manifest: readManifest(join(packageDir, 'package.json')),
  }))
  const packageNames = profilePackages.map(({ manifest }) => manifest.name)
  if (packageNames.some(name => typeof name !== 'string') || new Set(packageNames).size !== packageNames.length) {
    throw new Error('desktop development: linked profile packages need unique package names')
  }
  for (const { packageDir, manifest } of profilePackages) {
    if (typeof manifest.version !== 'string' || manifest.version === '') {
      throw new Error(`desktop development: linked profile package ${packageDir} has no version`)
    }
  }
  const systemPresetRoots = (options.systemPresetRoots ?? []).map(root => realpathSync(root))
  const projectManifestPath = join(options.projectDir, 'package.json')
  const projectManifest = JSON.parse(readFileSync(projectManifestPath, 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] }; desktop?: { systemPresetRoots?: string[] } }
  }
  for (const { manifest } of profilePackages) {
    projectManifest.dependencies[manifest.name!] = manifest.version!
    if (manifest.dsh?.bundle !== undefined) projectManifest.dsh.profile.bundles.push(manifest.name!)
  }
  if (systemPresetRoots.length > 0) projectManifest.dsh.desktop = { systemPresetRoots }
  writeFileSync(projectManifestPath, `${JSON.stringify(projectManifest, undefined, 2)}\n`, { mode: 0o600 })
  const destinationModules = join(options.projectDir, 'node_modules')
  mkdirSync(destinationModules, { recursive: true })
  const names = mirrorDependencyLinks(options.dependencyDir, destinationModules)
  const dshLink = join(destinationModules, '@deepseek-ai', 'dsh')
  removeOwnedPath(dshLink)
  linkDirectory(options.cliDir, dshLink)
  const hostLink = join(destinationModules, '@deepseek-ai', 'dsh-desktop-host')
  removeOwnedPath(hostLink)
  linkDirectory(options.hostDir, hostLink)
  const sharedPackages = [...new Set([...names, '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host'])].flatMap((name) => {
    const manifest = readManifest(join(destinationModules, name, 'package.json'))
    return typeof manifest.version === 'string' ? [{ name, version: manifest.version, path: `node_modules/${name}` }] : []
  })
  const runtime: DesktopRuntimeDescriptor = { schemaVersion: 1, release: options.release,
    platform: process.platform, arch: process.arch, sharedPackages, files: [] }
  writeFileSync(join(options.projectDir, DESKTOP_RUNTIME_FILE), `${JSON.stringify(runtime, undefined, 2)}\n`)
  for (const { packageDir, manifest } of profilePackages) {
    const packageLink = join(destinationModules, ...manifest.name!.split('/'))
    removeOwnedPath(packageLink)
    linkDirectory(packageDir, packageLink)
  }
  return options.projectDir
}
