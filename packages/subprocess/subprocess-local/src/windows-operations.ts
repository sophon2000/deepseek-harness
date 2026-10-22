/** Windows operation ownership: authenticate, permanently seal admission, then observe the OS Job. */

import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  SubprocessHandle, SubprocessSpawnSpec, SubprocessOperationDescriptor, SubprocessOperationLocator,
  SubprocessOperationOwnerKey, SubprocessOperationProvider, SubprocessOperationProviderOptions,
  SubprocessOperationRecovery, SubprocessOperationScope, SubprocessQuiescenceProof,
} from '@deepseek-ai/dsh-subprocess'
import {
  closeHandleChecked, isJobEmpty, isNullPtr, loadWin32OperationBindings, spawnCurrentTokenOperationProcess,
  terminateJob, throwLastError, windowsBootIdentity,
  type CurrentTokenProcessSpawnOptions, type NativePtr, type SpawnedJobProcess, type Win32OperationBindings,
} from '@deepseek-ai/dsh-win32-process'
import {
  OperationAdmissionBusy, OperationIdentityMismatch, WindowsOperationStore, type WindowsOperationRecord,
} from './operation-store.ts'

/** Private IPC launch identity; the runner independently authenticates it under admission exclusion. */
export interface WindowsOperationLaunch {
  stateDirectory: string
  descriptor: SubprocessOperationDescriptor
  expectedOwnerKey: SubprocessOperationOwnerKey
}

function supported(descriptor: SubprocessOperationDescriptor): boolean {
  return descriptor.providerKind === 'windows-job-list' && descriptor.providerVersion === 1
}

function ensureJobLimits(api: Win32OperationBindings, job: NativePtr): void {
  const information = Buffer.alloc(144)
  if (api.queryInformationJobObject(job, 9, information, information.length, null) === 0) throwLastError(api, 'QueryInformationJobObject')
  if (information.readUInt32LE(16) !== 0x2000) throw new Error('Operation Job limits differ from kill-on-close without breakaway')
}

function sameBoot(api: Win32OperationBindings, record: WindowsOperationRecord): boolean {
  const identity = windowsBootIdentity(api)
  return record.boot === identity.boot && record.session === identity.session
}

