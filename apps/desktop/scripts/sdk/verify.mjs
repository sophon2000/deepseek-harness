/** Exercise a prepared SDK runtime without reading the original source checkout or user profile. */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { prepared: { type: 'string' }, app: { type: 'string' }, executable: { type: 'string' } } })
if (!values.prepared) throw new Error('Usage: node verify.mjs --prepared <build-directory> [--app <application.app>]')
const root = resolve(values.prepared)
const manifest = JSON.parse(readFileSync(join(root, 'dsh-desktop-sdk.json'), 'utf8'))
if (manifest.schemaVersion !== 'dsh.desktop-sdk/2' || manifest.target.platform !== process.platform || manifest.target.arch !== process.arch) throw new Error('Desktop SDK: target does not match this verification host')
if (!['darwin', 'linux', 'win32'].includes(manifest.target.platform)) throw new Error('Desktop SDK: unsupported verification target')
const build = join(root, manifest.layout.build)
const { verifyDesktopRuntime } = await import(pathToFileURL(join(root, 'apps/desktop/src/runtime-tree.js')).href)
const { smokePreparedRuntime } = await import(pathToFileURL(join(root, 'apps/desktop/scripts/smoke-prepared-runtime.js')).href)
const application = values.app === undefined ? undefined : resolve(values.app)
const linux = manifest.target.platform === 'linux'
const windows = manifest.target.platform === 'win32'
if ((linux || windows) && application !== undefined && (values.executable === undefined || !(windows ? /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u : /^[A-Za-z0-9][A-Za-z0-9._-]*$/u).test(values.executable)
  || values.executable.endsWith('.') || (windows && !values.executable.endsWith('.exe')))) throw new Error('Desktop SDK: packaged verification requires --executable <filename>')
const resources = application === undefined ? build : join(application, linux || windows ? 'resources' : 'Contents/Resources')
const executable = application === undefined ? join(build, linux ? 'electron/electron' : windows ? 'electron/electron.exe' : 'electron/Electron.app/Contents/MacOS/Electron')
  : linux || windows ? join(application, values.executable)
    : join(application, 'Contents/MacOS', execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleExecutable', join(application, 'Contents/Info.plist')], { encoding: 'utf8' }).trim())
const descriptor = await verifyDesktopRuntime(join(resources, 'dsh'), manifest.version, manifest.target)
await smokePreparedRuntime(join(resources, 'dsh'), executable, join(resources, 'runtime'), descriptor)
console.log(JSON.stringify({ verified: application ?? root, version: manifest.version, target: manifest.target }))
