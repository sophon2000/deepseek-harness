/** Compose a fixed Desktop Runtime SDK and product payload into a new, isolated build directory. */
import { spawnSync } from 'node:child_process'
import { constants, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const sdk = import.meta.dirname
const { values } = parseArgs({ options: { product: { type: 'string' }, output: { type: 'string' }, 'app-id': { type: 'string' }, 'runtime-lock': { type: 'string' } } })
if (!values.product || !values.output || !values['app-id']) throw new Error('Usage: node prepare.mjs --product <payload> --output <new-directory> --app-id <id> [--runtime-lock <lockfile>]')
const output = resolve(values.output)
const product = resolve(values.product)
const inside = relative(sdk, output)
if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) throw new Error('Desktop SDK: output must be outside the immutable SDK directory')
if (existsSync(output)) throw new Error(`Desktop SDK: output already exists: ${output}`)
const manifest = JSON.parse(readFileSync(join(sdk, 'dsh-desktop-sdk.json'), 'utf8'))
if (manifest.schemaVersion !== 'dsh.desktop-sdk/2' || manifest.target.platform !== process.platform || manifest.target.arch !== process.arch) throw new Error('Desktop SDK: target does not match this preparation host')
if (!existsSync(join(product, 'desktop-product.json'))) throw new Error('Desktop SDK: product payload descriptor is missing')
mkdirSync(dirname(output), { recursive: true })
cpSync(sdk, output, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true })
const environment = {
  ...process.env, DSH_DESKTOP_TARGET_PLATFORM: manifest.target.platform, DSH_DESKTOP_TARGET_ARCH: manifest.target.arch,
  DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: values['app-id'], DSH_DESKTOP_PRODUCT_ROOT: product,
  DSH_DESKTOP_RUNTIME_LOCK_OUTPUT: join(output, 'runtime-pnpm-lock.yaml'),
}
delete environment.DSH_DESKTOP_RUNTIME_LOCK
for (const key of ['DSH_DESKTOP_BUILD_ROOT', 'DSH_DESKTOP_DOWNLOAD_CACHE', 'DSH_DESKTOP_PNPM_STORE_ROOT']) delete environment[key]
if (values['runtime-lock'] !== undefined) environment.DSH_DESKTOP_RUNTIME_LOCK = resolve(values['runtime-lock'])
for (const script of ['prepare-package-set.js', 'prepare-dsh.js']) {
  const result = spawnSync(process.execPath, [join(output, 'apps/desktop/scripts', script)], { cwd: output, env: environment, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Desktop SDK: ${script} failed (${result.status ?? result.signal}); partial output retained at ${output}`)
}
writeFileSync(join(output, 'desktop-preparation.json'), `${JSON.stringify({ schemaVersion: 'dsh.desktop-preparation/1', version: manifest.version, target: manifest.target, appId: values['app-id'] }, null, 2)}\n`)
console.log(JSON.stringify({ prepared: output, app: join(output, manifest.layout.app) }))
