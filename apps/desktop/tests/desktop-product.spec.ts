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
  it('retains resource preflight and required Host services without a background service', () => {
    const { service, ...base } = payload
    const preflight = { ...service, entrypoint: 'control/resources.mjs' }
    const expected = { preflight, requiredServices: ['projectBff'] }
    expect(parseDesktopProductPayload({ ...base, schemaVersion: 2, ...expected })).toMatchObject(expected)
    expect(() => parseDesktopProductPayload({ ...base, ...expected })).toThrow('schema version 2')
    expect(parseDesktopRuntimeProduct({
      id: base.id, profileBundles: base.profileBundles,
      resourcesRoot: 'products/video-harness/resources', ...expected,
    })).toMatchObject(expected)
  })

  it('rejects ambiguous preparation and malformed required services', () => {
    expect(() => parseDesktopProductPayload({ ...payload, preflight: payload.service })).toThrow('both')
    for (const requiredServices of [['projectBff', 'projectBff'], [''], [null], 'projectBff']) {
      expect(() => parseDesktopProductPayload({ ...payload, requiredServices })).toThrow('required services')
    }
    const { service, ...base } = payload
    expect(() => parseDesktopProductPayload({
      ...base, preflight: { ...service, entrypoint: '../resources.mjs' },
    })).toThrow('invalid preflight entrypoint')
  })

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
