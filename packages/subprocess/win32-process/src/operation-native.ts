/** Native primitives for private durable operation stores and atomic Job-list creation. */

import { extendWin32ProcessBindings, isNullPtr, throwLastError, type NativePtr } from './ffi.ts'
import { requireKoffi } from './koffi.ts'
import * as abi from './abi.ts'

/** Additional Windows APIs owned by operation admission and identity. */
export interface Win32OperationExtension {
  createNamedJob(attributes: Buffer | null, name: string): NativePtr | null
  openJob(access: number, inherit: number, name: string): NativePtr | null
  initializeAttributes(list: NativePtr | null, count: number, flags: number, size: Buffer): number
  updateAttribute(list: NativePtr, flags: number, attribute: number, value: Buffer | NativePtr, size: number, previous: null, returned: null): number
  deleteAttributes(list: NativePtr): void
  createFile(path: string, access: number, share: number, security: null, disposition: number, flags: number, template: null): NativePtr | null
  createDirectory(path: string, security: Buffer): number
  fileInformation(handle: NativePtr, information: Buffer): number
  readOperationFile(handle: NativePtr, buffer: Buffer, length: number, read: Buffer, overlapped: null): number
  writeOperationFile(handle: NativePtr, buffer: Buffer, length: number, written: Buffer, overlapped: null): number
  flushFile(handle: NativePtr): number
  seekFile(handle: NativePtr, distance: number, position: null, method: number): number
  openToken(process: NativePtr, access: number, token: Buffer): number
  currentProcess(): NativePtr
  tokenInformation(token: NativePtr, cls: number, information: Buffer, length: number, returned: Buffer): number
  sidToString(sid: NativePtr, text: Buffer): number
  securityFromString(text: string, revision: number, security: Buffer, size: null): number
  namedSecurity(path: string, type: number, flags: number, owner: Buffer, group: null, dacl: null, sacl: null, security: Buffer): number
  securityToString(security: NativePtr, revision: number, flags: number, text: Buffer, length: null): number
  protect(input: Buffer, description: null, entropy: null, reserved: null, prompt: null, flags: number, output: Buffer): number
  unprotect(input: Buffer, description: null, entropy: null, reserved: null, prompt: null, flags: number, output: Buffer): number
  localFree(pointer: NativePtr): NativePtr | null
  systemInformation(cls: number, information: Buffer, length: number, returned: Buffer): number
  processSession(pid: number, session: Buffer): number
  openProcess(access: number, inherit: number, pid: number): NativePtr | null
  driveType(root: string): number
}

/** Complete current-token binding table for recoverable operations. */
export type Win32OperationBindings = ReturnType<typeof loadWin32OperationBindings>

/**
 * Decode an output slot containing a native, null-terminated UTF-16 string pointer.
 * @param slot - pointer-sized output bytes from a successful Windows string conversion.
 * @returns the string copied into JavaScript before its native allocation is freed.
 */
export function decodeWindowsStringPointer(slot: Buffer): string {
  return requireKoffi().decode(slot, 'str16') as string
}

/**
 * Load operation-specific native APIs without launching probes or changing system state.
 * @returns current-token bindings extended with file, security, identity, and Job-list APIs.
 */
