import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function portablePath(root, value, label) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes(':')
    || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`desktop package: invalid ${label}`)
  }
  return join(root, ...value.split('/'))
}

/**
 * Reject a package whose child-process runtime was omitted or partially copied.
 * @param {{ appOutDir: string, packager: { getResourcesDir(appOutDir: string): string } }} context - electron-builder afterPack context.
 * @returns {void}
 */
export function verifyPackagedDesktopRuntime(context) {
  const runtime = join(context.packager.getResourcesDir(context.appOutDir), 'dsh')
  const descriptorPath = join(runtime, 'desktop-runtime.json')
  let descriptor
  try {
    descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
  } catch (error) {
    throw new Error(`desktop package: missing runtime descriptor ${descriptorPath}: ${String(error)}`)
  }
  if (!record(descriptor)) throw new Error('desktop package: runtime descriptor is invalid')
  const host = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
  const product = record(descriptor.product) ? descriptor.product : undefined
  const resources = product === undefined
    ? undefined
    : portablePath(runtime, product.resourcesRoot, 'product resources root')
  const service = resources !== undefined && record(product?.service)
    ? portablePath(resources, product.service.entrypoint, 'product service entrypoint')
    : undefined
  for (const path of [host, service]) {
    if (path !== undefined && !existsSync(path)) throw new Error(`desktop package: missing child-process entrypoint ${path}`)
  }
}
