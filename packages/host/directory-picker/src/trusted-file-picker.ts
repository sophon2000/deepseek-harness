/** Trusted Desktop selection registration; never exposed as a Remote service. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Unpredictable, owner-scoped selection challenge issued by a trusted Host consumer. */
export type TrustedFilePickerChallenge = Branded<'TrustedFilePickerChallenge'>

/** Fixed native dialog choices; none conveys filesystem access by itself. */
export interface TrustedFilePickerSpec {
  readonly purpose: 'save-zip' | 'open-zip' | 'select-directory'
  readonly expiresAt: number
}

/** Selection admission result, not an operation result. */
export type TrustedFilePickerStatus = 'selected' | 'cancelled' | 'rejected'

/**
 * Trusted consumer owning the challenge ledger and business authorization.
 * Every call must check the current actor, session, workspace and lifecycle.
 * Completion must check cancellation immediately before publishing a grant.
 * Successful completion ends the selection signal; the ledger owns the grant's
 * separate lifetime until consumption, revocation or expiry.
 */
export interface TrustedFilePickerProvider {
  /**
   * @param challenge - Owner-issued challenge.
   * @param signal - Selection lifetime.
   * @returns Current authorization, or null for refusal.
   */
  validate(challenge: TrustedFilePickerChallenge, signal: AbortSignal): Promise<TrustedFilePickerSpec | null>
  /**
   * @param challenge - Claimed challenge.
   * @param selectedPath - Main-only selection, or cancellation.
   * @param signal - Selection lifetime.
   * @returns Fresh admission decision after validating filesystem and owner state.
   */
  complete(challenge: TrustedFilePickerChallenge, selectedPath: string | null, signal: AbortSignal): Promise<TrustedFilePickerStatus>
  /** @param challenge - Revoke pending and selected-unconsumed grants synchronously without throwing; never cancel a consumed operation. */
  revoke(challenge: TrustedFilePickerChallenge): void
}

interface Claim {
  readonly challenge: TrustedFilePickerChallenge
  readonly provider: TrustedFilePickerProvider
  readonly controller: AbortController
  timer: ReturnType<typeof setTimeout>
  phase: 'validating' | 'ready' | 'completing'
  expiresAt: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { trustedFilePicker: TrustedFilePicker }
}

/** Desktop-only registry and single-dialog reservation owned by the Host process. */
export class TrustedFilePicker extends Service {
  private provider: TrustedFilePickerProvider | undefined
  private claim: Claim | undefined
  private failed = false

  constructor(ctx: Context) {
    super(ctx, 'trustedFilePicker')
    ctx.effect(() => () => { this.cancelClaim(); this.provider = undefined })
  }

  /**
   * Register the trusted consumer from the Desktop composition, never from wire input.
   * @param provider - Sole ledger owner; duplicate registration throws.
   * @returns Disposer that revokes the live selection before removing its owner.
   */
  register(provider: TrustedFilePickerProvider): () => void {
    if (this.failed) throw new Error('Trusted file picker cleanup failed; restart the Host before registering')
    if (this.provider !== undefined) throw new Error('Trusted file picker already has a provider')
    this.provider = provider
    return () => {
      if (this.provider !== provider) return
      this.cancelClaim()
      this.provider = undefined
    }
  }

  /**
   * Reserve a dialog after validating a trusted parent challenge.
   * @param challenge - Challenge delivered exclusively by parent IPC.
   * @returns A reserved dialog description, or null.
   */
  async validate(challenge: TrustedFilePickerChallenge): Promise<TrustedFilePickerSpec | null> {
    const provider = this.provider
    if (provider === undefined || this.claim !== undefined) return null
    const controller = new AbortController()
    const claim: Claim = {
      challenge, provider, controller, phase: 'validating', expiresAt: Date.now() + 120_000,
      timer: setTimeout(() => { if (this.claim === claim) this.cancelClaim() }, 120_000),
    }
    claim.timer.unref()
    this.claim = claim
    try {
      const spec = await provider.validate(challenge, controller.signal)
      if (this.claim !== claim || controller.signal.aborted) return null
      if (spec === null || !Number.isSafeInteger(spec.expiresAt) || spec.expiresAt <= Date.now() || spec.expiresAt > claim.expiresAt) {
        this.cancelClaim()
        return null
      }
      claim.expiresAt = spec.expiresAt
      clearTimeout(claim.timer)
      claim.timer = setTimeout(() => { if (this.claim === claim) this.cancelClaim() }, spec.expiresAt - Date.now())
      claim.timer.unref()
      claim.phase = 'ready'
      return spec
    } catch (error) {
      if (this.claim === claim) this.cancelClaim()
      throw error
    }
  }

  /**
   * Complete the reserved dialog with the trusted main-process result.
   * @param challenge - Reserved challenge.
   * @param selectedPath - Main-owned dialog result only.
   * @returns Admission status; replay and stale claims are rejected.
   */
  async complete(challenge: TrustedFilePickerChallenge, selectedPath: string | null): Promise<TrustedFilePickerStatus> {
    const claim = this.claim
    if (claim === undefined || claim.challenge !== challenge || claim.phase !== 'ready') return 'rejected'
    if (claim.expiresAt <= Date.now()) { this.cancelClaim(); return 'rejected' }
    claim.phase = 'completing'
    try {
      const status = await claim.provider.complete(challenge, selectedPath, claim.controller.signal)
      if (this.claim !== claim || claim.controller.signal.aborted || claim.expiresAt <= Date.now()) {
        this.revokeProvider(claim.provider, challenge)
        return 'rejected'
      }
      if (status !== 'selected') this.revokeProvider(claim.provider, challenge)
      return status
    } catch (error) {
      this.revokeProvider(claim.provider, challenge)
      throw error
    } finally {
      if (this.claim === claim) {
        this.claim = undefined
        clearTimeout(claim.timer)
        claim.controller.abort()
      }
    }
  }

  /**
   * Revoke a reservation or an unconsumed selection after acknowledgement loss.
   * @param challenge - Pending or selected-unconsumed challenge to revoke.
   */
  revoke(challenge: TrustedFilePickerChallenge): void {
    if (this.claim?.challenge === challenge) this.cancelClaim()
    else if (this.provider !== undefined) this.revokeProvider(this.provider, challenge)
    if (this.failed) throw new Error('Trusted file picker revocation is uncertain; restart the Host')
  }

  /** End parent transport lifetime before shutdown or disconnection. */
  cancel(): void { this.cancelClaim() }

  private cancelClaim(): void {
    const claim = this.claim
    if (claim === undefined) return
    this.claim = undefined
    clearTimeout(claim.timer)
    claim.controller.abort()
    this.revokeProvider(claim.provider, claim.challenge)
  }

  private revokeProvider(provider: TrustedFilePickerProvider, challenge: TrustedFilePickerChallenge): void {
    try { provider.revoke(challenge) }
    catch (error) {
      this.failed = true
      this.provider = undefined
      this.ctx.logger.error('Trusted file picker revocation failed; selection state is uncertain and the picker is disabled until Host restart', error)
    }
  }
}
