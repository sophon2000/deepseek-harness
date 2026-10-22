/** Authenticated Windows operation admission; file contents never certify native quiescence. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import {
  isNullPtr, throwLastError, windowsMachineProtection,
  Win32Error,
  decodeWindowsStringPointer,
  type NativePtr, type Win32OperationBindings,
} from '@deepseek-ai/dsh-win32-process'
import type { SubprocessOperationDescriptor, SubprocessOperationOwnerKey } from '@deepseek-ai/dsh-subprocess'

/** Immutable identity authenticated before native Job access. */
export interface WindowsOperationRecord {
  v: 1
  locator: string
  ownerKey: string
  root: string
  machine: string
  boot: string
  session: number
  job: string
}

/** Durable admission currently belongs to another native creator or recovery attempt. */
export class OperationAdmissionBusy extends Error {}
/** Provider identity or the independently supplied consumer binding does not match. */
export class OperationIdentityMismatch extends Error {}

const invalidHandle = 0xffff_ffff_ffff_ffffn

function pointer(slot: Buffer): NativePtr { return slot.readBigUInt64LE() as NativePtr }

function close(api: Win32OperationBindings, handle: NativePtr): void {
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', 'operation store')
}

function sidText(api: Win32OperationBindings, sid: NativePtr): string {
  const slot = Buffer.alloc(8)
  if (api.sidToString(sid, slot) === 0) throwLastError(api, 'ConvertSidToStringSidW')
  const text = pointer(slot)
  try { return decodeWindowsStringPointer(slot) } finally { api.localFree(text) }
}

function currentSid(api: Win32OperationBindings): string {
  const slot = Buffer.alloc(8)
  if (api.openToken(api.currentProcess(), 8, slot) === 0) throwLastError(api, 'OpenProcessToken')
  const token = pointer(slot)
  try {
    const info = Buffer.alloc(4096)
    const returned = Buffer.alloc(4)
    if (api.tokenInformation(token, 1, info, info.length, returned) === 0) throwLastError(api, 'GetTokenInformation')
    if (returned.readUInt32LE() < 16 || returned.readUInt32LE() > info.length) throw new Error('Invalid token identity')
    return sidText(api, pointer(info))
  } finally { close(api, token) }
}

function withSecurity<T>(api: Win32OperationBindings, sddl: string, action: (attributes: Buffer) => T): T {
  const slot = Buffer.alloc(8)
  if (api.securityFromString(sddl, 1, slot, null) === 0) throwLastError(api, 'ConvertStringSecurityDescriptorToSecurityDescriptorW')
  const security = pointer(slot)
  const attributes = Buffer.alloc(24)
  attributes.writeUInt32LE(24)
  attributes.writeBigUInt64LE(security, 8)
  try { return action(attributes) } finally { api.localFree(security) }
}

function validatePrivateRoot(api: Win32OperationBindings, path: string, sid: string): void {
  const owner = Buffer.alloc(8)
  const slot = Buffer.alloc(8)
  const error = api.namedSecurity(path, 1, 5, owner, null, null, null, slot)
  if (error !== 0) throw new Error(`GetNamedSecurityInfoW failed: ${error}`)
  const security = pointer(slot)
  const textSlot = Buffer.alloc(8)
  try {
    if (sidText(api, pointer(owner)) !== sid) throw new Error('Operation store owner differs from current token')
    if (api.securityToString(security, 1, 4, textSlot, null) === 0) throwLastError(api, 'ConvertSecurityDescriptorToStringSecurityDescriptorW')
    const text = pointer(textSlot)
    try {
      const value = decodeWindowsStringPointer(textSlot)
      if (value !== `D:P(A;OICI;FA;;;${sid})`) throw new Error(`Operation store DACL is not private: ${value}`)
    } finally { api.localFree(text) }
  } finally { api.localFree(security) }
}

function checkedFile(api: Win32OperationBindings, path: string, write: boolean, create: boolean, directory = false): NativePtr {
  const handle = api.createFile(path, directory ? 0x80 : write ? 0xC0000000 : 0x80000000,
    directory ? 3 : write ? 0 : 1, null, create ? 1 : 3,
    directory ? 0x02200000 : write ? 0x80200000 : 0x00200000, null)
  if (isNullPtr(handle) || handle === invalidHandle) {
    if (api.getLastError() === 32) throw new OperationAdmissionBusy('Operation admission is held')
    throwLastError(api, 'CreateFileW', path)
  }
  try {
    const info = Buffer.alloc(52)
    if (api.fileInformation(handle, info) === 0) throwLastError(api, 'GetFileInformationByHandle')
    const attributes = info.readUInt32LE()
    if ((attributes & 0x400) !== 0 || ((attributes & 0x10) !== 0) !== directory) throw new Error('Operation store contains a reparse point or wrong object kind')
    return handle
  } catch (error) { close(api, handle); throw error }
}

