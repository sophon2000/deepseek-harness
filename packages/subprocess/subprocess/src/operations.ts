/** Durable operation admission and provider-issued native quiescence evidence. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SubprocessHandle, SubprocessSpawnSpec } from './types.ts'

declare const proofBrand: unique symbol

/** Trusted consumer identity independently derived from durable home/project/domain/receipt identity. */
export type SubprocessOperationOwnerKey = Branded<'SubprocessOperationOwnerKey'>
/** Provider locator saved in trusted reservations, never accepted from a client request. */
export type SubprocessOperationLocator = Branded<'SubprocessOperationLocator'>

/** Persist with the reservation before the first spawn; retain after crashes. */
export interface SubprocessOperationDescriptor {
  readonly providerKind: string
  readonly providerVersion: number
  readonly locator: SubprocessOperationLocator
  readonly ownerKey: SubprocessOperationOwnerKey
}

/** In-process evidence accepted only by its issuing provider instance; JSON is not authority. */
export interface SubprocessQuiescenceProof {
  readonly [proofBrand]: true
}

/** Failures withholding proof; none permits releasing a reservation. */
export type SubprocessRecoveryFailure =
  | 'legacy-no-scope' | 'identity-mismatch' | 'boot-mismatch' | 'store-failure' | 'native-failure'

/** Only provider-verified sealed-quiescent permits consumer reconciliation. */
export type SubprocessOperationRecovery =
  | { readonly kind: 'sealed-quiescent'; readonly proof: SubprocessQuiescenceProof }
  | { readonly kind: 'active'; readonly sealed: boolean; readonly reason: 'busy' | 'aborted' | 'draining' }
  | { readonly kind: 'unverifiable'; readonly reason: SubprocessRecoveryFailure; readonly detail: string }
  | { readonly kind: 'unsupported'; readonly providerKind: string; readonly providerVersion: number }

/** Owns every launch in one operation and stays open across zero-member intervals. */
export interface SubprocessOperationScope {
  readonly descriptor: SubprocessOperationDescriptor
  /**
   * Launch through durable admission after the consumer persists descriptor with its reservation.
   * @param spec - complete ordinary subprocess request.
   * @returns direct-result/stream handle; direct completion does not seal the operation.
   */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  /**
   * Permanently forbid launches, terminate members, and observe operation quiescence.
   * @param signal - optional wait cancellation; it never reopens admission.
   * @returns fresh native evidence or a state retaining the reservation.
   */
  seal(signal?: AbortSignal): Promise<SubprocessOperationRecovery>
}

/** Provider construction inputs owned by a trusted local consumer. */
export interface SubprocessOperationProviderOptions {
  /** Task-private local state directory; never an untrusted client path. */
  readonly stateDirectory: string
}

/** Opt-in durable capability; ordinary spawn and terminals gain no recovery guarantee. */
export interface SubprocessOperationProvider {
  /**
   * Persist fresh, exclusive admission without starting any runner or target. Never adopt an old owner scope.
   * @param ownerKey - independently generated trusted consumer binding.
   * @returns a scope to persist, or unsupported; storage failures reject without launching.
   */
  create(ownerKey: SubprocessOperationOwnerKey): Promise<
    | { readonly kind: 'created'; readonly scope: SubprocessOperationScope }
    | Extract<SubprocessOperationRecovery, { kind: 'unsupported' }>
  >
  /**
   * Authenticate binding before Job access, permanently seal, terminate, and observe native state.
   * @param descriptor - trusted reservation descriptor; absence means unverifiable legacy data.
   * @param expectedOwnerKey - independent identity, never copied from descriptor as authorization.
   * @param signal - optional wait cancellation; committed seals remain permanent.
   * @returns fresh native evidence or a state retaining the reservation.
   */
  recover(descriptor: SubprocessOperationDescriptor | undefined, expectedOwnerKey: SubprocessOperationOwnerKey, signal?: AbortSignal): Promise<SubprocessOperationRecovery>
  /**
   * Validate evidence against this issuer and the exact independently authorized operation.
   * @param proof - provider evidence; JSON copies and foreign issuers fail.
   * @param descriptor - trusted reservation descriptor.
   * @param expectedOwnerKey - independently derived owner.
   * @returns whether this issuer proved this permanently sealed operation quiescent.
   */
  verify(proof: SubprocessQuiescenceProof, descriptor: SubprocessOperationDescriptor, expectedOwnerKey: SubprocessOperationOwnerKey): boolean
  /** Seal and terminate owned scopes before releasing native handles. */
  dispose(): Promise<void>
}

/** Fail-closed implementation for execution providers without durable native operation support. */
export class UnsupportedSubprocessOperations implements SubprocessOperationProvider {
  async create(): Promise<Extract<SubprocessOperationRecovery, { kind: 'unsupported' }>> {
    return { kind: 'unsupported', providerKind: 'none', providerVersion: 0 }
  }

  async recover(descriptor: SubprocessOperationDescriptor | undefined): Promise<SubprocessOperationRecovery> {
    return descriptor === undefined
      ? { kind: 'unverifiable', reason: 'legacy-no-scope', detail: 'No durable operation descriptor' }
      : { kind: 'unsupported', providerKind: descriptor.providerKind, providerVersion: descriptor.providerVersion }
  }

  verify(): boolean { return false }

  async dispose(): Promise<void> {}
}
