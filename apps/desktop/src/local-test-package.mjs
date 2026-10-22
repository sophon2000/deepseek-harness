/** Closed installed identity for the opt-in, per-user Video Harness test application. */
export const LOCAL_TEST_METADATA = Object.freeze({
  schemaVersion: 'dsh.desktop.local-test/1',
  productId: 'video-harness', mode: 'local-single-user', updates: 'none',
  appId: 'ai.videoharness.localtest', name: 'video-harness-local-test',
  productName: 'Video Harness Local Test', homeName: 'Video Harness Local Test',
  protocol: 'videoharness-localtest',
})

/** Validate installed test identity before opening any application data.
 * @param {unknown} manifest Parsed application package metadata.
 * @returns {typeof LOCAL_TEST_METADATA | undefined} Explicit test identity, or ordinary application mode.
 */
export function readLocalTestPackage(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('local-test: invalid application manifest')
  const marker = manifest.dshLocalTest
  if (marker === undefined) {
    if (manifest.name === LOCAL_TEST_METADATA.name || manifest.productName === LOCAL_TEST_METADATA.productName
      || manifest.dshDesktopAppId === LOCAL_TEST_METADATA.appId) throw new Error('local-test: missing test identity')
    return undefined
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)
    || Object.keys(marker).sort().join(',') !== Object.keys(LOCAL_TEST_METADATA).sort().join(',')
    || Object.entries(LOCAL_TEST_METADATA).some(([key, value]) => marker[key] !== value)
    || manifest.name !== marker.name || manifest.productName !== marker.productName || manifest.dshDesktopAppId !== marker.appId
    || ['dshDesktopUpdateChannel', 'dshMandatoryUpdatePolicy', 'publish'].some(key => key in manifest)) {
    throw new Error('local-test: mixed or invalid application identity')
  }
  return LOCAL_TEST_METADATA
}

/** Reject remote/service products before packaging or starting the local test Host.
 * @param {unknown} product Parsed Desktop runtime product declaration.
 * @returns {void} Returns only for the resource-only, local Video Harness product.
 */
export function assertLocalTestRuntimeProduct(product) {
  if (!product || typeof product !== 'object' || Array.isArray(product)
    || product.id !== LOCAL_TEST_METADATA.productId || product.service !== undefined
    || product.preflight?.entrypoint !== 'control/desktop-local-preflight.mjs'
    || JSON.stringify(product.requiredServices) !== JSON.stringify(['projectBff'])
    || !Array.isArray(product.preflight.exportedEnvironment)
    || !product.preflight.exportedEnvironment.includes('VIDEO_HARNESS_PROJECT_MODE')
    || product.preflight.exportedEnvironment.some(name => typeof name !== 'string' || /TOKEN|BASE_URL|SERVER|REMOTE/u.test(name))) {
    throw new Error('local-test: requires the local single-user Video Harness product')
  }
}