function read(api: Win32OperationBindings, handle: NativePtr): Buffer {
  if (api.seekFile(handle, 0, null, 0) === 0) throwLastError(api, 'SetFilePointerEx')
  const bytes = Buffer.alloc(65537)
  const count = Buffer.alloc(4)
  if (api.readOperationFile(handle, bytes, bytes.length, count, null) === 0) throwLastError(api, 'ReadFile')
  const length = count.readUInt32LE()
  if (length > 65536) throw new Error('Operation record exceeds size limit')
  return bytes.subarray(0, length)
}

function write(api: Win32OperationBindings, handle: NativePtr, bytes: Buffer): void {
  const count = Buffer.alloc(4)
  if (api.writeOperationFile(handle, bytes, bytes.length, count, null) === 0) throwLastError(api, 'WriteFile')
  if (count.readUInt32LE() !== bytes.length) throw new Error('Incomplete operation record write')
  if (api.flushFile(handle) === 0) throwLastError(api, 'FlushFileBuffers')
}

function recordValue(value: unknown): WindowsOperationRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operation identity')
  const data = value as Record<string, unknown>
  if (Object.keys(data).sort().join(',') !== 'boot,job,locator,machine,ownerKey,root,session,v'
    || data.v !== 1 || typeof data.locator !== 'string' || typeof data.ownerKey !== 'string'
    || typeof data.root !== 'string' || typeof data.machine !== 'string' || typeof data.boot !== 'string'
    || typeof data.job !== 'string' || typeof data.session !== 'number' || !Number.isSafeInteger(data.session)) {
    throw new Error('Invalid operation identity fields')
  }
  return { v: 1, locator: data.locator, ownerKey: data.ownerKey, root: data.root,
    machine: data.machine, boot: data.boot, session: data.session, job: data.job }
}

/** Provider-owned private storage, pinned against ancestor rename and reparse replacement. */
export class WindowsOperationStore {
  readonly root: string
  readonly machine: string
  private readonly pins: NativePtr[] = []
  private key: Buffer = Buffer.alloc(0)
  private readonly sid: string

  constructor(readonly api: Win32OperationBindings, path: string, create: boolean) {
    if (!isAbsolute(path)) throw new Error('Operation stateDirectory must be absolute')
    this.root = resolve(path).toLowerCase()
    if (api.driveType(parse(this.root).root) !== 3) throw new Error('Operation store requires a fixed local Windows volume')
    this.sid = currentSid(api)
    try {
      const parents: string[] = []
      let parent = dirname(this.root)
      for (;;) {
        parents.unshift(parent)
        const next = dirname(parent)
        if (next === parent) break
        parent = next
      }
      for (const ancestor of parents) this.pins.push(checkedFile(api, ancestor, false, false, true))
      let created = false
      if (create) {
        const result = withSecurity(api, `O:${this.sid}D:P(A;OICI;FA;;;${this.sid})`, attributes => {
          const success = api.createDirectory(this.root, attributes) !== 0
          return { success, error: api.getLastError() }
        })
        created = result.success
        if (!created && result.error !== 183) throw new Win32Error('CreateDirectoryW', result.error)
      }
      this.pins.push(checkedFile(api, this.root, false, false, true))
      validatePrivateRoot(api, this.root, this.sid)
      if (created) {
        const key = randomBytes(32)
        const handle = checkedFile(api, join(this.root, 'machine-key'), true, true)
        try { write(api, handle, windowsMachineProtection(api, key, false)) } finally { close(api, handle) }
      }
      const keyHandle = checkedFile(api, join(this.root, 'machine-key'), false, false)
      try { this.key = windowsMachineProtection(api, read(api, keyHandle), true) } finally { close(api, keyHandle) }
      if (this.key.length !== 32) throw new Error('Invalid machine-protected provider key')
      this.machine = createHash('sha256').update(this.key).digest('hex')
    } catch (error) { this.dispose(); throw error }
  }

  /** Release only handles owned by this store instance. */
  dispose(): void {
    for (const handle of this.pins.splice(0).reverse()) close(this.api, handle)
    this.key.fill(0)
  }

