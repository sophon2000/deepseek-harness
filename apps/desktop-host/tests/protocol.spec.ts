import { expect, it } from 'vitest'
import { isDesktopHostEvent, isDesktopHostRequest } from '../src/protocol.ts'

it('accepts only exact negotiated trusted picker messages', () => {
  const base = { type: 'trusted-file-picker', requestId: 1, challenge: 'a'.repeat(64) }
  expect(isDesktopHostRequest({ ...base, action: 'validate' })).toBe(true)
  expect(isDesktopHostRequest({ ...base, action: 'revoke' })).toBe(true)
  for (const selectedPath of [null, '/tmp/backup.zip', 'C:\\backup.zip', '\\\\server\\share\\backup.zip']) {
    expect(isDesktopHostRequest({ ...base, action: 'complete', selectedPath })).toBe(true)
  }
  for (const selectedPath of ['relative.zip', '', '/tmp/with\0nul', 12]) {
    expect(isDesktopHostRequest({ ...base, action: 'complete', selectedPath })).toBe(false)
  }
  expect(isDesktopHostRequest({ ...base, action: 'validate', path: '/tmp' })).toBe(false)
  expect(isDesktopHostRequest({ ...base, action: 'validate', challenge: 'wrong' })).toBe(false)
  expect(isDesktopHostRequest({ ...base, action: 'validate', requestId: 0 })).toBe(false)
  expect(isDesktopHostEvent({ type: 'ready', url: 'http://localhost', trustedFilePicker: 1 })).toBe(true)
  expect(isDesktopHostEvent({ type: 'ready', url: 'http://localhost', trustedFilePicker: 2 })).toBe(true)
  for (const trustedFilePicker of [0, -1, 1.5, '1', null]) {
    expect(isDesktopHostEvent({ type: 'ready', url: 'http://localhost', trustedFilePicker })).toBe(false)
  }
  const event = { type: 'trusted-file-picker', requestId: 1, action: 'validate' }
  expect(isDesktopHostEvent({ ...event, result: { purpose: 'open-zip', expiresAt: 100 } })).toBe(true)
  expect(isDesktopHostEvent({ ...event, result: null })).toBe(true)
  expect(isDesktopHostEvent({ ...event, result: { purpose: ['open-zip'], expiresAt: 100 } })).toBe(false)
  expect(isDesktopHostEvent({ ...event, result: { purpose: 'open-zip', expiresAt: 100, path: '/tmp' } })).toBe(false)
  expect(isDesktopHostEvent({ ...event, action: 'complete', status: 'selected' })).toBe(true)
  expect(isDesktopHostEvent({ ...event, action: 'complete', status: 'selected', path: '/tmp' })).toBe(false)
  expect(isDesktopHostEvent({ ...event, action: 'revoke', status: 'revoked' })).toBe(true)
})

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
