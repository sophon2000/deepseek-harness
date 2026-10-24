/** Trusted picker reservations and provider lifetime. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TrustedFilePicker } from '../src/trusted-file-picker.ts'
import type { TrustedFilePickerChallenge, TrustedFilePickerProvider } from '../src/trusted-file-picker.ts'

const challenge = 'a'.repeat(64) as TrustedFilePickerChallenge
const another = 'b'.repeat(64) as TrustedFilePickerChallenge
const disposers: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  vi.useRealTimers()
})

async function setup() {
  const ctx = new Context()
  const fiber = ctx.plugin(TrustedFilePicker)
  disposers.push(() => fiber.dispose())
  await fiber.await()
  const picker = ctx.get('trustedFilePicker')!
  const provider: TrustedFilePickerProvider = {
    validate: vi.fn<TrustedFilePickerProvider['validate']>(async () => ({ purpose: 'save-zip', expiresAt: Date.now() + 60_000 })),
    complete: vi.fn<TrustedFilePickerProvider['complete']>(async () => 'selected'),
    revoke: vi.fn(),
  }
  const dispose = picker.register(provider)
  return { ctx, picker, provider, dispose, fiber }
}

describe('trusted Desktop file selection', () => {
  it('refuses absent providers, duplicate registration and unclaimed completion', async () => {
    const { picker, provider, dispose } = await setup()
    expect(() => picker.register(provider)).toThrow('already has a provider')
    expect(await picker.complete(challenge, '/tmp/backup.zip')).toBe('rejected')
    dispose()
    dispose()
    expect(await picker.validate(challenge)).toBeNull()
  })

  it('reserves one dialog and accepts a matching completion only once', async () => {
    const { picker, provider } = await setup()
    expect(await picker.validate(challenge)).toMatchObject({ purpose: 'save-zip' })
    expect(await picker.validate(another)).toBeNull()
    expect(await picker.complete(another, '/tmp/no.zip')).toBe('rejected')
    expect(await picker.complete(challenge, '/tmp/backup.zip')).toBe('selected')
    expect(await picker.complete(challenge, '/tmp/backup.zip')).toBe('rejected')
    expect(provider.complete).toHaveBeenCalledTimes(1)
    picker.revoke(challenge)
    expect(provider.revoke).toHaveBeenCalledWith(challenge)
  })

  it('aborts validation on provider disposal and cannot publish its late result', async () => {
    const { picker, provider, dispose } = await setup()
    let resolve!: (value: { purpose: 'open-zip'; expiresAt: number }) => void
    let signal!: AbortSignal
    provider.validate = vi.fn<TrustedFilePickerProvider['validate']>((_challenge, inputSignal) => {
      signal = inputSignal
      return new Promise<{ purpose: 'open-zip'; expiresAt: number }>((done) => { resolve = done })
    })
    const pending = picker.validate(challenge)
    dispose()
    expect(signal.aborted).toBe(true)
    resolve({ purpose: 'open-zip', expiresAt: Date.now() + 10_000 })
    expect(await pending).toBeNull()
    expect(provider.revoke).toHaveBeenCalledWith(challenge)
  })

  it('revokes on expiry and rejects late complete acknowledgements', async () => {
    vi.useFakeTimers()
    const { picker, provider } = await setup()
    await picker.validate(challenge)
    let resolve!: (value: 'selected') => void
    provider.complete = vi.fn(() => new Promise<'selected'>((done) => { resolve = done }))
    const pending = picker.complete(challenge, '/tmp/backup.zip')
    await vi.advanceTimersByTimeAsync(60_000)
    resolve('selected')
    expect(await pending).toBe('rejected')
    expect(provider.revoke).toHaveBeenCalledWith(challenge)
  })

  it('revokes explicit cancellation and never revives an in-flight lookup', async () => {
    const { picker, provider } = await setup()
    let resolve!: (value: { purpose: 'open-zip'; expiresAt: number }) => void
    provider.validate = vi.fn(() => new Promise<{ purpose: 'open-zip'; expiresAt: number }>((done) => { resolve = done }))
    const pending = picker.validate(challenge)
    picker.revoke(challenge)
    resolve({ purpose: 'open-zip', expiresAt: Date.now() + 10_000 })
    expect(await pending).toBeNull()
    expect(await picker.complete(challenge, '/tmp/archive.zip')).toBe('rejected')
    expect(provider.complete).not.toHaveBeenCalled()
  })

  it('forwards native cancellation and revokes the unconsumed selection', async () => {
    const { picker, provider } = await setup()
    provider.complete = vi.fn<TrustedFilePickerProvider['complete']>(async () => 'cancelled')
    await picker.validate(challenge)
    expect(await picker.complete(challenge, null)).toBe('cancelled')
    expect(provider.complete).toHaveBeenCalledWith(challenge, null, expect.any(AbortSignal))
    expect(provider.revoke).toHaveBeenCalledWith(challenge)
  })

  it('rejects stale and overlong lifetimes and revokes exceptions', async () => {
    vi.useFakeTimers()
    const { picker, provider } = await setup()
    provider.validate = vi.fn<TrustedFilePickerProvider['validate']>(async () => ({ purpose: 'save-zip', expiresAt: Date.now() - 1 }))
    expect(await picker.validate(challenge)).toBeNull()
    provider.validate = vi.fn<TrustedFilePickerProvider['validate']>(async () => ({ purpose: 'save-zip', expiresAt: Date.now() + 120_001 }))
    expect(await picker.validate(challenge)).toBeNull()
    provider.validate = vi.fn(async () => { throw new Error('lookup') })
    await expect(picker.validate(challenge)).rejects.toThrow('lookup')
    provider.validate = vi.fn<TrustedFilePickerProvider['validate']>(async () => ({ purpose: 'save-zip', expiresAt: Date.now() + 60_000 }))
    await picker.validate(challenge)
    provider.complete = vi.fn(async () => { throw new Error('admission') })
    await expect(picker.complete(challenge, '/tmp/backup.zip')).rejects.toThrow('admission')
    expect(provider.revoke).toHaveBeenCalledWith(challenge)
  })

  it('cancels the live reservation on service unload', async () => {
    const { ctx, picker, provider, fiber } = await setup()
    await picker.validate(challenge)
    await fiber.dispose()
    expect(provider.revoke).toHaveBeenCalledWith(challenge)
    expect(ctx.get('trustedFilePicker')).toBeUndefined()
  })

  it('contains a broken revoke callback and disables further admission', async () => {
    const { picker, provider, dispose } = await setup()
    provider.revoke = vi.fn(() => { throw new Error('broken ledger cleanup') })
    await picker.validate(challenge)
    expect(dispose).not.toThrow()
    expect(await picker.validate(challenge)).toBeNull()
    expect(() => picker.register(provider)).toThrow('restart the Host')
    expect(() => picker.revoke(challenge)).toThrow('uncertain')
  })
})
