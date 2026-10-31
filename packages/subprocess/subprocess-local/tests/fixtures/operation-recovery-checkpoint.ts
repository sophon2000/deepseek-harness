/** Source-mode fixture killed by its owner at one real recovery syscall checkpoint. */

import { readFileSync, writeFileSync } from 'node:fs'
import { loadWin32OperationBindings, type NativePtr } from '@deepseek-ai/dsh-win32-process'
import type { SubprocessOperationDescriptor } from '@deepseek-ai/dsh-subprocess'
import { WindowsOperationProvider } from '../../src/windows-operations.ts'

const [stateDirectory, descriptorPath, selected, checkpointPath] = process.argv.slice(2)
if (!stateDirectory || !descriptorPath || !selected || !checkpointPath) throw new Error('Missing checkpoint fixture arguments')
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as SubprocessOperationDescriptor
const native = loadWin32OperationBindings()
let sealHandle: NativePtr | null = null

function checkpoint(name: string, phase: 'before' | 'after'): void {
  if (selected !== `${name}:${phase}`) return
  writeFileSync(checkpointPath!, JSON.stringify({ name, phase, pid: process.pid }), { flag: 'wx', flush: true })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw new Error('Checkpoint fixture must be terminated, never resumed')
}

const provider = new WindowsOperationProvider({ stateDirectory }, () => {
  throw new Error('Recovery fixture must never launch targets')
}, {
  ...native,
  createFile: (...args) => {
    const seal = args[0].endsWith('.seal')
    if (seal) checkpoint('seal-create', 'before')
    const handle = native.createFile(...args)
    if (seal && handle !== null && handle !== 0xffff_ffff_ffff_ffffn) {
      sealHandle = handle
      checkpoint('seal-create', 'after')
    }
    return handle
  },
  writeOperationFile: (...args) => {
    if (args[0] === sealHandle) checkpoint('seal-write', 'before')
    const result = native.writeOperationFile(...args)
    if (args[0] === sealHandle && result !== 0) checkpoint('seal-write', 'after')
    return result
  },
  flushFile: (handle) => {
    if (handle === sealHandle) checkpoint('seal-flush', 'before')
    const result = native.flushFile(handle)
    if (handle === sealHandle && result !== 0) checkpoint('seal-flush', 'after')
    return result
  },
  openJob: (...args) => {
    checkpoint('job-open', 'before')
    const result = native.openJob(...args)
    if (result !== null) checkpoint('job-open', 'after')
    return result
  },
  queryInformationJobObject: (...args) => {
    const name = args[1] === 9 ? 'job-limits' : 'job-accounting'
    checkpoint(name, 'before')
    const result = native.queryInformationJobObject(...args)
    if (result !== 0) checkpoint(name, 'after')
    return result
  },
  terminateJobObject: (...args) => {
    checkpoint('job-terminate', 'before')
    const result = native.terminateJobObject(...args)
    if (result !== 0) checkpoint('job-terminate', 'after')
    return result
  },
})

const result = await provider.recover(descriptor, descriptor.ownerKey)
throw new Error(`Recovery returned without reaching ${selected}: ${JSON.stringify(result)}`)
