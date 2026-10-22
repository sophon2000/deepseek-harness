/** Startup isolation for explicitly marked, packaged local single-user builds. */

import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { App } from 'electron'
import { assertLocalTestRuntimeProduct, readLocalTestPackage, type LocalTestMetadata } from './local-test-package.mjs'
import { readDesktopRuntime } from './runtime-tree.ts'

type IsolationApp = Pick<App, 'isPackaged' | 'getPath' | 'setPath' | 'setName' | 'setAppUserModelId'>

/** Inputs available before Electron logs, single-instance ownership, and profiles are initialized. */
export interface LocalTestIsolationInput {
  readonly app: IsolationApp
  readonly manifest: unknown
  readonly resourcesPath: string
  readonly environment: NodeJS.ProcessEnv
  readonly argv: readonly string[]
}

/**
 * Validate a package's local-test identity and isolate its mutable data before startup.
 * Ordinary manifests return undefined without changing paths or environment.
 * @param input - Packaged identity, immutable resources, inherited environment, and launch arguments.
 * @returns Validated local-test metadata, or undefined for an ordinary application.
 */
export function configureLocalTestIsolation(input: LocalTestIsolationInput): LocalTestMetadata | undefined {
  const metadata = readLocalTestPackage(input.manifest)
  if (metadata === undefined) return undefined
  const { app, environment, argv } = input
  if (!app.isPackaged) throw new Error('desktop local test: requires a packaged application')
  if (argv.some(argument => /^--(?:user-data-dir|disk-cache-dir)(?:=|$)/iu.test(argument))
    || ['DSH_DESKTOP_USER_DATA_DIR', 'ELECTRON_USER_DATA_DIR'].some(key => environment[key] !== undefined)) {
    throw new Error('desktop local test: user-data overrides are forbidden')
  }
  if (lstatSync(join(input.resourcesPath, 'app-update.yml'), { throwIfNoEntry: false }) !== undefined) {
    throw new Error('desktop local test: packaged update source is forbidden')
  }
  const { product } = readDesktopRuntime(join(input.resourcesPath, 'dsh'))
  assertLocalTestRuntimeProduct(product)
  const requestedUserData = join(app.getPath('appData'), metadata.homeName)
  for (const directory of [requestedUserData, ...['session-data', 'Crashpad', 'dsh', 'agents'].map(name => join(requestedUserData, name))]) {
    const existing = lstatSync(directory, { throwIfNoEntry: false })
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isDirectory())) {
      throw new Error(`desktop local test: data directory must not be a link or non-directory: ${directory}`)
    }
  }
  mkdirSync(requestedUserData, { recursive: true })
  // Windows packaged launchers may virtualize Roaming without a reparse point.
  // Pass the actual OS-owned directory to the product's strict canonical-path checks.
  const userData = realpathSync.native(requestedUserData)
  const requestedIdentity = lstatSync(requestedUserData, { bigint: true })
  const canonicalIdentity = lstatSync(userData, { bigint: true })
  if (basename(userData) !== metadata.homeName || requestedIdentity.isSymbolicLink()
    || !requestedIdentity.isDirectory() || canonicalIdentity.isSymbolicLink() || !canonicalIdentity.isDirectory()
    || requestedIdentity.dev !== canonicalIdentity.dev || requestedIdentity.ino !== canonicalIdentity.ino) {
    throw new Error('desktop local test: canonical data directory identity differs')
  }
  const sessionData = join(userData, 'session-data')
  const crashDumps = join(userData, 'Crashpad')
  const dshHome = join(userData, 'dsh')
  const agentsHome = join(userData, 'agents')
  for (const directory of [userData, sessionData, crashDumps, dshHome, agentsHome]) {
    const existing = lstatSync(directory, { throwIfNoEntry: false })
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isDirectory())) {
      throw new Error(`desktop local test: canonical data directory must not be a link or non-directory: ${directory}`)
    }
  }
  for (const directory of [userData, sessionData, crashDumps]) mkdirSync(directory, { recursive: true })
  app.setName(metadata.productName)
  app.setAppUserModelId(metadata.appId)
  app.setPath('userData', userData)
  app.setPath('sessionData', sessionData)
  app.setPath('crashDumps', crashDumps)
  environment.DSH_HOME = dshHome
  environment.DSH_AGENTS_HOME = agentsHome
  environment.VIDEO_HARNESS_DSH_HOME = dshHome
  return metadata
}
