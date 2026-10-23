/** Export built Desktop inputs and executable packaging tools without a source-checkout dependency. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, cpSync, existsSync, globSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isBuiltin } from 'node:module'
import { parseArgs } from 'node:util'
import ts from 'typescript'
import yaml from 'js-yaml'
import { desktopTargetBuildPaths, desktopTargetPlatform } from './desktop-build-paths.mjs'
import { DESKTOP_SDK_API, writeDesktopSdkApi } from './sdk-api.mjs'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../lib/types/host-protocol.js'
import { readClientBuildRecord } from '../../../scripts/client-build-environment.ts'

const repository = resolve(import.meta.dirname, '../../..')
const app = join(repository, 'apps/desktop')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: repository, stdio: 'inherit', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Desktop SDK: ${executable} failed (${result.status ?? result.signal})`)
  return result.stdout
}

function capture(executable, args) {
  return command(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

/**
 * Compile an executable tooling module, preserving its resource-relative location.
 * @param source - Tooling source with local TypeScript imports.
 * @param filename - Source filename used to select TypeScript parsing rules.
 * @returns Executable ESM with local JavaScript imports.
 */
export function compileDesktopSdkModule(source, filename) {
  const replaced = source.replaceAll('../../../packages/skill/tool-workspace-dependencies/src/index.ts', '@deepseek-ai/dsh-tool-workspace-dependencies')
  return ts.transpileModule(replaced, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
      rewriteRelativeImportExtensions: true, sourceMap: false,
    },
  }).outputText
}

/**
 * Resolve an installed dependency or the nearest package scope's exported self-reference.
 * @param name - Bare dependency package name.
 * @param from - Directory that owns the dependency import.
 * @returns Canonical installed package directory; missing dependencies throw.
 */
