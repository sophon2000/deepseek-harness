/** Explicit local test selection never inherits publication settings. */
import { readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { LOCAL_TEST_METADATA, assertLocalTestRuntimeProduct } from '../src/local-test-package.mjs'

/** Check a private product and reject mixed release configuration.
 * @param {NodeJS.ProcessEnv} environment Parent build environment.
 * @returns {NodeJS.ProcessEnv} Validated fixed test identity for packaging subprocesses.
 */
export function localTestPackageEnvironment(environment) {
  if (environment.DSH_DESKTOP_UNSIGNED !== undefined && environment.DSH_DESKTOP_UNSIGNED !== '1') throw new Error('local-test: unsigned mode required')
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && /^(?:DSH_PACKAGING_|PACKAGE_TEST_RELEASE_ID$|DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_|UPDATE_|MANDATORY_UPDATE_|WINDOWS_|MACOS_)|DOWNLOAD_(?:TEST|PROD)_|(?:WIN_)?CSC_|APPLE_)/iu.test(name)) {
      throw new Error(`local-test: release configuration is not allowed (${name})`)
    }
  }
  if (environment.DSH_DESKTOP_PACKAGE_FLAVOR !== undefined && environment.DSH_DESKTOP_PACKAGE_FLAVOR !== 'local-test') throw new Error('local-test: invalid packaging flavor')
  const root = environment.DSH_DESKTOP_PRODUCT_ROOT
  if (!root || !isAbsolute(root)) throw new Error('local-test: explicit absolute local product root required')
  const product = JSON.parse(readFileSync(join(root, 'desktop-product.json'), 'utf8'))
  assertLocalTestRuntimeProduct(product)
  if (product.schemaVersion !== 2 || product.product?.mode !== 'local') throw new Error('local-test: product mode must be local')
  return { ...environment, DSH_DESKTOP_PACKAGE_FLAVOR: 'local-test',
    DSH_DESKTOP_APP_ID: LOCAL_TEST_METADATA.appId, DSH_DESKTOP_UNSIGNED: '1' }
}

/** Validate the subprocess identity without admitting a release-flavor downgrade.
 * @param {NodeJS.ProcessEnv} environment Build subprocess environment.
 * @param {string} platform Target OS.
 * @param {boolean} unsigned Requested signing mode.
 * @returns {boolean} Whether the explicit local test flavor is selected.
 */
export function isLocalTestPackaging(environment, platform, unsigned) {
  if (environment.DSH_DESKTOP_PACKAGE_FLAVOR === undefined) return false
  if (environment.DSH_DESKTOP_PACKAGE_FLAVOR !== 'local-test' || platform !== 'win32' || !unsigned
    || environment.DSH_DESKTOP_APP_ID !== LOCAL_TEST_METADATA.appId) throw new Error('local-test: incompatible target or identity')
  const { DSH_DESKTOP_APP_ID: _appId, DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: skip,
    CSC_IDENTITY_AUTO_DISCOVERY: discovery, ...request } = environment
  if (skip !== undefined && skip !== '0') throw new Error('local-test: incompatible notarization mode')
  if (discovery !== undefined && discovery !== 'false') throw new Error('local-test: signing discovery must remain disabled')
  localTestPackageEnvironment(request)
  return true
}