function releaseResources(
  api: Win32OperationBindings,
  handles: Array<{ handle: NativePtr; label: string }>,
  store?: WindowsOperationStore,
): void {
  const failures: unknown[] = []
  for (const { handle, label } of handles) {
    try { closeHandleChecked(api, handle, label) } catch (error) { failures.push(error) }
  }
  if (store !== undefined) {
    try { store.dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Operation native resource release failed')
}

/** Trusted local provider; no child or runner starts until a returned scope is explicitly used. */
export class WindowsOperationProvider implements SubprocessOperationProvider {
  private store: WindowsOperationStore | undefined
  private readonly jobs = new Map<string, { job: NativePtr; descriptor: SubprocessOperationDescriptor; sealed: boolean }>()
  private readonly proofs = new WeakMap<SubprocessQuiescenceProof, string>()
  private disposed = false
  private closing = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly options: SubprocessOperationProviderOptions,
    private readonly launch: (spec: SubprocessSpawnSpec, operation: WindowsOperationLaunch) => SubprocessHandle,
    private readonly api: Win32OperationBindings = loadWin32OperationBindings(),
  ) {}

  private storage(create: boolean): WindowsOperationStore {
    if (this.disposed) throw new Error('Operation provider is disposed')
    return this.store ??= new WindowsOperationStore(this.api, this.options.stateDirectory, create)
  }

  create(ownerKey: SubprocessOperationOwnerKey) {
    return Promise.resolve().then(() => this.createFresh(ownerKey))
  }

  private createFresh(ownerKey: SubprocessOperationOwnerKey) {
    if (this.closing) throw new Error('Operation provider is disposing')
    const identity = windowsBootIdentity(this.api)
    const store = this.storage(true)
    const locator = randomBytes(16).toString('hex') as SubprocessOperationLocator
    const descriptor = Object.freeze({ providerKind: 'windows-job-list', providerVersion: 1, locator, ownerKey })
    const record: WindowsOperationRecord = { v: 1, locator, ownerKey, root: store.root,
      machine: store.machine, ...identity, job: `Local\\DSH-operation-${store.machine}-${locator}` }
    const lock = store.lock(locator, true)
    let job: NativePtr | undefined
    try {
      job = store.createJob(record.job)
      store.initialize(lock, record)
      this.jobs.set(locator, { job, descriptor, sealed: false })
    } catch (error) {
      if (job !== undefined) closeHandleChecked(this.api, job, 'failed operation creation')
      throw error
    } finally { closeHandleChecked(this.api, lock, 'operation creation admission') }
    const scope: SubprocessOperationScope = Object.freeze({
      descriptor,
      spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => {
        if (this.disposed || this.closing || this.jobs.get(locator)?.sealed !== false) throw new Error('Operation is sealed or provider disposed')
        return this.launch(spec, { stateDirectory: store.root, descriptor, expectedOwnerKey: ownerKey })
      },
      seal: (signal?: AbortSignal) => this.recover(descriptor, ownerKey, signal),
    })
    return { kind: 'created' as const, scope }
  }

  recover(
    descriptor: SubprocessOperationDescriptor | undefined,
    expectedOwnerKey: SubprocessOperationOwnerKey,
    signal?: AbortSignal,
  ): Promise<SubprocessOperationRecovery> {
    try { return Promise.resolve(this.observe(descriptor, expectedOwnerKey, signal)) }
    catch (error) {
      return Promise.resolve({ kind: 'unverifiable', reason: 'native-failure', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  private observe(
    descriptor: SubprocessOperationDescriptor | undefined,
    expectedOwnerKey: SubprocessOperationOwnerKey,
    signal?: AbortSignal,
  ): SubprocessOperationRecovery {
    if (descriptor === undefined) return { kind: 'unverifiable', reason: 'legacy-no-scope', detail: 'No durable operation descriptor' }
    if (!supported(descriptor)) return { kind: 'unsupported', providerKind: descriptor.providerKind, providerVersion: descriptor.providerVersion }
    if (descriptor.ownerKey !== expectedOwnerKey) return { kind: 'unverifiable', reason: 'identity-mismatch', detail: 'Independent consumer owner differs' }
    if (signal?.aborted) return { kind: 'active', sealed: false, reason: 'aborted' }
    let lock: NativePtr | undefined
    let job: NativePtr | undefined
    let sealed = false
    let phase: 'store-failure' | 'native-failure' = 'store-failure'
    try {
      const store = this.storage(false)
      lock = store.lock(descriptor.locator)
      const record = store.authenticate(lock, descriptor, expectedOwnerKey)
      phase = 'native-failure'
      if (!sameBoot(this.api, record)) return { kind: 'unverifiable', reason: 'boot-mismatch', detail: 'Kernel boot or Windows session differs' }
      phase = 'store-failure'
      store.seal(record)
      sealed = true
      // A delayed in-process spawn can still create a runner, but its native admission is now sealed.
      const owned = this.jobs.get(descriptor.locator)
      if (owned !== undefined) owned.sealed = true
      phase = 'native-failure'
      job = this.api.openJob(0x0F, 0, record.job) ?? undefined
      if (isNullPtr(job)) {
        if (this.api.getLastError() !== 2) throwLastError(this.api, 'OpenJobObjectW')
        throw new Error('Operation Job name is absent; member quiescence cannot be observed')
      }
      ensureJobLimits(this.api, job)
      const observedJob = job
      if (owned === undefined) {
        // Keep a native reference across draining/idempotent retries; namespace absence is never evidence.
        this.jobs.set(descriptor.locator, { job: observedJob, descriptor: Object.freeze({ ...descriptor }), sealed: true })
        job = undefined
      }
      terminateJob(this.api, observedJob, 1)
      if (!isJobEmpty(this.api, observedJob)) return { kind: 'active', sealed: true, reason: signal?.aborted ? 'aborted' : 'draining' }
      const proof = Object.freeze({}) as SubprocessQuiescenceProof
      this.proofs.set(proof, this.proofBinding(descriptor, expectedOwnerKey))
      return { kind: 'sealed-quiescent', proof }
    } catch (error) {
      if (error instanceof OperationAdmissionBusy) return { kind: 'active', sealed, reason: 'busy' }
      return { kind: 'unverifiable', reason: error instanceof OperationIdentityMismatch ? 'identity-mismatch' : phase,
        detail: error instanceof Error ? error.message : String(error) }
    } finally {
      releaseResources(this.api, [
        ...isNullPtr(job) ? [] : [{ handle: job, label: 'operation recovery observation' }],
        ...lock === undefined ? [] : [{ handle: lock, label: 'operation recovery admission' }],
      ])
    }
  }

  verify(
    proof: SubprocessQuiescenceProof,
    descriptor: SubprocessOperationDescriptor,
    expectedOwnerKey: SubprocessOperationOwnerKey,
  ): boolean {
    return !this.disposed && descriptor.ownerKey === expectedOwnerKey
      && this.proofs.get(proof) === this.proofBinding(descriptor, expectedOwnerKey)
  }

  private proofBinding(descriptor: SubprocessOperationDescriptor, expected: SubprocessOperationOwnerKey): string {
    return JSON.stringify([descriptor.providerKind, descriptor.providerVersion, descriptor.locator, descriptor.ownerKey, expected])
  }

  dispose(): Promise<void> {
    return this.disposal ??= this.disposeOwned()
  }

  private async disposeOwned(): Promise<void> {
    if (this.disposed) return
    this.closing = true
    const failures: string[] = []
    for (const { descriptor } of [...this.jobs.values()]) {
      let result: SubprocessOperationRecovery
      do {
        result = await this.recover(descriptor, descriptor.ownerKey)
        if (result.kind === 'active') await delay(10)
      } while (result.kind === 'active')
      if (result.kind !== 'sealed-quiescent') failures.push(JSON.stringify(result))
    }
    const handles = [...this.jobs.values()].map(({ job }) => ({ handle: job, label: 'failed operation disposal' }))
    this.jobs.clear()
    try { releaseResources(this.api, handles, this.store) }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
    this.disposed = true
    if (failures.length > 0) throw new Error(`Operation disposal could not prove quiescence: ${failures.join('; ')}`)
  }
}

/**
 * Admit one runner under the same immutable exclusion used by recovery, then atomically create its target.
 * @param request - provider-private launch identity.
 * @param options - resolved target and stdio carriers.
 * @param cancelled - current runner disconnect/cancellation state checked after each asynchronous wait.
 * @param api - active native operation bindings; omission loads the native table.
 * @returns runner-owned per-child Job and direct process handles.
 */
export async function launchWindowsOperationTarget(
  request: WindowsOperationLaunch,
  options: CurrentTokenProcessSpawnOptions,
  cancelled: () => boolean,
  api = loadWin32OperationBindings(),
): Promise<SpawnedJobProcess> {
  const store = new WindowsOperationStore(api, request.stateDirectory, false)
  let lock: NativePtr | undefined
  let job: NativePtr | undefined
  try {
    if (!supported(request.descriptor)) throw new OperationIdentityMismatch('Unsupported operation launch provider')
    while (lock === undefined) {
      if (cancelled()) throw new Error('Operation launch cancelled before native creation')
      try { lock = store.lock(request.descriptor.locator) }
      catch (error) { if (!(error instanceof OperationAdmissionBusy)) throw error; await delay(10) }
    }
    const record = store.authenticate(lock, request.descriptor, request.expectedOwnerKey)
    if (!sameBoot(api, record)) throw new OperationIdentityMismatch('Operation boot or session differs')
    if (store.sealed(record.locator)) throw new Error('Operation permanently sealed')
    if (cancelled()) throw new Error('Operation launch cancelled before native creation')
    job = api.openJob(0x0F, 0, record.job) ?? undefined
    if (isNullPtr(job)) throwLastError(api, 'OpenJobObjectW', 'operation launch never creates a missing Job')
    ensureJobLimits(api, job)
    return spawnCurrentTokenOperationProcess(api, options, job)
  } finally {
    releaseResources(api, [
      ...isNullPtr(job) ? [] : [{ handle: job, label: 'operation runner Job reference' }],
      ...lock === undefined ? [] : [{ handle: lock, label: 'operation runner admission' }],
    ], store)
  }
}
