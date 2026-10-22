/** Closed installed identity for the opt-in local application. */
export interface LocalTestMetadata {
  readonly schemaVersion: 'dsh.desktop.local-test/1'
  readonly productId: 'video-harness'
  readonly mode: 'local-single-user'
  readonly updates: 'none'
  readonly appId: 'ai.videoharness.localtest'
  readonly name: 'video-harness-local-test'
  readonly productName: 'Video Harness Local Test'
  readonly homeName: 'Video Harness Local Test'
  readonly protocol: 'videoharness-localtest'
}
/** Fixed application, storage and protocol names reserved for this test flavor. */
export const LOCAL_TEST_METADATA: Readonly<LocalTestMetadata>
/** Validate installed identity before opening application data.
 * @param manifest Parsed application metadata.
 * @returns Explicit local test identity, or ordinary application mode.
 */
export function readLocalTestPackage(manifest: unknown): Readonly<LocalTestMetadata> | undefined
/** Reject service or remote product declarations.
 * @param product Parsed Desktop runtime product.
 * @returns Returns only for the local single-user product.
 */
export function assertLocalTestRuntimeProduct(product: unknown): void
