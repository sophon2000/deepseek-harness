/** Optional product payload incorporated into one signed Desktop release. */

import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Build-time descriptor supplied by a product payload directory. */
export interface DesktopProductPayload {
  readonly schemaVersion: 1 | 2
  readonly id: string
  readonly packagesDirectory: string
  readonly resourcesDirectory: string
  readonly packageRoots: readonly string[]
  readonly profileBundles: readonly string[]
  readonly service?: DesktopProductService
  /** Resource qualification must exit successfully before the Host starts; excludes service. */
  readonly preflight?: DesktopProductService
  /** Services that must be available before the Host reports ready; omission requires none. */
  readonly requiredServices?: readonly string[]
}

/** One signed product-owned background service launched before the DSH Host. */
export interface DesktopProductService {
  readonly entrypoint: string
  readonly exportedEnvironment: readonly string[]
  /** Ready IPC deadline in milliseconds, from 1 to 120000; omission uses 30000. */
  readonly readyTimeoutMs?: number
}

/** Product configuration retained in the immutable runtime descriptor. */
export interface DesktopRuntimeProduct {
  readonly id: string
  readonly profileBundles: readonly string[]
  readonly resourcesRoot: string
  readonly service?: DesktopProductService
  readonly preflight?: DesktopProductService
  readonly requiredServices?: readonly string[]
}

const PRODUCT_ID = /^[a-z0-9][a-z0-9._-]*$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/u
const forbiddenEnvironment = /^(?:NODE_OPTIONS|NODE_PATH|DSH_DESKTOP_.+|(?:NPM|PNPM|COREPACK)_.+)$/u

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function portablePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '' || isAbsolute(value) || value.includes('\\') || value.includes(':')
    || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`desktop product: invalid ${label}`)
  }
  return value
}

function packageNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0
    || !value.every(name => typeof name === 'string' && PACKAGE_NAME.test(name))) {
    throw new Error(`desktop product: invalid ${label}`)
  }
  const names = value.map((name: unknown) => String(name))
  if (new Set(names).size !== names.length) throw new Error(`desktop product: duplicate ${label}`)
  return names
}

function productService(value: unknown, label: string): DesktopProductService | undefined {
  if (value === undefined) return undefined
  if (!record(value) || !Array.isArray(value.exportedEnvironment)
    || value.exportedEnvironment.length === 0
    || !value.exportedEnvironment.every(name => typeof name === 'string'
      && ENVIRONMENT_NAME.test(name) && !forbiddenEnvironment.test(name))) {
    throw new Error(`desktop product: invalid ${label}`)
  }
  const exportedEnvironment = value.exportedEnvironment.map((name: unknown) => String(name))
  if (new Set(exportedEnvironment).size !== exportedEnvironment.length) {
    throw new Error(`desktop product: duplicate ${label} environment name`)
  }
  const readyTimeoutMs = value.readyTimeoutMs
  if (readyTimeoutMs !== undefined && (typeof readyTimeoutMs !== 'number'
    || !Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 120_000)) {
    throw new Error(`desktop product: invalid ${label} ready timeout; expected an integer from 1 to 120000 ms`)
  }
  return {
    entrypoint: portablePath(value.entrypoint, `${label} entrypoint`),
    exportedEnvironment,
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
  }
}

function preparation(value: Record<string, unknown>) {
  if (value.service !== undefined && value.preflight !== undefined) {
    throw new Error('desktop product: cannot declare both service and preflight')
  }
  const service = productService(value.service, 'service')
  const preflight = productService(value.preflight, 'preflight')
  const required = value.requiredServices
  if (required !== undefined && (!Array.isArray(required) || required.length > 64
    || !required.every(key => typeof key === 'string' && /^[A-Za-z][A-Za-z0-9._-]*$/u.test(key))
    || new Set(required).size !== required.length)) {
    throw new Error('desktop product: invalid required services')
  }
  return {
    ...(service === undefined ? {} : { service }),
    ...(preflight === undefined ? {} : { preflight }),
    ...(required === undefined ? {} : { requiredServices: required.map((key: string) => key) }),
  }
}

/**
 * Validate a product payload descriptor without resolving any untrusted paths.
 * @param value - Untrusted decoded payload metadata.
 * @returns Validated payload with portable resource paths.
 */
export function parseDesktopProductPayload(value: unknown): DesktopProductPayload {
  if (!record(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || typeof value.id !== 'string' || !PRODUCT_ID.test(value.id)) {
    throw new Error('desktop product: invalid descriptor')
  }
  const packageRoots = packageNames(value.packageRoots, 'package roots')
  const profileBundles = packageNames(value.profileBundles, 'profile bundles')
  if (!profileBundles.every(name => packageRoots.includes(name))) {
    throw new Error('desktop product: every profile bundle must be a package root')
  }
  const prepared = preparation(value)
  if (value.schemaVersion === 1 && (prepared.preflight !== undefined || prepared.requiredServices !== undefined)) {
    throw new Error('desktop product: preflight and required services require schema version 2')
  }
  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    packagesDirectory: portablePath(value.packagesDirectory, 'packages directory'),
    resourcesDirectory: portablePath(value.resourcesDirectory, 'resources directory'),
    packageRoots,
    profileBundles,
    ...prepared,
  }
}

/**
 * Read the descriptor at one explicit product payload root.
 * @param root - Caller-selected product payload directory.
 * @returns Validated payload; unreadable or invalid metadata throws.
 */
export function readDesktopProductPayload(root: string): DesktopProductPayload {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(root, 'desktop-product.json'), 'utf8'))
  } catch (error) {
    throw new Error(`desktop product: failed to read ${join(root, 'desktop-product.json')}: ${String(error)}`)
  }
  return parseDesktopProductPayload(value)
}

/**
 * Validate product fields read back from an immutable runtime descriptor.
 * @param value - Untrusted product fields from runtime metadata.
 * @returns Validated product composition and preparation declarations.
 */
export function parseDesktopRuntimeProduct(value: unknown): DesktopRuntimeProduct {
  if (!record(value) || typeof value.id !== 'string' || !PRODUCT_ID.test(value.id)) {
    throw new Error('desktop runtime: invalid product descriptor')
  }
  const profileBundles = packageNames(value.profileBundles, 'runtime profile bundles')
  const prepared = preparation(value)
  return {
    id: value.id,
    profileBundles,
    resourcesRoot: portablePath(value.resourcesRoot, 'runtime resources root'),
    ...prepared,
  }
}
