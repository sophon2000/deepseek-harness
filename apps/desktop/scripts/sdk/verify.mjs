/** Exercise a prepared SDK runtime without reading the original source checkout or user profile. */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { prepared: { type: 'string' }, app: { type: 'string' } } })
if (!values.prepared) throw new Error('Usage: node verify.mjs --prepared <build-directory> [--app <application.app>]')
const root = resolve(values.prepared)
const manifest = JSON.parse(readFileSync(join(root, 'dsh-desktop-sdk.json'), 'utf8'))
const build = join(root, manifest.layout.build)
const { verifyDesktopRuntime } = await import(pathToFileURL(join(root, 'apps/desktop/src/runtime-tree.js')).href)
const { smokePreparedRuntime } = await import(pathToFileURL(join(root, 'apps/desktop/scripts/smoke-prepared-runtime.js')).href)
const application = values.app === undefined ? undefined : resolve(values.app)
const resources = application === undefined ? build : join(application, 'Contents/Resources')
const executable = application === undefined ? join(build, 'electron/Electron.app/Contents/MacOS/Electron')
  : join(application, 'Contents/MacOS', execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleExecutable', join(application, 'Contents/Info.plist')], { encoding: 'utf8' }).trim())
const descriptor = await verifyDesktopRuntime(join(resources, 'dsh'), manifest.version, manifest.target)
await smokePreparedRuntime(join(resources, 'dsh'), executable, join(resources, 'runtime'), descriptor)
console.log(JSON.stringify({ verified: application ?? root, version: manifest.version, target: manifest.target }))
