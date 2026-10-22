/** Source-mode crash fixture; pauses only its own native creator or recovery checkpoint. */

import { closeSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import koffi from 'koffi'
import {
  loadWin32OperationBindings, loadWin32ProcessBindings, closeHandleChecked, isJobEmpty,
  pollProcessExit, spawnCurrentTokenJobProcess, terminateJob,
} from '@deepseek-ai/dsh-win32-process'
import type { SubprocessOperationOwnerKey } from '@deepseek-ai/dsh-subprocess'
import { WindowsOperationProvider, launchWindowsOperationTarget } from '../../src/windows-operations.ts'
import { launchWindowsJob } from '../../src/windows-job.ts'
import { targetEnvironment, resolveWindowsExecutable, consumeRunnerSelection } from '../../src/runner-launch.ts'
import { bindManagedProcess } from '../../src/spawn.ts'
import { prepareManagedProcessBinding } from '../../src/output.ts'
import { runSpawnRunner } from '../../src/spawn-runner.ts'

function pause(): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }

function pauseNativeCreator(): void {
  const kernel = koffi.load('kernel32.dll')
  const currentThread = kernel.func('__stdcall', 'GetCurrentThread', 'void *', [])
  const suspend = kernel.func('__stdcall', 'SuspendThread', 'uint32', ['void *'])
  if (suspend(currentThread()) === 0xFFFFFFFF) throw new Error('Unable to suspend the fixture creator thread')
  throw new Error('The suspended fixture creator must be terminated, never resumed')
}

const [mode, storePath, descriptorPath, checkpoint] = process.argv.slice(2)
if (mode === 'runner' || mode === 'runner-tail') {
  const currentThreadId = koffi.load('kernel32.dll').func('__stdcall', 'GetCurrentThreadId', 'uint32', [])
  const native = loadWin32OperationBindings()
  const selection = consumeRunnerSelection()
  if (selection === undefined || storePath === undefined) throw new Error('Missing runner selection or checkpoint')
  let admission: bigint | null = null
  let childPid: number | undefined
  await runSpawnRunner(selection, process.argv.slice(4), process, {
    execve: () => { throw new Error('Windows-only fixture') },
    loadWin32ProcessBindings,
    spawnCurrentTokenJobProcess,
    closeFileDescriptor: closeSync,
    resolveWindowsExecutable,
    pollProcessExit,
    isJobEmpty,
    terminateJob,
    closeHandleChecked,
    launchWindowsOperationTarget: (request, options, cancelled) => launchWindowsOperationTarget(request, options, cancelled, {
      ...native,
      createFile: (...args) => {
        const handle = native.createFile(...args)
        if (args[0].endsWith('.admission')) admission = handle
        return handle
      },
      closeHandle: handle => {
        const result = native.closeHandle(handle)
        if (mode === 'runner-tail' && childPid !== undefined && handle === admission && result !== 0) {
          admission = null
          writeFileSync(storePath, JSON.stringify({ childPid, creatorPid: process.pid, creatorThread: currentThreadId() }), { flush: true })
          pauseNativeCreator()
        }
        return result
      },
      createProcessW: (...args) => {
        const result = native.createProcessW(...args)
        if (result !== 0) {
          const info = Buffer.from(koffi.decode(args[9], 'uint8', 24) as number[])
          childPid = info.readUInt32LE(16)
          if (mode === 'runner-tail') return result
          writeFileSync(storePath, JSON.stringify({ childPid, creatorPid: process.pid, creatorThread: currentThreadId() }), { flush: true })
          try { pauseNativeCreator() } catch (error) {
            writeFileSync(storePath + '.runner-failure', String(error), { flush: true })
            throw error
          }
        }
        return result
      },
    }),
  })
} else {
  if (storePath === undefined || descriptorPath === undefined || checkpoint === undefined) throw new Error('Missing fixture paths')
  const native = loadWin32OperationBindings()
  let pauseSeal = false
  const provider = new WindowsOperationProvider({ stateDirectory: storePath }, (spec, operation) => {
    const invocation = mode === 'atomic-crash' || mode === 'tail-proof'
      ? [process.execPath, '--import', import.meta.resolve('tsx/esm'), fileURLToPath(import.meta.url), mode === 'tail-proof' ? 'runner-tail' : 'runner', checkpoint] as [string, ...string[]]
      : undefined
    return bindManagedProcess(spec, launchWindowsJob(spec, targetEnvironment(spec), {
      operation,
      ...invocation === undefined ? {} : { runnerInvocation: invocation },
      spawn: (command, args, options) => {
        // libuv's non-detached children die with the Host before this barrier can isolate runner survival.
        const runner = spawn(command, args, { ...options, ...(mode === 'atomic-crash' || mode === 'tail-proof') ? { detached: true } : {} })
        runner.once('spawn', () => { process.send?.({ type: 'runner', pid: runner.pid }) })
        return runner
      },
    }), prepareManagedProcessBinding())
  }, { ...native, flushFile: handle => {
    const result = native.flushFile(handle)
    if (pauseSeal && result !== 0) {
      writeFileSync(checkpoint, 'durable-seal-committed', { flush: true })
      pause()
    }
    return result
  } })
  const created = await provider.create('test-home-nonce/project/render/receipt' as SubprocessOperationOwnerKey)
  const scope = created.scope
  writeFileSync(descriptorPath, JSON.stringify(scope.descriptor), { flag: 'wx', flush: true })
  process.send?.({ type: 'reserved', descriptor: scope.descriptor })
  process.on('message', value => {
    if (value === 'seal') { pauseSeal = true; void scope.seal(); return }
    if (value !== 'launch') return
    const code = mode === 'atomic-crash' ? 'setTimeout(()=>{},30000)' : mode === 'tail-proof' ? 'process.exit(0)' :
      `require('node:fs').writeFileSync(${JSON.stringify(checkpoint)},String(process.pid));setTimeout(()=>{},30000)`
    const handle = scope.spawn({ argv: [process.execPath, '-e', code], cwd: process.cwd(), graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
    void handle.done.catch((error: unknown) => { process.send?.({ type: 'target-error', detail: String(error) }) })
    void handle.waitForExit().catch((_crashExpected) => {})
  })
}
