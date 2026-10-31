/** Parent IPC adapter for the Desktop-only trusted selection registry. */
import type { TrustedFilePicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DesktopTrustedFilePickerEvent, DesktopTrustedFilePickerRequest } from './protocol.ts'

/**
 * Dispatch only parsed parent requests. Provider diagnostics and paths never enter replies.
 * @param picker - Current Desktop service, absent before startup or after shutdown.
 * @param request - Validated parent message.
 * @returns Correlated acknowledgement with no filesystem path.
 */
export async function dispatchTrustedFilePicker(
  picker: TrustedFilePicker | undefined,
  request: DesktopTrustedFilePickerRequest,
): Promise<DesktopTrustedFilePickerEvent> {
  const base = { type: 'trusted-file-picker' as const, requestId: request.requestId }
  switch (request.action) {
    case 'validate': {
      try { return { ...base, action: 'validate', result: picker === undefined ? null : await picker.validate(request.challenge) } }
      catch (_error) { /* A failed ledger lookup is a refusal, not a path-bearing diagnostic. */
        return { ...base, action: 'validate', result: null }
      }
    }
    case 'complete': {
      try { return { ...base, action: 'complete', status: picker === undefined ? 'rejected' : await picker.complete(request.challenge, request.selectedPath) } }
      catch (_error) { /* A failed admission cannot authorize a selection. */
        return { ...base, action: 'complete', status: 'rejected' }
      }
    }
    case 'revoke':
      picker?.revoke(request.challenge)
      return { ...base, action: 'revoke', status: 'revoked' }
  }
}
