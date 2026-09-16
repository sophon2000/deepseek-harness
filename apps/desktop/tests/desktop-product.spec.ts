import { describe, expect, it } from 'vitest'
import { parseDesktopProductPayload, parseDesktopRuntimeProduct } from '../src/desktop-product.ts'

const payload = {
  schemaVersion: 1,
  id: 'video-harness',
  packagesDirectory: 'packages',
  resourcesDirectory: 'resources',
  packageRoots: ['@video-harness/bundle'],
  profileBundles: ['@video-harness/bundle'],
  systemPresetRoots: ['presets'],
  service: {
    entrypoint: 'control/service.mjs',
    exportedEnvironment: ['VIDEO_HARNESS_PYTHON_BASE_URL', 'VIDEO_HARNESS_AGENT_TOKEN'],
  },
} as const

describe('Desktop product descriptor', () => {
  it('retains one narrow service declaration in build and runtime metadata', () => {
    expect(parseDesktopProductPayload(payload).service).toEqual(payload.service)
    expect(parseDesktopRuntimeProduct({
      id: payload.id,
      profileBundles: payload.profileBundles,
      systemPresetRoots: ['products/video-harness/presets-1'],
      resourcesRoot: 'products/video-harness/resources',
      service: payload.service,
    }).service).toEqual(payload.service)
  })

  it('rejects traversal, duplicates, and process-control environment names', () => {
    expect(() => parseDesktopProductPayload({
      ...payload, service: { ...payload.service, entrypoint: '../service.mjs' },
    })).toThrow('invalid service entrypoint')
    expect(() => parseDesktopProductPayload({
      ...payload, service: { ...payload.service, exportedEnvironment: ['SAFE', 'SAFE'] },
    })).toThrow('duplicate service environment name')
    expect(() => parseDesktopProductPayload({
      ...payload, service: { ...payload.service, exportedEnvironment: ['NODE_OPTIONS'] },
    })).toThrow('invalid service')
  })
})