  /**
   * Create a fresh operation Job with a private DACL; reject name collisions.
   * @param name - random provider-generated Job name.
   * @returns an exclusively initialized kill-on-close Job handle.
   */
  createJob(name: string): NativePtr {
    const job = withSecurity(this.api, `O:${this.sid}D:P(A;;GA;;;${this.sid})`, attributes => {
      const handle = this.api.createNamedJob(attributes, name)
      const error = this.api.getLastError()
      if (isNullPtr(handle)) throwLastError(this.api, 'CreateJobObjectW')
      if (error === 183) { close(this.api, handle); throw new Error('Operation Job name already exists') }
      return handle
    })
    try {
      const limits = Buffer.alloc(144)
      limits.writeUInt32LE(0x2000, 16)
      if (this.api.setInformationJobObject(job, 9, limits, limits.length) === 0) throwLastError(this.api, 'SetInformationJobObject')
      return job
    } catch (error) { close(this.api, job); throw error }
  }

  /**
   * Acquire the existing immutable admission file, or exclusively create it for a new operation.
   * @param locator - provider-generated random locator.
   * @param create - true only during initial operation creation.
   * @returns an OS-owned exclusion handle; callers close it after launch or seal.
   */
  lock(locator: string, create = false): NativePtr {
    if (!/^[a-f0-9]{32}$/.test(locator)) throw new OperationIdentityMismatch('Invalid operation locator')
    return checkedFile(this.api, join(this.root, `${locator}.admission`), true, create)
  }

  /**
   * Persist immutable authenticated identity under the admission lock.
   * @param handle - newly created admission file.
   * @param record - identity for this store.
   */
  initialize(handle: NativePtr, record: WindowsOperationRecord): void {
    const payload = JSON.stringify(record)
    write(this.api, handle, Buffer.from(JSON.stringify({ payload, mac: this.mac(payload) })))
  }

  /**
   * Authenticate stored identity and independently authorized owner before Job access.
   * @param handle - held admission lock.
   * @param descriptor - trusted reservation descriptor.
   * @param expected - independently derived consumer owner.
   * @returns the authenticated identity for this installation and root.
   */
  authenticate(handle: NativePtr, descriptor: SubprocessOperationDescriptor, expected: SubprocessOperationOwnerKey): WindowsOperationRecord {
    const value: unknown = JSON.parse(read(this.api, handle).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operation envelope')
    const envelope = value as Record<string, unknown>
    if (Object.keys(envelope).sort().join(',') !== 'mac,payload' || typeof envelope.payload !== 'string'
      || typeof envelope.mac !== 'string' || !this.matches(envelope.mac, this.mac(envelope.payload))) throw new OperationIdentityMismatch('Operation identity authentication failed')
    const record = recordValue(JSON.parse(envelope.payload))
    if (record.locator !== descriptor.locator || record.ownerKey !== expected || descriptor.ownerKey !== expected
      || record.root !== this.root || record.machine !== this.machine
      || record.job !== `Local\\DSH-operation-${record.machine}-${record.locator}`) throw new OperationIdentityMismatch('Operation owner, locator, or installation mismatch')
    return record
  }

  /**
   * Return whether any permanent seal exists; malformed seals also forbid launch.
   * @param locator - authenticated operation locator.
   * @returns true for any existing seal; only exact file-not-found means no seal.
   */
  sealed(locator: string): boolean {
    let handle: NativePtr
    try { handle = checkedFile(this.api, join(this.root, `${locator}.seal`), false, false) }
    catch (error) { if (error instanceof Win32Error && error.win32Code === 2) return false; throw error }
    close(this.api, handle)
    return true
  }

  /**
   * Commit or revalidate and flush a permanent one-way seal while holding admission.
   * @param record - authenticated operation identity.
   */
  seal(record: WindowsOperationRecord): void {
    const path = join(this.root, `${record.locator}.seal`)
    const expected = this.mac('seal:' + JSON.stringify(record))
    let created = false
    let handle: NativePtr
    try { handle = checkedFile(this.api, path, true, true); created = true }
    catch (error) {
      if (!(error instanceof Win32Error) || (error.win32Code !== 80 && error.win32Code !== 183)) throw error
      handle = checkedFile(this.api, path, true, false)
    }
    try {
      if (created) write(this.api, handle, Buffer.from(expected))
      else {
        if (!this.matches(read(this.api, handle).toString('utf8'), expected)) throw new Error('Invalid permanent operation seal')
        if (this.api.flushFile(handle) === 0) throwLastError(this.api, 'FlushFileBuffers')
      }
    } finally { close(this.api, handle) }
  }

  private mac(value: string): string { return createHmac('sha256', this.key).update(value).digest('hex') }
  private matches(left: string, right: string): boolean {
    return /^[a-f0-9]{64}$/.test(left) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  }
}
