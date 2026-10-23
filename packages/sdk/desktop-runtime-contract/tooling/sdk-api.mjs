/** Versioned distributor ESM entrypoints for the exported Runtime SDK. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Fixed paths relative to the immutable SDK root; independent of archive and Host protocol versions. */
export const DESKTOP_SDK_API = Object.freeze({
  version: 'dsh.desktop-sdk-api/1',
  profile: 'sdk/v1/profile.mjs',
  runtime: 'sdk/v1/runtime.mjs',
  packagedRuntime: 'sdk/v1/packaged-runtime.mjs',
  tools: 'sdk/v1/tools.mjs',
})

/**
 * Write the supported distributor API while retaining the internal tooling implementation.
 * @param destination - New export root with its recursively exported tooling closure.
 */
export function writeDesktopSdkApi(destination) {
  mkdirSync(join(destination, 'sdk/v1'), { recursive: true })
  const modules = {
    profile: "export { createPluginProfile } from '@deepseek-ai/dsh-desktop-runtime-contract/project-profile'\n",
    runtime: "export { verifyDesktopRuntime } from '@deepseek-ai/dsh-desktop-runtime-contract/runtime-tree'\n",
    packagedRuntime: "export { verifyPackagedDesktopRuntime } from '../../packages/sdk/desktop-runtime-contract/tooling/verify-packaged-runtime.mjs'\n",
    tools: `import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Load the ASAR implementation from this SDK's exact Electron builder dependency graph. */
export async function loadAsar() {
  const require = createRequire(new URL('../../package.json', import.meta.url))
  const builderRequire = createRequire(require.resolve('electron-builder/cli.js'))
  const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'))
  return import(pathToFileURL(libraryRequire.resolve('@electron/asar')).href)
}
`,
  }
  for (const [name, source] of Object.entries(modules)) writeFileSync(join(destination, DESKTOP_SDK_API[name]), source)
}
