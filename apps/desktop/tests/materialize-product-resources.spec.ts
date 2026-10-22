import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { materializeDesktopProductResources } from '../scripts/materialize-product-resources.ts'

it('materializes Python executable aliases and directory aliases as physical signed files', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-product-links-'))
  try {
    const source = join(root, 'source')
    mkdirSync(join(source, 'bin'), { recursive: true })
    writeFileSync(join(source, 'bin/python3.12'), 'standalone interpreter\n', { mode: 0o755 })
    symlinkSync('python3.12', join(source, 'bin/python'))
    symlinkSync('bin', join(source, 'alias'))
    const target = join(root, 'target')
    materializeDesktopProductResources(source, target)
    for (const path of ['bin/python', 'alias/python', 'alias/python3.12']) {
      expect(lstatSync(join(target, path)).isFile()).toBe(true)
      expect(readFileSync(join(target, path), 'utf8')).toBe('standalone interpreter\n')
      expect(statSync(join(target, path)).mode & 0o111).toBe(0o111)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('rejects escaping links and cycles before writing any destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-product-invalid-links-'))
  try {
    const source = join(root, 'source')
    mkdirSync(source)
    writeFileSync(join(root, 'external'), 'outside')
    symlinkSync('../external', join(source, 'link'))
    const target = join(root, 'target')
    expect(() => { materializeDesktopProductResources(source, target) }).toThrow(/escapes payload/u)
    expect(existsSync(target)).toBe(false)
    rmSync(join(source, 'link'))
    symlinkSync('.', join(source, 'cycle'))
    expect(() => { materializeDesktopProductResources(source, target) }).toThrow(/directory cycle/u)
    expect(existsSync(target)).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
