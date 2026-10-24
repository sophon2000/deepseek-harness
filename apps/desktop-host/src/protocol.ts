/** Shared messages for the Desktop Host child and independently built Electron shells. */
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import type { TrustedFilePickerChallenge, TrustedFilePickerSpec, TrustedFilePickerStatus } from '@deepseek-ai/dsh-host-directory-picker'

/** Lifecycle protocol generation accepted by this Host. */
export const DESKTOP_HOST_PROTOCOL_VERSION = 4 as const

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
  readonly trustedFilePicker?: number
}

/** Parent-only chooser requests; paths never originate from renderer messages. */
export type DesktopTrustedFilePickerRequest = {
  readonly type: 'trusted-file-picker'
  readonly requestId: number
  readonly challenge: TrustedFilePickerChallenge
} & ({ readonly action: 'validate' | 'revoke' } | { readonly action: 'complete'; readonly selectedPath: string | null })

/** Correlated chooser acknowledgements carrying no selected filesystem path. */
export type DesktopTrustedFilePickerEvent = {
  readonly type: 'trusted-file-picker'
  readonly requestId: number
} & ({ readonly action: 'validate'; readonly result: TrustedFilePickerSpec | null }
  | { readonly action: 'complete'; readonly status: TrustedFilePickerStatus }
  | { readonly action: 'revoke'; readonly status: 'revoked' })

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

export type DesktopHostEvent = DesktopTrustedFilePickerEvent | ReadyEvent | FatalEvent | PlatformSessionEvent | { readonly type: 'shutdown-complete' } | {
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
export type DesktopHostRequest = DesktopTrustedFilePickerRequest | { readonly type: 'shutdown' } | {
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
      return typeof candidate.url === 'string' && (candidate.trustedFilePicker === undefined
        || (typeof candidate.trustedFilePicker === 'number' && Number.isSafeInteger(candidate.trustedFilePicker) && candidate.trustedFilePicker > 0))
    case 'trusted-file-picker':
      return isPickerEvent(candidate)
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
  if (message.type === 'trusted-file-picker') return isPickerRequest(message as Record<string, unknown>)
  if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return false
  if (message.type === 'quit-inspection') return true
  return message.type === 'update-tasks' && 'action' in message
    && (message.action === 'inspect' || message.action === 'lock' || message.action === 'unlock')
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function pickerId(value: Record<string, unknown>): boolean {
  return typeof value.requestId === 'number' && Number.isSafeInteger(value.requestId) && value.requestId > 0
}

function isPickerRequest(value: Record<string, unknown>): boolean {
  if (!pickerId(value) || typeof value.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(value.challenge)) return false
  const keys = ['type', 'requestId', 'action', 'challenge']
  if (value.action === 'validate' || value.action === 'revoke') return exactKeys(value, keys)
  return value.action === 'complete' && exactKeys(value, [...keys, 'selectedPath'])
    && (value.selectedPath === null || (typeof value.selectedPath === 'string'
      && value.selectedPath.length > 0 && value.selectedPath.length <= 32_768 && !value.selectedPath.includes('\0')
      && (/^\//.test(value.selectedPath) || /^[a-zA-Z]:[\\/]/.test(value.selectedPath) || /^\\\\[^\\]+\\[^\\]+/.test(value.selectedPath))))
}

function isPickerEvent(value: Record<string, unknown>): boolean {
  if (!pickerId(value)) return false
  if (value.action === 'validate') {
    if (!exactKeys(value, ['type', 'requestId', 'action', 'result'])) return false
    if (value.result === null) return true
    if (typeof value.result !== 'object' || value.result === null || Array.isArray(value.result)) return false
    const result = value.result as Record<string, unknown>
    return exactKeys(result, ['purpose', 'expiresAt'])
      && typeof result.purpose === 'string' && ['save-zip', 'open-zip', 'select-directory'].includes(result.purpose)
      && typeof result.expiresAt === 'number' && Number.isSafeInteger(result.expiresAt) && result.expiresAt > 0
  }
  if (!exactKeys(value, ['type', 'requestId', 'action', 'status'])) return false
  return (value.action === 'revoke' && value.status === 'revoked')
    || (value.action === 'complete' && typeof value.status === 'string' && ['selected', 'cancelled', 'rejected'].includes(value.status))
}
