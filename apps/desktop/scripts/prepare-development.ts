/** Prepare a caller-owned development profile without building or launching an Electron shell. */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { prepareDevelopmentProject } from './development-project.ts'
import { resolveDesktopBuildTarget } from './desktop-build-paths.mjs'

/** Explicit source adapter inputs; the caller owns and removes the fresh output directory. */
export interface PrepareDevelopmentOptions {
  readonly projectDir: string
  readonly primaryRuntimeDir: string
  readonly profilePackageDirs: readonly string[]
  readonly output: string
}

function manifestVersion(path: string): string {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || !('version' in value) || typeof value.version !== 'string') {
    throw new Error(`development source adapter: missing package version: ${path}`)
  }
  return value.version
}

/**
 * Link built source packages and a native prepared runtime into a fresh disposable profile.
 * @param options - Explicit locations; projectDir and output must not already exist.
 * @returns Versioned launch metadata; no source package or native runtime is modified.
 */
export function prepareDevelopment(options: PrepareDevelopmentOptions) {
  const repository = resolve(import.meta.dirname, '../../..')
  const app = join(repository, 'apps/desktop')
  for (const path of [options.projectDir, options.output, options.primaryRuntimeDir, ...options.profilePackageDirs]) {
    if (!isAbsolute(path)) throw new Error('development source adapter: all paths must be absolute')
  }
  if (existsSync(options.projectDir) || existsSync(options.output)) {
    throw new Error('development source adapter: project and receipt must be fresh caller-owned paths')
  }
  const primaryRuntimeDir = realpathSync(options.primaryRuntimeDir)
  const runtime = parsePrimaryRuntime(JSON.parse(readFileSync(join(primaryRuntimeDir, 'runtime.json'), 'utf8')))
  if (runtime.platform !== process.platform || runtime.arch !== process.arch) {
    throw new Error('development source adapter: prepared runtime must match the native host')
  }
  const version = manifestVersion(join(app, 'package.json'))
  if (runtime.desktopVersion !== version || runtime.node === undefined || runtime.pnpm === undefined) {
    throw new Error('development source adapter: prepared runtime release or Node/pnpm inventory does not match source')
  }
  const runtimePaths = workspaceDependencyPaths(primaryRuntimeDir, runtime)
  const pnpmEntry = runtimePaths.pnpm
  if (pnpmEntry === undefined || runtimePaths.node === undefined) throw new Error('development source adapter: Node/pnpm entry is missing')
  const dependencyDir = join(repository, 'node_modules/.pnpm/node_modules')
  const sourceShellDependencies = join(app, 'node_modules')
  const nodeBin = join(app, 'scripts/node-bin')
  const modules = ['runtime-tree', 'release', 'host-protocol', 'desktop-product', 'core-package-set', 'project-profile']
  const required = [pnpmEntry, runtimePaths.node, runtimePaths.python, dependencyDir, sourceShellDependencies,
    join(nodeBin, process.platform === 'win32' ? 'node.cmd' : 'node'),
    join(repository, 'apps/cli/lib/bin.js'), join(repository, 'apps/desktop-host/lib/index.js'),
    ...modules.flatMap(name => [join(app, 'lib/types', `${name}.js`), join(app, 'lib/types', `${name}.d.ts`)])]
  for (const path of required) if (!existsSync(path)) throw new Error(`development source adapter: missing built input ${path}; prepare source artifacts and native runtime explicitly`)
  prepareDevelopmentProject({ projectDir: options.projectDir, cliDir: join(repository, 'apps/cli'),
    hostDir: join(repository, 'apps/desktop-host'), dependencyDir,
    release: { schemaVersion: 1, version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: runtime.node, pnpmVersion: runtime.pnpm },
    target: resolveDesktopBuildTarget({}, process.platform, process.arch), profilePackageDirs: options.profilePackageDirs })
  const runtimeContractDir = join(options.projectDir, '.shell-runtime-contract')
  mkdirSync(runtimeContractDir)
  for (const name of modules) {
    const source = relative(runtimeContractDir, join(app, 'lib/types', `${name}.js`)).replaceAll('\\', '/')
    if (isAbsolute(source) || /^[A-Za-z]:/u.test(source)) throw new Error('development source adapter: source and output must share a filesystem volume')
    const specifier = source.startsWith('.') ? source : `./${source}`
    const forwarding = `export * from ${JSON.stringify(specifier)};\n`
    writeFileSync(join(runtimeContractDir, `${name}.js`), forwarding)
    writeFileSync(join(runtimeContractDir, `${name}.d.ts`), forwarding)
  }
  writeFileSync(join(runtimeContractDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime-contract',
    version, private: true, type: 'module', exports: Object.fromEntries(modules.map(name => [`./${name}`,
      { types: `./${name}.d.ts`, default: `./${name}.js` }])) }, null, 2) + '\n')
  const shellDependencyDir = join(options.projectDir, '.shell-dependencies/node_modules')
  mkdirSync(shellDependencyDir, { recursive: true })
  for (const entry of readdirSync(sourceShellDependencies)) {
    if (entry.startsWith('.')) continue
    const names = entry.startsWith('@') ? readdirSync(join(sourceShellDependencies, entry)).map(name => `${entry}/${name}`) : [entry]
    for (const name of names) {
      if (name === '@deepseek-ai/dsh-desktop-runtime-contract') continue
      const destination = join(shellDependencyDir, name)
      mkdirSync(dirname(destination), { recursive: true })
      symlinkSync(realpathSync(join(sourceShellDependencies, name)), destination, process.platform === 'win32' ? 'junction' : 'dir')
    }
  }
  const facadeLink = join(shellDependencyDir, '@deepseek-ai/dsh-desktop-runtime-contract')
  mkdirSync(dirname(facadeLink), { recursive: true })
  symlinkSync(runtimeContractDir, facadeLink, process.platform === 'win32' ? 'junction' : 'dir')
  const receipt = { schemaVersion: 'dsh.desktop-development/1', projectDir: options.projectDir,
    primaryRuntimeDir, pnpmEntry, version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    dependencyDir, shellDependencyDir, runtimeContractDir, nodeBin }
  mkdirSync(dirname(options.output), { recursive: true })
  writeFileSync(options.output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const { values } = parseArgs({ options: { 'project-dir': { type: 'string' }, output: { type: 'string' },
      'primary-runtime-dir': { type: 'string' }, 'profile-package': { type: 'string', multiple: true, default: [] } } })
    const primaryRuntimeDir = values['primary-runtime-dir'] ?? process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
    if (!values['project-dir'] || !values.output || !primaryRuntimeDir) {
      throw new Error('Usage: prepare-development.ts --project-dir FRESH_PATH --output FRESH_JSON --primary-runtime-dir PREPARED_RUNTIME [--profile-package PATH]')
    }
    prepareDevelopment({ projectDir: values['project-dir'], output: values.output, primaryRuntimeDir,
      profilePackageDirs: values['profile-package'] })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
