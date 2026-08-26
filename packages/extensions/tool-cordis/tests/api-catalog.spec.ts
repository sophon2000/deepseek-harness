import { describe, expect, it } from 'vitest'
import { queryServiceApi } from '../src/api-catalog.ts'

describe('generated Cordis API catalog', () => {
  it('returns the referenced type closure for an exact Service query', () => {
    const result = queryServiceApi('workspaceRegistry') as {
      referencedTypes: Array<{ name: string }>
    }

    expect(result.referencedTypes.map(entry => entry.name)).toEqual(expect.arrayContaining([
      'SessionId',
      'WorkspaceSessionInspection',
    ]))
  })
})
