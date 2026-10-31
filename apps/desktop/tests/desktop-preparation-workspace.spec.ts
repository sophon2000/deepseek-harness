import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { desktopTargetBuildPaths } from '../scripts/desktop-build-paths.mjs'
import { createDesktopPreparationWorkspace } from '../scripts/desktop-preparation-workspace.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(persistent: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-store-')))
  roots.push(root)
  return desktopTargetBuildPaths('win-x64', {
    DSH_DESKTOP_BUILD_ROOT: join(root, 'build'),
    ...(persistent ? { DSH_DESKTOP_PNPM_STORE_ROOT: join(root, 'store') } : {}),
  }, join(root, 'source'))
}

it('removes the default temporary content store together with its private installation', () => {
  const workspace = createDesktopPreparationWorkspace(fixture(false))
  try {
    mkdirSync(workspace.store, { recursive: true })
    writeFileSync(join(workspace.store, 'entry'), 'cached')
    workspace.cleanup()
    expect(existsSync(workspace.directory)).toBe(false)
    expect(existsSync(workspace.store)).toBe(false)
    workspace.cleanup()
  } finally { workspace.cleanup() }
})

it.each([false, true])('retains the persistent store with isolated installations after failure=%s', async (failure) => {
  const paths = fixture(true)
  const first = createDesktopPreparationWorkspace(paths)
  const second = createDesktopPreparationWorkspace(paths)
  try {
    expect(first.directory).not.toBe(second.directory)
    expect(first.store).toBe(second.store)
    mkdirSync(first.store, { recursive: true })
    writeFileSync(join(first.store, 'entry'), 'verified dependency')
    const prepare = async () => {
      try { if (failure) throw new Error('install failed') }
      finally { first.cleanup() }
    }
    if (failure) await expect(prepare()).rejects.toThrow('install failed')
    else await prepare()
    expect(existsSync(first.directory)).toBe(false)
    expect(existsSync(second.directory)).toBe(true)
    expect(readFileSync(join(second.store, 'entry'), 'utf8')).toBe('verified dependency')
    second.cleanup()
    expect(readFileSync(join(first.store, 'entry'), 'utf8')).toBe('verified dependency')
  } finally { first.cleanup(); second.cleanup() }
})