export function desktopSdkPackageDirectory(name, from) {
  let scope = resolve(from)
  while (basename(scope) !== 'node_modules') {
    const manifestPath = join(scope, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = json(manifestPath)
      if (manifest.name === name && manifest.exports !== undefined && manifest.exports !== null) return realpathSync(scope)
      break
    }
    const parent = dirname(scope)
    if (parent === scope) break
    scope = parent
  }
  let directory = resolve(from)
  for (;;) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Desktop SDK: missing dependency ${name} from ${from}`)
    directory = parent
  }
}

/**
 * Read published executable and declaration imports without consulting unpublished source files.
 * @param directory - Extracted workspace package directory.
 * @param pattern - Published output glob for runtime or declaration modules.
 * @param includeTypes - Whether declaration-only imports participate.
 * @returns Referenced bare package names, excluding Node builtins and local files.
 */
export function desktopSdkPublishedImports(directory, pattern, includeTypes = false) {
  return globSync(pattern, { cwd: directory }).flatMap(path => moduleImports(readFileSync(join(directory, path), 'utf8'), path, includeTypes))
    .filter(name => !name.startsWith('.') && !isBuiltin(name)).map(packageName)
}

/**
 * Resolve declaration-only imports through the same workspace and DefinitelyTyped inputs as the producer compiler.
 * @param name - Bare package referenced by a generated declaration.
 * @param owner - Package directory owning the declaration.
 * @param workspaces - Exact known workspace package directories.
 * @returns The package name and directory to link into the exported declaration closure.
 */
export function desktopSdkDeclarationDependency(name, owner, workspaces = new Map()) {
  if (workspaces.has(name)) return { name, directory: workspaces.get(name) }
  const typesName = `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`
  return { name: typesName, directory: desktopSdkPackageDirectory(typesName, owner) }
}

function copy(source, destination, options = {}) {
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true, ...options })
}

function moduleImports(source, path, includeTypes = false) {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true)
  const imports = []
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (includeTypes || !ts.isImportDeclaration(node) || !node.importClause?.isTypeOnly) imports.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) imports.push(node.arguments[0].text)
    if (includeTypes && ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) imports.push(node.argument.literal.text)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return imports
}

function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
}

/**
 * Select optional packages using npm platform allow/deny lists, including Linux libc.
 * @param manifest - Installed dependency's package metadata.
 * @param target - Producer-matched platform and architecture.
 * @returns Whether this dependency is eligible for the SDK's native tooling closure.
 */
export function desktopSdkOptionalPackageMatches(manifest, target) {
  const matches = (values, actual) => values === undefined || !values.includes(`!${actual}`)
    && (values.includes('any') || values.every(value => value.startsWith('!')) || values.includes(actual))
  return matches(manifest.os, target.platform) && matches(manifest.cpu, target.arch)
    && (target.platform !== 'linux' || matches(manifest.libc, 'glibc'))
}

/**
 * Locate a producer tarball inside the SDK's copied target tree.
 * @param file - Tarball in the producer's packed directory, including an external build root.
 * @param packedRoot - Producer target's packed directory.
 * @param target - Target directory name inside the SDK.
 * @returns Portable archive-relative tarball path; files outside the packed directory are rejected.
 */
export function desktopSdkPackedPath(file, packedRoot, target) {
  const local = relative(packedRoot, file)
  if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`Desktop SDK: tarball outside packed directory: ${file}`)
  }
  return join('apps/desktop/.desktop-build/targets', target, 'packed', local).split(sep).join('/')
}

/**
 * Create the recursive compiler for an SDK's executable tooling closure.
 * @param destination - SDK root receiving modules in their repository-relative locations.
 * @param linkDependency - Link a bare package name from its importing source directory into the SDK.
 * @returns Function that exports an entry and its local imports once, rejecting missing or external modules.
 */
export function createDesktopSdkToolingExporter(destination, linkDependency) {
  const exportedModules = new Set()
  const exportModule = source => {
    const local = relative(repository, source)
    if (local.startsWith('..') || isAbsolute(local)) throw new Error(`Desktop SDK: module outside repository: ${source}`)
    if (exportedModules.has(local)) return
    exportedModules.add(local)
    const extension = extname(source)
    if (!['.ts', '.mjs', '.js', '.cjs'].includes(extension)) { copy(source, join(destination, local)); return }
    const sourceText = readFileSync(source, 'utf8').replaceAll('../../../packages/skill/tool-workspace-dependencies/src/index.ts', '@deepseek-ai/dsh-tool-workspace-dependencies')
    const compiled = extension === '.ts' ? compileDesktopSdkModule(sourceText, source) : sourceText
    const emitted = local.replace(/\.ts$/u, '.js')
    mkdirSync(dirname(join(destination, emitted)), { recursive: true })
    writeFileSync(join(destination, emitted), compiled)
    for (const specifier of moduleImports(sourceText, source)) {
      if (specifier.startsWith('node:') || ['fs', 'path', 'os', 'crypto', 'util', 'child_process', 'module', 'events', 'stream', 'url'].includes(specifier)) continue
      if (specifier.startsWith('.')) {
        const required = resolve(dirname(source), specifier)
        if (existsSync(required)) exportModule(required)
        else throw new Error(`Desktop SDK: missing tooling module ${required}`)
      } else linkDependency(packageName(specifier), dirname(source))
    }
  }
  return exportModule
}

/**
 * Require the producer installation to match the SDK's native tool dependencies.
 * @param platform - Operating system owning the installed dependency closure.
 * @param arch - Architecture owning the installed dependency closure.
 * @param target - Requested SDK target, which must match the producer.
 */
export function assertDesktopSdkExportHost(platform, arch, target = 'mac-arm64') {
  if (!['mac-arm64', 'linux-x64', 'win-x64'].includes(target)) throw new Error('Desktop SDK: unsupported export target')
  const expected = desktopTargetPlatform(target)
  if (platform !== expected.platform || arch !== expected.arch) {
    throw new Error(`Desktop SDK: export requires a ${expected.platform}/${expected.arch} producer installation; installed native tooling cannot be copied from another host`)
  }
}

/**
 * Require official client artifacts and both release manifests to identify the clean source being exported.
 * @param source - Current Git commit, porcelain status and root/Desktop package versions.
 * @param environment - Artifact-verified client build environment.
 * @param runtimeCommit - Full Git commit resolved from the recorded client commit.
 */
export function assertDesktopSdkBuildIdentity(source, environment, runtimeCommit) {
  if (source.status !== '') throw new Error('Desktop SDK: source must be clean before export')
  if (environment.DSH_CLIENT_GIT_DIRTY !== undefined) throw new Error('Desktop SDK: client artifacts were built from a dirty source')
  if (environment.DSH_CLIENT_BUILD_PROFILE !== 'official') throw new Error('Desktop SDK: client artifacts require the official build profile')
  if (runtimeCommit !== source.commit) throw new Error('Desktop SDK: client artifact commit differs from current source; rebuild after committing')
  if (source.version !== source.desktopVersion || environment.DSH_CLIENT_VERSION !== source.version) {
    throw new Error('Desktop SDK: root, Desktop and client artifact versions must match')
  }
}

/**
 * Build a source-free, relocatable export from the exact prepared target owned by this checkout.
 * @param output - New SDK directory, retained as partial output if export fails.
 * @param target - Prepared build target; mac-arm64, linux-x64 or win-x64.
 */
export function exportDesktopSdk(output, target) {
  assertDesktopSdkExportHost(process.platform, process.arch, target)
  if (target === 'linux-x64' && !process.report.getReport().header.glibcVersionRuntime) throw new Error('Desktop SDK: linux-x64 requires a glibc producer installation')
  const platform = desktopTargetPlatform(target)
  const destination = resolve(output)
  if (existsSync(destination)) throw new Error(`Desktop SDK: output already exists: ${destination}`)
  const paths = desktopTargetBuildPaths(target)
  const sourceCommit = capture('git', ['rev-parse', 'HEAD'])
  const sourceTree = capture('git', ['rev-parse', 'HEAD^{tree}'])
  const shellManifest = json(join(app, 'package.json'))
  const clientBuild = readClientBuildRecord(repository)
  const runtimeCommit = capture('git', ['rev-parse', clientBuild.environment.DSH_CLIENT_COMMIT_HASH])
  assertDesktopSdkBuildIdentity({
    commit: sourceCommit, status: capture('git', ['status', '--porcelain=v1', '--untracked-files=normal']),
    version: json(join(repository, 'package.json')).version, desktopVersion: shellManifest.version,
  }, clientBuild.environment, runtimeCommit)
  for (const required of [paths.runtime, paths.electron, paths.packedDsh, paths.packedVendor, paths.packedLandlock]) {
    if (!existsSync(required)) throw new Error(`Desktop SDK: missing prepared input ${required}`)
  }
  mkdirSync(destination, { recursive: true })
  const copiedPackages = new Map()
  const workspacePackages = new Map()
  const packedPackages = new Map()
  for (const directory of [paths.packedDsh, paths.packedVendor, paths.packedLandlock]) {
    for (const filename of readdirSync(directory).filter(name => name.endsWith('.tgz'))) {
      const file = join(directory, filename)
      const manifest = JSON.parse(capture('tar', ['-xOzf', file, 'package/package.json']))
      packedPackages.set(manifest.name, { file, manifest })
    }
  }
  const linkPackage = (name, from, targetParent, declaredSource) => {
    const source = declaredSource ?? desktopSdkPackageDirectory(name, from)
    let targetDirectory = copiedPackages.get(source)
    if (targetDirectory === undefined) {
      const installed = json(join(source, 'package.json'))
      targetDirectory = join(destination, 'node_modules/.sdk', `${installed.name.replaceAll('/', '+')}@${installed.version}-${hash(relative(repository, source)).slice(0, 12)}`)
      copiedPackages.set(source, targetDirectory)
      mkdirSync(targetDirectory, { recursive: true })
      const workspacePackage = !source.includes(`${sep}node_modules${sep}`) && source.startsWith(repository + sep)
      if (workspacePackage) {
        const packed = packedPackages.get(installed.name)
        if (packed === undefined) throw new Error(`Desktop SDK: no packed artifact for ${installed.name}`)
        command('tar', ['-xzf', packed.file, '--strip-components', '1', '-C', targetDirectory])
      } else {
        copy(source, targetDirectory, { filter: file => {
          const parts = relative(source, file).split(sep)
          return parts[0] !== 'node_modules' && !file.endsWith('.map')
        } })
      }
      // Workspace declarations retain type-only imports that are absent from runtime dependencies.
      // Third-party packages own their published dependency graph; do not traverse unrelated test declarations.
      const declarations = workspacePackage ? desktopSdkPublishedImports(targetDirectory, '**/*.d.ts', true) : []
      // Client packages intentionally publish bundler externals as development inputs in this monorepo.
      const runtimeImports = workspacePackage ? desktopSdkPublishedImports(targetDirectory, 'lib/**/*.js') : []
      for (const dependency of new Set([
        ...Object.keys(installed.dependencies ?? {}), ...Object.keys(installed.optionalDependencies ?? {}), ...Object.keys(installed.peerDependencies ?? {}),
        ...declarations, ...runtimeImports,
      ])) {
        if (dependency === installed.name) continue
        let resolved
        let resolvedName = dependency
        try { resolved = desktopSdkPackageDirectory(dependency, source) } catch (error) {
          if (declarations.includes(dependency)) {
            const declared = desktopSdkDeclarationDependency(dependency, source, workspacePackages)
            resolved = declared.directory
            resolvedName = declared.name
          }
          else if (Object.hasOwn(installed.optionalDependencies ?? {}, dependency) || Object.hasOwn(installed.peerDependencies ?? {}, dependency)) continue
          else throw error
        }
        if (resolved !== undefined) {
          const dependencyManifest = json(join(resolved, 'package.json'))
          if (Object.hasOwn(installed.optionalDependencies ?? {}, dependency)
            && !desktopSdkOptionalPackageMatches(dependencyManifest, platform)) continue
          linkPackage(resolvedName, source, targetDirectory, resolved)
        }
      }
    }
    const link = join(targetParent, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    if (!existsSync(link)) symlinkSync(relative(dirname(link), targetDirectory), link, 'dir')
    return json(join(targetDirectory, 'package.json')).version
  }
  const exportModule = createDesktopSdkToolingExporter(destination, (name, from) => linkPackage(name, from, destination))
  for (const filename of ['LICENSE', 'pnpm-lock.yaml']) copy(join(repository, filename), join(destination, filename))
  const originalWorkspace = yaml.load(readFileSync(join(repository, 'pnpm-workspace.yaml'), 'utf8'))
  const workspaceManifests = globSync(originalWorkspace.packages.map(pattern => `${pattern}/package.json`), { cwd: repository })
  for (const [index, filename] of workspaceManifests.entries()) {
    const { name, version } = json(join(repository, filename))
    workspacePackages.set(name, dirname(join(repository, filename)))
    writeJson(join(destination, 'inventory', String(index), 'package.json'), { name, version })
  }
  writeFileSync(join(destination, 'pnpm-workspace.yaml'), yaml.dump({ packages: ['inventory/*'], patchedDependencies: originalWorkspace.patchedDependencies }))
  for (const patch of Object.values(originalWorkspace.patchedDependencies)) copy(join(repository, patch), join(destination, patch))
  const shellBuild = join(destination, 'shell-build')
  const shellRoots = [...new Set([...Object.keys(shellManifest.dependencies), ...Object.keys(shellManifest.devDependencies).filter(name => name.startsWith('@deepseek-ai/'))])]
  for (const name of shellRoots) linkPackage(name, app, shellBuild)
  for (const name of Object.keys(shellManifest.dependencies)) linkPackage(name, app, join(destination, 'apps/desktop'))
  const shellDependencies = Object.fromEntries(Object.keys(shellManifest.dependencies).map(name => [name, json(join(desktopSdkPackageDirectory(name, app), 'package.json')).version]))
  writeJson(join(destination, 'apps/desktop/package.json'), { name: '@deepseek-ai/dsh-runtime-preparation', version: shellManifest.version, private: true, type: 'module', dependencies: shellDependencies })
  const contractName = '@deepseek-ai/dsh-desktop-runtime-contract'
  linkPackage(contractName, app, destination)
  const contractRoot = copiedPackages.get(desktopSdkPackageDirectory(contractName, app))
  if (contractRoot === undefined) throw new Error('Desktop SDK: runtime contract was not exported')
  const toolDependencies = {}
  for (const name of ['electron-builder', 'electron', 'app-builder-lib', 'pnpm']) toolDependencies[name] = linkPackage(name, app, destination)
  for (const entry of [
    'apps/desktop/scripts/prepare-package-set.ts', 'apps/desktop/scripts/prepare-dsh.ts',
    'apps/desktop/scripts/verify-packaged-runtime.mjs', 'apps/desktop/scripts/smoke-prepared-runtime.ts',
    'apps/desktop/src/runtime-tree.ts', 'apps/desktop/src/desktop-product.ts', 'apps/desktop/src/project-profile.ts',
  ]) exportModule(join(repository, entry))
  writeDesktopSdkApi(destination)
  for (const filename of ['runtime-payload-smoke.mjs', 'pnpm-smoke.mjs', 'office-conversion-inputs.py']) copy(join(app, 'tests/fixtures', filename), join(destination, 'apps/desktop/tests/fixtures', filename))
  copy(join(repository, 'scripts/primary-runtime/smoke.py'), join(destination, 'scripts/primary-runtime/smoke.py'))
  for (const name of ['runtime', 'electron', 'packed']) copy(join(paths.root, name), join(destination, 'apps/desktop/.desktop-build/targets', target, name), {
    filter: file => name !== 'runtime' || !['cli'].some(path => {
      const local = relative(join(paths.root, name), file).split(sep).join('/')
      return local === path || local.startsWith(path + '/')
    }),
  })
  const packages = Object.fromEntries([...packedPackages.entries()].map(([name, { file, manifest }]) => [name, {
    version: manifest.version, tarball: desktopSdkPackedPath(file, join(paths.root, 'packed'), target), sha256: hash(readFileSync(file)),
  }]))
  writeJson(join(destination, 'shell-dependencies.json'), { schemaVersion: 'dsh.shell-dependencies/1', roots: shellRoots, packages,
    nodeModules: 'shell-build/node_modules', contract: { name: contractName, directory: relative(destination, contractRoot).split(sep).join('/') } })
  for (const entry of ['prepare', 'verify']) copy(join(app, 'scripts/sdk', `${entry}.mjs`), join(destination, `${entry}.mjs`))
  writeJson(join(destination, 'package.json'), { name: '@deepseek-ai/dsh-desktop-sdk', version: shellManifest.version, private: true, type: 'module', dependencies: toolDependencies })
  const diff = capture('git', ['diff', 'HEAD', '--binary'])
  const untracked = capture('git', ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
  const manifest = {
    schemaVersion: 'dsh.desktop-sdk/2',
    source: {
      repository: capture('git', ['remote', 'get-url', 'origin']), commit: sourceCommit,
      tree: sourceTree, dirty: diff !== '' || untracked.length > 0,
      ...(diff === '' ? {} : { diffSha256: hash(diff) }),
      untrackedFiles: untracked.map(path => ({ path, sha256: hash(readFileSync(join(repository, path))) })),
    },
    version: shellManifest.version, target: platform,
    runtimeSource: { commit: runtimeCommit, tree: capture('git', ['rev-parse', `${runtimeCommit}^{tree}`]), clientBuild },
    electronVersion: toolDependencies.electron, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    exporterSha256: hash(readFileSync(import.meta.filename)),
    commands: { prepare: ['prepare.mjs'], verify: ['verify.mjs'] },
    sdkApi: DESKTOP_SDK_API,
    runtimeContract: { profileModule: DESKTOP_SDK_API.profile },
    shellBuild: { dependencies: 'shell-dependencies.json', nodeModules: 'shell-build/node_modules', runtimeContract: contractName },
    layout: { app: 'apps/desktop', build: `apps/desktop/.desktop-build/targets/${target}`, electronBuilder: 'node_modules/electron-builder/cli.js' },
  }
  assertRuntimeSdkLayout(destination)
  writeJson(join(destination, 'dsh-desktop-sdk.json'), manifest)
  console.log(JSON.stringify({ sdk: destination, source: manifest.source.commit, version: manifest.version }))
}

/**
 * Reject shell executables and product assets in the runtime-only SDK.
 * @param root - Completed export directory, before its manifest is committed.
 */
export function assertRuntimeSdkLayout(root) {
  for (const path of ['apps/desktop/lib', 'apps/desktop/renderer', 'apps/desktop/resources', 'apps/desktop/cli',
    ...['mac-arm64', 'linux-x64', 'win-x64'].map(target => `apps/desktop/.desktop-build/targets/${target}/runtime/cli`)]) {
    if (existsSync(join(root, path))) throw new Error(`Desktop Runtime SDK: shell-owned path is forbidden: ${path}`)
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, target: { type: 'string', default: 'mac-arm64' } } })
  if (!values.output) throw new Error('Usage: node apps/desktop/scripts/export-desktop-sdk.mjs --output <new-directory> [--target mac-arm64|linux-x64|win-x64]')
  exportDesktopSdk(values.output, values.target)
}
