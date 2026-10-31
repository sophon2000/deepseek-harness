import { describe, expect, it } from 'vitest'
import { assertDesktopRequiredServices, parseDesktopRequiredServices } from '../src/required-services.ts'

describe('Desktop product required service gate', () => {
  it('keeps ordinary profiles unchanged and reads exact product requirements', () => {
    expect(parseDesktopRequiredServices(undefined)).toEqual([])
    expect(parseDesktopRequiredServices('["projectBff","workspaceRegistry"]')).toEqual(['projectBff', 'workspaceRegistry'])
  })
  it.each(['null', '{}', '[""]', '["projectBff","projectBff"]', '[1]', 'invalid'])('rejects malformed launcher input: %s', (input) => {
    expect(() => parseDesktopRequiredServices(input)).toThrow()
  })
  it('rejects missing product services even when the generic application is active', () => {
    const active = { get: (key: string) => key === 'loader' ? {} : undefined }
    expect(() => { assertDesktopRequiredServices(active, ['projectBff']) }).toThrow('projectBff')
  })
  it('accepts an actual published service without calling any product method', () => {
    const service = { dangerous: () => { throw new Error('must not invoke') } }
    expect(() => { assertDesktopRequiredServices({ get: () => service }, ['projectBff']) }).not.toThrow()
  })
})
