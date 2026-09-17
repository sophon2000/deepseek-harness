/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, join, sep } from 'node:path'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContainedPath(root: string, target: string): boolean {
  const canonicalRoot = realpathSync(root)
  const canonicalTarget = realpathSync(target)
  return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(canonicalRoot + sep)
}

/** Resolve system-trusted preset roots explicitly configured for linked development. */
export function developmentSystemPresetRoots(projectDir: string, linked: boolean): string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
  const dsh = isRecord(manifest) && isRecord(manifest.dsh) ? manifest.dsh : undefined
  const desktop = isRecord(dsh?.desktop) ? dsh.desktop : undefined
  const roots = desktop?.systemPresetRoots
  if (roots === undefined) return []
  if (!linked || !Array.isArray(roots) || !roots.every(root => typeof root === 'string' && root !== '')) {
    throw new Error('dsh desktop: development system preset roots require a linked development profile')
  }
  return roots.map(root => realpathSync(root))
}

/** Resolve system-trusted preset roots carried by the integrity-checked runtime. */
export function packagedSystemPresetRoots(runtimeDir: string): string[] {
  const descriptorPath = join(runtimeDir, 'desktop-runtime.json')
  if (!existsSync(descriptorPath)) return []
  const descriptor: unknown = JSON.parse(readFileSync(descriptorPath, 'utf8'))
  const product = isRecord(descriptor) && isRecord(descriptor.product) ? descriptor.product : undefined
  if (product === undefined) return []
  const roots = product.systemPresetRoots
  if (!Array.isArray(roots) || !roots.every(root => typeof root === 'string' && root !== ''
    && !root.includes('\\') && !root.includes(':')
    && root.split('/').every(part => part !== '' && part !== '.' && part !== '..'))) {
    throw new Error('dsh desktop: packaged product preset roots are invalid')
  }
  return roots.map((root) => {
    const path = realpathSync(join(runtimeDir, ...root.split('/')))
    if (!isContainedPath(runtimeDir, path)) throw new Error('dsh desktop: packaged product preset root escapes the runtime')
    return path
  })
}

/** Append immutable deployment roots without discarding product or user-layer preset settings. */
export function appendSystemPresetRoots(patches: PatchOptions[], roots: readonly string[]): PatchOptions[] {
  if (roots.length === 0) return patches
  const rows = new Map(composeEntries([patches]).flatMap(row => (
    typeof row.id === 'string' ? [[row.id, row] as const] : []
  )))
  const presets = rows.get('agent-presets')
  if (presets === undefined) return patches
  const config = isRecord(presets.config) ? presets.config : {}
  const configured = Array.isArray(config.roots) ? config.roots : []
  return [...patches, {
    id: 'agent-presets',
    config: {
      ...config,
      roots: [...configured, ...roots.map(path => ({ path, trust: 'system' as const }))],
    },
  }]
}

async function main(): Promise<void> {
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  const linked = process.argv[5] !== 'runtime'
  const presetRoots = [
    ...packagedSystemPresetRoots(runtimeDir),
    ...developmentSystemPresetRoots(projectDir, linked),
  ]
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolutionMode: process.argv[5] === 'runtime' ? 'runtime' : 'link',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    transformPatches: patches => appendSystemPresetRoots(patches, presetRoots),
    args: ['--no-open', '--port', '19387'],
    ...(process.argv[6] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[6]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[7] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const control: { updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl> } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  await ctx.plugin(desktopOffice, {
    source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() }, (error) => { if (error !== null) console.error(error) })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (process.connected) process.send?.({ type: 'fatal', message }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