export function loadWin32OperationBindings() {
  return extendWin32ProcessBindings<Win32OperationExtension>(({ kernel32, advapi32, bind }) => {
    const koffi = requireKoffi()
    const pointer = koffi.pointer('void')
    const crypt32 = koffi.load('crypt32.dll')
    const ntdll = koffi.load('ntdll.dll')
    return {
      createNamedJob: bind(kernel32, 'CreateJobObjectW', pointer, [pointer, 'str16']),
      openJob: bind(kernel32, 'OpenJobObjectW', pointer, ['uint32', 'int', 'str16']),
      initializeAttributes: bind(kernel32, 'InitializeProcThreadAttributeList', 'int', [pointer, 'uint32', 'uint32', pointer]),
      updateAttribute: bind(kernel32, 'UpdateProcThreadAttribute', 'int', [pointer, 'uint32', 'uintptr_t', pointer, 'size_t', pointer, pointer]),
      deleteAttributes: bind(kernel32, 'DeleteProcThreadAttributeList', 'void', [pointer]),
      createFile: bind(kernel32, 'CreateFileW', pointer, ['str16', 'uint32', 'uint32', pointer, 'uint32', 'uint32', pointer]),
      createDirectory: bind(kernel32, 'CreateDirectoryW', 'int', ['str16', pointer]),
      fileInformation: bind(kernel32, 'GetFileInformationByHandle', 'int', [pointer, pointer]),
      readOperationFile: bind(kernel32, 'ReadFile', 'int', [pointer, pointer, 'uint32', pointer, pointer]),
      writeOperationFile: bind(kernel32, 'WriteFile', 'int', [pointer, pointer, 'uint32', pointer, pointer]),
      flushFile: bind(kernel32, 'FlushFileBuffers', 'int', [pointer]),
      seekFile: bind(kernel32, 'SetFilePointerEx', 'int', [pointer, 'int64', pointer, 'uint32']),
      openToken: bind(advapi32, 'OpenProcessToken', 'int', [pointer, 'uint32', pointer]),
      currentProcess: bind(kernel32, 'GetCurrentProcess', pointer, []),
      tokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [pointer, 'int', pointer, 'uint32', pointer]),
      sidToString: bind(advapi32, 'ConvertSidToStringSidW', 'int', [pointer, pointer]),
      securityFromString: bind(advapi32, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', ['str16', 'uint32', pointer, pointer]),
      namedSecurity: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', pointer, pointer, pointer, pointer, pointer]),
      securityToString: bind(advapi32, 'ConvertSecurityDescriptorToStringSecurityDescriptorW', 'int', [pointer, 'uint32', 'uint32', pointer, pointer]),
      protect: bind(crypt32, 'CryptProtectData', 'int', [pointer, 'str16', pointer, pointer, pointer, 'uint32', pointer]),
      unprotect: bind(crypt32, 'CryptUnprotectData', 'int', [pointer, pointer, pointer, pointer, pointer, 'uint32', pointer]),
      localFree: bind(kernel32, 'LocalFree', pointer, [pointer]),
      systemInformation: bind(ntdll, 'NtQuerySystemInformation', 'int32', ['int', pointer, 'uint32', pointer]),
      processSession: bind(kernel32, 'ProcessIdToSessionId', 'int', ['uint32', pointer]),
      openProcess: bind(kernel32, 'OpenProcess', pointer, ['uint32', 'int', 'uint32']),
      driveType: bind(kernel32, 'GetDriveTypeW', 'uint32', ['str16']),
    } as Win32OperationExtension
  })
}

/**
 * Read the kernel's boot UUID and current Windows session, refusing unknown native layouts.
 * @param api - operation bindings.
 * @returns exact boot UUID bytes and current object namespace session.
 */
export function windowsBootIdentity(api: Win32OperationBindings): { boot: string; session: number } {
  const information = Buffer.alloc(32)
  const returned = Buffer.alloc(4)
  const status = api.systemInformation(90, information, information.length, returned)
  if (status !== 0 || returned.readUInt32LE() !== 32 || information.subarray(0, 16).every(byte => byte === 0)) {
    throw new Error(`Windows boot identity unavailable: NTSTATUS ${status}, length ${returned.readUInt32LE()}`)
  }
  const session = Buffer.alloc(4)
  if (api.processSession(process.pid, session) === 0) throwLastError(api, 'ProcessIdToSessionId')
  return { boot: information.subarray(0, 16).toString('hex'), session: session.readUInt32LE() }
}

/**
 * Protect or unprotect provider installation material using the machine's DPAPI keys.
 * @param api - operation bindings.
 * @param bytes - plaintext key or protected bytes.
 * @param decrypt - select unprotect; false selects local-machine protection.
 * @returns independent bytes; all native blob allocations are released.
 */
