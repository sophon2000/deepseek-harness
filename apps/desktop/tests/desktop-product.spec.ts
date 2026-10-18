import { describe, expect, it } from 'vitest'
import { parseDesktopProductPayload, parseDesktopRuntimeProduct } from '../src/desktop-product.ts'

const payload = {
  schemaVersion: 1,
  id: 'video-harness',
  packagesDirectory: 'packages',
  resourcesDirectory: 'resources',
  packageRoots: ['@video-harness/bundle'],
  profileBundles: ['@video-harness/bundle'],
  service: {
    entrypoint: 'control/service.mjs',
    exportedEnvironment: ['VIDEO_HARNESS_PYTHON_BASE_URL', 'VIDEO_HARNESS_AGENT_TOKEN'],
  },
} as const

describe('Desktop product descriptor', () => {
  it.each([1, 90_000, 120_000])('retains a declared service readiness budget in both descriptors: %s', (readyTimeoutMs) => {
    const service = { ...payload.service, readyTimeoutMs }
    expect(parseDesktopProductPayload({ ...payload, service }).service).toEqual(service)
    expect(parseDesktopRuntimeProduct({
      id: payload.id, profileBundles: payload.profileBundles,
      resourcesRoot: 'products/video-harness/resources', service,
    }).service).toEqual(service)
  })

  it.each([null, false, '90000', 0, -1, 1.5, 120_001, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid service readiness budget at both file parsers: %s', (readyTimeoutMs) => {
      const service = { ...payload.service, readyTimeoutMs }
      expect(() => parseDesktopProductPayload({ ...payload, service })).toThrow('ready timeout')
      expect(() => parseDesktopRuntimeProduct({
        id: payload.id, profileBundles: payload.profileBundles,
        resourcesRoot: 'products/video-harness/resources', service,
      })).toThrow('ready timeout')
    },
  )

  it('retains one narrow service declaration in build and runtime metadata', () => {
    expect(parseDesktopProductPayload(payload).service).toEqual(payload.service)
    expect(parseDesktopRuntimeProduct({
      id: payload.id,
      profileBundles: payload.profileBundles,
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
