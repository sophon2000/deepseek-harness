/** Shared messages for the Desktop Host child and independently built Electron shells. */
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'

/** Lifecycle protocol generation accepted by this Host. */
export const DESKTOP_HOST_PROTOCOL_VERSION = 4 as const

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string
  /** The Host's complete inspected error: stack, enumerable properties, cause chain. */
  readonly diagnostic?: string
}

interface PlatformSessionEvent {
  readonly type: 'platform-session'
  readonly session: PlatformSession | null
}

export type DesktopHostEvent = ReadyEvent | FatalEvent | PlatformSessionEvent | { readonly type: 'shutdown-complete' } | {
  readonly type: 'update-tasks'
  readonly requestId: number
  readonly active: boolean
  readonly error?: string
} | {
  readonly type: 'quit-inspection'
  readonly requestId: number
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
  readonly error?: string
}

/** Requests accepted by the Host over its private parent IPC channel. */
export type DesktopHostRequest = { readonly type: 'shutdown' } | {
  readonly type: 'quit-inspection'
  readonly requestId: number
} | {
  readonly type: 'update-tasks'
  readonly requestId: number
  readonly action: 'inspect' | 'lock' | 'unlock'
}

/**
 * Validate an IPC event before a shell acts on Host-supplied state.
 * @param message - Untrusted child-process message.
 * @returns Whether the event conforms to the current Host protocol.
 */
export function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'shutdown-complete':
      return true
    case 'ready':
      return typeof candidate.url === 'string'
    case 'platform-session': {
      const session = candidate.session
      if (session === null) return true
      if (typeof session !== 'object' || !('origin' in session) || !('token' in session)
        || typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) return false
      if (!('userId' in session) || (session.userId !== null
        && (typeof session.userId !== 'string' || session.userId.length === 0))) return false
      if ('embeddedPageDist' in session && typeof session.embeddedPageDist !== 'string') return false
      if ('requestHeaders' in session && (typeof session.requestHeaders !== 'object' || session.requestHeaders === null
        || Array.isArray(session.requestHeaders)
        || Object.entries(session.requestHeaders).some(([name, value]) => typeof value !== 'string'
          || name !== name.toLowerCase() || /[\r\n]/.test(value)
          || ['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(name)))) return false
      try {
        const url = new URL(session.origin)
        return url.origin === session.origin && !url.username && !url.password
          && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      } catch { return false }
    }
    case 'fatal':
      return typeof candidate.message === 'string' && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'update-tasks':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'quit-inspection':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === 'boolean'
        && typeof candidate.scheduledTasks === 'boolean' && (candidate.error === undefined || typeof candidate.error === 'string')
    default:
      return false
  }
}


/**
 * Validate a parent control request without widening the accepted operations.
 * @param message - Untrusted parent-process message.
 * @returns Whether the Host can dispatch the request.
 */
export function isDesktopHostRequest(message: unknown): message is DesktopHostRequest {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  if (message.type === 'shutdown') return true
  if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return false
  if (message.type === 'quit-inspection') return true
  return message.type === 'update-tasks' && 'action' in message
    && (message.action === 'inspect' || message.action === 'lock' || message.action === 'unlock')
}
