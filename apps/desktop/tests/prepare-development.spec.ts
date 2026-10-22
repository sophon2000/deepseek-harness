import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDevelopment } from '../scripts/prepare-development.ts'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-source-adapter-'))
  roots.push(root)
  return { projectDir: join(root, 'project'), output: join(root, 'receipt.json'),
    primaryRuntimeDir: join(root, 'runtime'), profilePackageDirs: [] }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('development source adapter admission', () => {
  it('rejects relative inputs without creating a profile or receipt', () => {
    const options = fixture()
    expect(() => prepareDevelopment({ ...options, primaryRuntimeDir: 'relative' })).toThrow('all paths must be absolute')
    expect(existsSync(options.projectDir)).toBe(false)
    expect(existsSync(options.output)).toBe(false)
  })
  it('preserves an existing caller directory', () => {
    const options = fixture()
    mkdirSync(options.projectDir)
    writeFileSync(join(options.projectDir, 'keep'), 'user data')
    expect(() => prepareDevelopment(options)).toThrow('fresh caller-owned paths')
    expect(existsSync(join(options.projectDir, 'keep'))).toBe(true)
  })
  it('rejects a foreign native payload before profile preparation', () => {
    const options = fixture()
    mkdirSync(options.primaryRuntimeDir)
    writeFileSync(join(options.primaryRuntimeDir, 'runtime.json'), JSON.stringify({ desktopVersion: '1.2.3',
      platform: process.platform === 'darwin' ? 'win32' : 'darwin', arch: process.arch,
      python: '3.13.1', node: '24.17.0', pnpm: '11.28.5', pythonPackages: {} }))
    expect(() => prepareDevelopment(options)).toThrow('must match the native host')
    expect(existsSync(options.projectDir)).toBe(false)
    expect(existsSync(options.output)).toBe(false)
  })
})
