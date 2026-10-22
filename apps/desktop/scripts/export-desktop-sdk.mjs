/** Export built Desktop inputs and executable packaging tools without a source-checkout dependency. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, cpSync, existsSync, globSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import ts from 'typescript'
import yaml from 'js-yaml'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
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
 * Resolve the installed package directory without bypassing the package's internal dependency graph.
 * @param name - Bare dependency package name.
 * @param from - Directory that owns the dependency import.
 * @returns Canonical installed package directory; missing dependencies throw.
 */
export function desktopSdkPackageDirectory(name, from) {
  let directory = resolve(from)
  for (;;) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Desktop SDK: missing dependency ${name} from ${from}`)
    directory = parent
  }
}

function copy(source, destination, options = {}) {
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true, ...options })
}

function moduleImports(source, path) {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true)
  const imports = []
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!ts.isImportDeclaration(node) || !node.importClause?.isTypeOnly) imports.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) imports.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return imports
}

function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
}

/**
 * Build a source-free, relocatable export from the exact prepared target owned by this checkout.
 * @param output - New SDK directory, retained as partial output if export fails.
 * @param target - Prepared build target; currently mac-arm64 only.
 */
export function exportDesktopSdk(output, target) {
  if (target !== 'mac-arm64') throw new Error('Desktop SDK: this exporter currently qualifies mac-arm64 only')
  const destination = resolve(output)
  if (existsSync(destination)) throw new Error(`Desktop SDK: output already exists: ${destination}`)
  const paths = desktopTargetBuildPaths(target)
  const clientBuild = readClientBuildRecord(repository)
  const runtimeCommit = capture('git', ['rev-parse', clientBuild.environment.DSH_CLIENT_COMMIT_HASH])
  for (const required of [join(app, 'lib/main.js'), paths.runtime, paths.electron, paths.packedDsh, paths.packedVendor, paths.packedLandlock]) {
    if (!existsSync(required)) throw new Error(`Desktop SDK: missing prepared input ${required}`)
  }
  mkdirSync(destination, { recursive: true })
  const copiedPackages = new Map()
  const packedPackages = new Map()
  for (const directory of [paths.packedDsh, paths.packedVendor, paths.packedLandlock]) {
    for (const filename of readdirSync(directory).filter(name => name.endsWith('.tgz'))) {
      const file = join(directory, filename)
      const manifest = JSON.parse(capture('tar', ['-xOzf', file, 'package/package.json']))
      packedPackages.set(manifest.name, { file, manifest })
    }
  }
  const linkPackage = (name, from, targetParent) => {
    const source = desktopSdkPackageDirectory(name, from)
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
      for (const dependency of new Set([
        ...Object.keys(installed.dependencies ?? {}), ...Object.keys(installed.optionalDependencies ?? {}), ...Object.keys(installed.peerDependencies ?? {}),
      ])) {
        let resolved
        try { resolved = desktopSdkPackageDirectory(dependency, source) } catch (error) {
          if (Object.hasOwn(installed.optionalDependencies ?? {}, dependency) || Object.hasOwn(installed.peerDependencies ?? {}, dependency)) continue
          throw error
        }
        if (resolved !== undefined) linkPackage(dependency, source, targetDirectory)
      }
    }
    const link = join(targetParent, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    if (!existsSync(link)) symlinkSync(relative(dirname(link), targetDirectory), link, 'dir')
    return json(join(targetDirectory, 'package.json')).version
  }
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
      } else linkPackage(packageName(specifier), dirname(source), destination)
    }
  }
  for (const directory of ['lib', 'renderer', 'resources', 'cli']) copy(join(app, directory), join(destination, 'apps/desktop', directory))
  for (const filename of ['LICENSE', 'pnpm-lock.yaml']) copy(join(repository, filename), join(destination, filename))
  const originalWorkspace = yaml.load(readFileSync(join(repository, 'pnpm-workspace.yaml'), 'utf8'))
  const workspaceManifests = globSync(originalWorkspace.packages.map(pattern => `${pattern}/package.json`), { cwd: repository })
  for (const [index, filename] of workspaceManifests.entries()) {
    const { name, version } = json(join(repository, filename))
    writeJson(join(destination, 'inventory', String(index), 'package.json'), { name, version })
  }
  writeFileSync(join(destination, 'pnpm-workspace.yaml'), yaml.dump({ packages: ['inventory/*'], patchedDependencies: originalWorkspace.patchedDependencies }))
  for (const patch of Object.values(originalWorkspace.patchedDependencies)) copy(join(repository, patch), join(destination, patch))
  const shellManifest = json(join(app, 'package.json'))
  const dependencies = Object.fromEntries(Object.keys(shellManifest.dependencies).map(name => [name, linkPackage(name, app, join(destination, 'apps/desktop'))]))
  writeJson(join(destination, 'apps/desktop/package.json'), {
    name: shellManifest.name, version: shellManifest.version, description: shellManifest.description,
    private: true, license: shellManifest.license, type: 'module', main: shellManifest.main, dependencies,
  })
  const toolDependencies = {}
  for (const name of ['electron-builder', 'electron', 'app-builder-lib', 'pnpm']) toolDependencies[name] = linkPackage(name, app, destination)
  for (const entry of [
    'apps/desktop/scripts/prepare-package-set.ts', 'apps/desktop/scripts/prepare-dsh.ts',
    'apps/desktop/scripts/electron-builder-config.mjs', 'apps/desktop/scripts/smoke-prepared-runtime.ts',
    'apps/desktop/src/runtime-tree.ts', 'apps/desktop/src/desktop-product.ts',
  ]) exportModule(join(repository, entry))
  for (const filename of ['runtime-payload-smoke.mjs', 'pnpm-smoke.mjs', 'office-conversion-inputs.py']) copy(join(app, 'tests/fixtures', filename), join(destination, 'apps/desktop/tests/fixtures', filename))
  copy(join(repository, 'scripts/primary-runtime/smoke.py'), join(destination, 'scripts/primary-runtime/smoke.py'))
  copy(join(app, 'scripts/macos-entitlements.plist'), join(destination, 'apps/desktop/scripts/macos-entitlements.plist'))
  for (const name of ['runtime', 'electron', 'packed']) copy(join(paths.root, name), join(destination, 'apps/desktop/.desktop-build/targets', target, name))
  for (const entry of ['prepare', 'verify']) copy(join(app, 'scripts/sdk', `${entry}.mjs`), join(destination, `${entry}.mjs`))
  writeJson(join(destination, 'package.json'), { name: '@deepseek-ai/dsh-desktop-sdk', version: shellManifest.version, private: true, type: 'module', dependencies: toolDependencies })
  const diff = capture('git', ['diff', 'HEAD', '--binary'])
  const untracked = capture('git', ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
  const manifest = {
    schemaVersion: 'dsh.desktop-sdk/1',
    source: {
      repository: capture('git', ['remote', 'get-url', 'origin']), commit: capture('git', ['rev-parse', 'HEAD']),
      tree: capture('git', ['rev-parse', 'HEAD^{tree}']), dirty: diff !== '' || untracked.length > 0,
      ...(diff === '' ? {} : { diffSha256: hash(diff) }),
      untrackedFiles: untracked.map(path => ({ path, sha256: hash(readFileSync(join(repository, path))) })),
    },
    version: shellManifest.version, target: { platform: 'darwin', arch: 'arm64' },
    runtimeSource: { commit: runtimeCommit, tree: capture('git', ['rev-parse', `${runtimeCommit}^{tree}`]), clientBuild },
    electronVersion: toolDependencies.electron, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    exporterSha256: hash(readFileSync(import.meta.filename)),
    commands: { prepare: ['prepare.mjs'], verify: ['verify.mjs'] },
    layout: { app: 'apps/desktop', build: 'apps/desktop/.desktop-build/targets/mac-arm64', electronBuilder: 'node_modules/electron-builder/cli.js' },
  }
  writeJson(join(destination, 'dsh-desktop-sdk.json'), manifest)
  console.log(JSON.stringify({ sdk: destination, source: manifest.source.commit, version: manifest.version }))
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, target: { type: 'string', default: 'mac-arm64' } } })
  if (!values.output) throw new Error('Usage: node apps/desktop/scripts/export-desktop-sdk.mjs --output <new-directory> [--target mac-arm64]')
  exportDesktopSdk(values.output, values.target)
}
