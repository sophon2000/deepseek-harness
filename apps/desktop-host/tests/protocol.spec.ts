import { expect, it } from 'vitest'
import { isDesktopHostEvent, isDesktopHostRequest } from '../src/protocol.ts'

it('shares the existing Host control operations and rejects malformed requests', () => {
  for (const message of [{ type: 'shutdown' }, { type: 'quit-inspection', requestId: 1 },
    ...['inspect', 'lock', 'unlock'].map(action => ({ type: 'update-tasks', requestId: 2, action }))]) {
    expect(isDesktopHostRequest(message)).toBe(true)
  }
  for (const message of [null, { type: 'quit-inspection', requestId: 1.5 }, { type: 'update-tasks', requestId: 1, action: 'kill' },
    { type: 'update-tasks', requestId: '1', action: 'lock' }, { type: 'unknown' }]) {
    expect(isDesktopHostRequest(message)).toBe(false)
  }
})

it('validates Host state and rejects unsafe platform session headers', () => {
  for (const message of [{ type: 'ready', url: 'http://127.0.0.1:42' }, { type: 'fatal', message: 'startup failed' },
    { type: 'shutdown-complete' }, { type: 'update-tasks', requestId: 1, active: false },
    { type: 'quit-inspection', requestId: 2, activeTasks: false, scheduledTasks: true }, { type: 'platform-session', session: null }]) {
    expect(isDesktopHostEvent(message)).toBe(true)
  }
  const session = { origin: 'https://example.test', token: 'session', userId: 'user', requestHeaders: { 'x-product': 'desktop' } }
  expect(isDesktopHostEvent({ type: 'platform-session', session })).toBe(true)
  expect(isDesktopHostEvent({ type: 'platform-session', session: { ...session, requestHeaders: { authorization: 'token' } } })).toBe(false)
  expect(isDesktopHostEvent({ type: 'platform-session', session: { ...session, origin: 'http://example.test' } })).toBe(false)
  expect(isDesktopHostEvent({ type: 'ready', url: 42 })).toBe(false)
})