export function windowsMachineProtection(api: Win32OperationBindings, bytes: Buffer, decrypt: boolean): Buffer {
  const koffi = requireKoffi()
  const data = koffi.alloc('uint8', bytes.length) as NativePtr
  const input = Buffer.alloc(16)
  const output = Buffer.alloc(16)
  input.writeUInt32LE(bytes.length)
  input.writeBigUInt64LE(data, 8)
  koffi.encode(data, 'uint8', bytes, bytes.length)
  let result: NativePtr | undefined
  try {
    const succeeded = decrypt
      ? api.unprotect(input, null, null, null, null, 1, output)
      : api.protect(input, null, null, null, null, 5, output)
    if (succeeded === 0) throwLastError(api, decrypt ? 'CryptUnprotectData' : 'CryptProtectData')
    result = output.readBigUInt64LE(8) as NativePtr
    const length = output.readUInt32LE()
    if (isNullPtr(result) || length === 0 || length > 4096) throw new Error('Invalid DPAPI result')
    return Buffer.from(koffi.decode(result, 'uint8', length) as number[])
  } finally {
    if (result !== undefined) api.localFree(result)
    koffi.free(data)
  }
}

/**
 * Build an extended startup record that assigns both operation and per-child Jobs during creation.
 * @param api - operation bindings.
 * @param startup - ordinary initialized STARTUPINFOW bytes.
 * @param jobs - operation Job followed by the runner's per-child Job.
 * @param create - synchronous CreateProcess call receiving STARTUPINFOEXW.
 * @returns the native CreateProcess result without post-create assignment.
 */
export function withAtomicJobList(api: Win32OperationBindings, startup: NativePtr, jobs: readonly NativePtr[], create: (extended: NativePtr) => number): number {
  const koffi = requireKoffi()
  const size = Buffer.alloc(8)
  if (api.initializeAttributes(null, 1, 0, size) !== 0 || api.getLastError() !== 122) throwLastError(api, 'InitializeProcThreadAttributeList')
  const length = Number(size.readBigUInt64LE())
  if (length <= 0 || length > 65536) throw new Error('Invalid process attribute-list size')
  let attributes: NativePtr | undefined
  let extended: NativePtr | undefined
  let handles: NativePtr | undefined
  let initialized = false
  try {
    attributes = koffi.alloc('uint8', length) as NativePtr
    extended = koffi.alloc('uint8', abi.STARTUPINFOEXW_SIZE) as NativePtr
    handles = koffi.alloc('uint8', jobs.length * 8) as NativePtr
    if (api.initializeAttributes(attributes, 1, 0, size) === 0) throwLastError(api, 'InitializeProcThreadAttributeList')
    initialized = true
    const values = Buffer.alloc(jobs.length * 8)
    jobs.forEach((job, index) => values.writeBigUInt64LE(job, index * 8))
    koffi.encode(handles, 'uint8', values, values.length)
    if (api.updateAttribute(attributes, 0, abi.PROC_THREAD_ATTRIBUTE_JOB_LIST, handles, values.length, null, null) === 0) throwLastError(api, 'UpdateProcThreadAttribute')
    const bytes = Buffer.alloc(abi.STARTUPINFOEXW_SIZE)
    Buffer.from(koffi.decode(startup, 'uint8', abi.STARTUPINFOW_SIZE) as number[]).copy(bytes)
    bytes.writeUInt32LE(abi.STARTUPINFOEXW_SIZE)
    bytes.writeBigUInt64LE(attributes, abi.STARTUPINFOEXW_ATTRIBUTES_OFFSET)
    koffi.encode(extended, 'uint8', bytes, bytes.length)
    return create(extended)
  } finally {
    if (initialized && attributes !== undefined) api.deleteAttributes(attributes)
    if (handles !== undefined) koffi.free(handles)
    if (extended !== undefined) koffi.free(extended)
    if (attributes !== undefined) koffi.free(attributes)
  }
}
