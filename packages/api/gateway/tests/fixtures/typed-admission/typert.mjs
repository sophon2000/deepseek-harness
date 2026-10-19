import { z } from 'zod'

export const TYPERT = {
  package: '@fixture/admission', face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
  invocations: ['read', 'follow'].map(method => ({
    id: `@fixture/admission#admissionFixture/${method}`, service: 'admissionFixture', namespace: 'admissionFixture', method,
    invocation: { kind: 'direct' }, ...(method === 'follow' ? { mode: 'stream' } : {}),
    parameters: [
      { name: 'target', wire: 'targetId', source: 'lookup', lookup: 'admissionTarget',
        codec: { mode: 'strict', typeSymbol: 'string', create: () => z.string() } },
      { name: 'request', wire: 'request', source: 'json',
        codec: { mode: 'strict', typeSymbol: '@fixture/admission#Request', create: () => z.strictObject({ title: z.string() }) } },
    ],
    result: { mode: 'strict', typeSymbol: 'string', create: () => z.string() },
  })),
}
