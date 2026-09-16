import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { developmentSystemPresetRoots, packagedSystemPresetRoots } from '../../desktop-host/src/index.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-preset-root-test-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host development preset roots', () => {
  it('accepts canonical roots only for an explicitly linked development profile', () => {
    const project = temporaryRoot()
    const presets = join(project, 'external-presets')
    mkdirSync(presets)
    writeFileSync(join(project, 'package.json'), JSON.stringify({
      dsh: { desktop: { systemPresetRoots: [presets] } },
    }))

    expect(developmentSystemPresetRoots(project, true)).toEqual([realpathSync(presets)])
    expect(() => developmentSystemPresetRoots(project, false)).toThrow(
      /require a linked development profile/u,
    )
  })

  it('rejects malformed development roots instead of silently dropping them', () => {
    const project = temporaryRoot()
    writeFileSync(join(project, 'package.json'), JSON.stringify({
      dsh: { desktop: { systemPresetRoots: [''] } },
    }))

    expect(() => developmentSystemPresetRoots(project, true)).toThrow(
      /require a linked development profile/u,
    )
  })
})

describe('desktop host packaged preset roots', () => {
  it('accepts only roots contained in the immutable runtime', () => {
    const runtime = temporaryRoot()
    const presets = join(runtime, 'products', 'video-harness', 'presets-1')
    mkdirSync(presets, { recursive: true })
    writeFileSync(join(runtime, 'desktop-runtime.json'), JSON.stringify({
      product: { systemPresetRoots: ['products/video-harness/presets-1'] },
    }))
    expect(packagedSystemPresetRoots(runtime)).toEqual([realpathSync(presets)])
  })

  it('rejects traversal in a packaged product descriptor', () => {
    const runtime = temporaryRoot()
    writeFileSync(join(runtime, 'desktop-runtime.json'), JSON.stringify({
      product: { systemPresetRoots: ['../outside'] },
    }))
    expect(() => packagedSystemPresetRoots(runtime)).toThrow(/invalid/u)
  })
})
