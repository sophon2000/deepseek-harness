/** Optional product payload incorporated into one signed Desktop release. */

import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Build-time descriptor supplied by a product payload directory. */
export interface DesktopProductPayload {
  readonly schemaVersion: 1
  readonly id: string
  readonly packagesDirectory: string
  readonly resourcesDirectory: string
  readonly packageRoots: readonly string[]
  readonly profileBundles: readonly string[]
  readonly systemPresetRoots: readonly string[]
  readonly service?: DesktopProductService
}

/** One signed product-owned background service launched before the DSH Host. */
export interface DesktopProductService {
  readonly entrypoint: string
  readonly exportedEnvironment: readonly string[]
}

/** Product configuration retained in the immutable runtime descriptor. */
export interface DesktopRuntimeProduct {
  readonly id: string
  readonly profileBundles: readonly string[]
  readonly systemPresetRoots: readonly string[]
  readonly resourcesRoot: string
  readonly service?: DesktopProductService
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
  const names = [...value] as string[]
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
  const exportedEnvironment = [...value.exportedEnvironment] as string[]
  if (new Set(exportedEnvironment).size !== exportedEnvironment.length) {
    throw new Error(`desktop product: duplicate ${label} environment name`)
  }
  return {
    entrypoint: portablePath(value.entrypoint, `${label} entrypoint`),
    exportedEnvironment,
  }
}

/** Validate a product payload descriptor without resolving any untrusted paths. */
export function parseDesktopProductPayload(value: unknown): DesktopProductPayload {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !PRODUCT_ID.test(value.id)) {
    throw new Error('desktop product: invalid descriptor')
  }
  const packageRoots = packageNames(value.packageRoots, 'package roots')
  const profileBundles = packageNames(value.profileBundles, 'profile bundles')
  if (!profileBundles.every(name => packageRoots.includes(name))) {
    throw new Error('desktop product: every profile bundle must be a package root')
  }
  if (!Array.isArray(value.systemPresetRoots)) throw new Error('desktop product: invalid system preset roots')
  const systemPresetRoots = value.systemPresetRoots.map(root => portablePath(root, 'system preset root'))
  if (new Set(systemPresetRoots).size !== systemPresetRoots.length) {
    throw new Error('desktop product: duplicate system preset root')
  }
  const service = productService(value.service, 'service')
  return {
    schemaVersion: 1,
    id: value.id,
    packagesDirectory: portablePath(value.packagesDirectory, 'packages directory'),
    resourcesDirectory: portablePath(value.resourcesDirectory, 'resources directory'),
    packageRoots,
    profileBundles,
    systemPresetRoots,
    ...(service === undefined ? {} : { service }),
  }
}

/** Read the descriptor at one explicit product payload root. */
export function readDesktopProductPayload(root: string): DesktopProductPayload {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(root, 'desktop-product.json'), 'utf8'))
  } catch (error) {
    throw new Error(`desktop product: failed to read ${join(root, 'desktop-product.json')}: ${String(error)}`)
  }
  return parseDesktopProductPayload(value)
}

/** Validate product fields read back from an immutable runtime descriptor. */
export function parseDesktopRuntimeProduct(value: unknown): DesktopRuntimeProduct {
  if (!record(value) || typeof value.id !== 'string' || !PRODUCT_ID.test(value.id)) {
    throw new Error('desktop runtime: invalid product descriptor')
  }
  const profileBundles = packageNames(value.profileBundles, 'runtime profile bundles')
  if (!Array.isArray(value.systemPresetRoots)) throw new Error('desktop runtime: invalid product preset roots')
  const systemPresetRoots = value.systemPresetRoots.map(root => portablePath(root, 'runtime system preset root'))
  const service = productService(value.service, 'runtime service')
  return {
    id: value.id,
    profileBundles,
    systemPresetRoots,
    resourcesRoot: portablePath(value.resourcesRoot, 'runtime resources root'),
    ...(service === undefined ? {} : { service }),
  }
}
