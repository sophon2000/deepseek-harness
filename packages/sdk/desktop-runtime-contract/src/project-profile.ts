/** Shared initialization for desktop runtime profiles and isolated release verification. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initProfile, PROFILE_TEMPLATES, readProfileManifest, writeProfileBundles, type ProfileTemplate } from '@deepseek-ai/dsh-app-boot'

const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\n'
/**
 * Render the controlled package-manager settings for a desktop profile.
 * @param overrides - Immutable runtime package overrides for a build profile.
 * @returns Workspace configuration text.
 */
export function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  if (entries.length === 0) return `packages:\n  - .\n\n${WORKSPACE_SETTINGS}`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

/**
 * Upgrade only the exact historical desktop profile settings.
 * @param projectDir - Existing desktop profile directory.
 */
export function migrateProfileSettings(projectDir: string): void {
  const path = join(projectDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return
  const legacy = `packages:\n  - .\n\n${WORKSPACE_SETTINGS}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "${CORE_BUILD_PACKAGE}": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') === legacy) {
    writeFileSync(path, workspaceFile())
  }
}

const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate

/**
 * Compose the runtime-owned desktop bundles without allowing duplicate registration.
 * @param productBundles - Additional immutable product bundles.
 * @returns Ordered built-in profile bundle names.
 */
export function desktopProfileBundles(productBundles: readonly string[] = []): string[] {
  const bundles = [...WEB_PROFILE.bundles, ...productBundles]
  if (new Set(bundles).size !== bundles.length) {
    throw new Error('desktop project: duplicate built-in profile bundle')
  }
  return bundles
}

/**
 * Initialize a profile and add missing runtime-owned bundles without changing user packages or patches.
 * @param projectDir - Writable profile directory owned by the caller.
 * @param productBundles - Additional immutable product bundles.
 */
export function createPluginProfile(projectDir: string, productBundles: readonly string[] = []): void {
  initProfile(projectDir, desktopProfileBundles(productBundles))
  if (productBundles.length === 0) return
  const manifest = readProfileManifest('dsh desktop', projectDir)
  const previous = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(previous) || !previous.every(name => typeof name === 'string')) {
    throw new Error('desktop project: profile bundles must be a string array')
  }
  const missing = productBundles.filter(name => !previous.includes(name))
  if (missing.length > 0) writeProfileBundles(projectDir, manifest, [...previous, ...missing])
}
