/** Trusted parent transport replies never expose selected paths or provider diagnostics. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TrustedFilePicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { TrustedFilePickerChallenge } from '@deepseek-ai/dsh-host-directory-picker'
import { dispatchTrustedFilePicker } from '../src/trusted-file-picker.ts'

const base = { type: 'trusted-file-picker' as const, requestId: 1, challenge: 'a'.repeat(64) as TrustedFilePickerChallenge }

it('refuses requests while Host has no picker service', async () => {
  expect(await dispatchTrustedFilePicker(undefined, { ...base, action: 'validate' })).toEqual({ type: base.type, requestId: 1, action: 'validate', result: null })
  expect(await dispatchTrustedFilePicker(undefined, { ...base, action: 'complete', selectedPath: '/private/backup.zip' })).toEqual({ type: base.type, requestId: 1, action: 'complete', status: 'rejected' })
  expect(await dispatchTrustedFilePicker(undefined, { ...base, action: 'revoke' })).toEqual({ type: base.type, requestId: 1, action: 'revoke', status: 'revoked' })
})

it('contains provider errors without exposing a path in the parent reply', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(TrustedFilePicker)
  await fiber.await()
  const picker = ctx.get('trustedFilePicker')!
  picker.register({
    validate: async () => { throw new Error('/private/path') },
    complete: async () => { throw new Error('/private/path') },
    revoke: () => {},
  })
  try {
    const reply = await dispatchTrustedFilePicker(picker, { ...base, action: 'validate' })
    expect(reply).toEqual({ type: base.type, requestId: 1, action: 'validate', result: null })
  } finally { await fiber.dispose() }
})
