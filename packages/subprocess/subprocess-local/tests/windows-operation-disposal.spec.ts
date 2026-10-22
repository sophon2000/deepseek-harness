import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import koffi from 'koffi'
import type { SubprocessOperationOwnerKey, SubprocessOperationScope } from '@deepseek-ai/dsh-subprocess'
import {
  closeHandleChecked, loadWin32OperationBindings, type NativePtr, type Win32OperationBindings,
} from '@deepseek-ai/dsh-win32-process'
import { WindowsOperationProvider } from '../src/windows-operations.ts'
import { launchWindowsJob } from '../src/windows-job.ts'
import { targetEnvironment } from '../src/runner-launch.ts'
import { bindManagedProcess } from '../src/spawn.ts'
import { prepareManagedProcessBinding } from '../src/output.ts'

const owner = 'operation-disposal-test/receipt' as SubprocessOperationOwnerKey

function provider(stateDirectory: string, api: Win32OperationBindings): WindowsOperationProvider {
  return new WindowsOperationProvider({ stateDirectory }, (spec, operation) =>
    bindManagedProcess(spec, launchWindowsJob(spec, targetEnvironment(spec), { operation }), prepareManagedProcessBinding()), api)
}

async function scope(instance: WindowsOperationProvider): Promise<SubprocessOperationScope> {
  return (await instance.create(owner)).scope
}

function launch(scope: SubprocessOperationScope) {
  return scope.spawn({ argv: [process.execPath, '-e', 'console.log(process.pid);setInterval(()=>{},1000)'],
    cwd: process.cwd(), graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
}

describe.skipIf(process.platform !== 'win32')('Windows operation disposal admission', () => {
  it('refuses a new recovered Job while disposal waits for an already owned live Job', async () => {
    const parent = mkdtempSync(join(process.cwd(), 'operation-disposal-test-'))
    const stateDirectory = join(parent, 'store')
    const native = loadWin32OperationBindings()
    const draining = Promise.withResolvers<undefined>()
    let holdTermination = true
    let foreignLocator: string | undefined
    let foreignJobOpens = 0
    const disposing = provider(stateDirectory, { ...native,
      // Hold actual members alive until the test releases the disposal observation barrier.
      terminateJobObject: (...args) => holdTermination ? 1 : native.terminateJobObject(...args),
      queryInformationJobObject: (...args) => {
        const result = native.queryInformationJobObject(...args)
        if (result !== 0 && args[1] === 1 && args[2].readUInt32LE(40) > 0) draining.resolve(undefined)
        return result
      },
      openJob: (...args) => {
        if (foreignLocator !== undefined && args[2].endsWith(foreignLocator)) foreignJobOpens++
        return native.openJob(...args)
      },
    })
    const other = provider(stateDirectory, native)
    const openProcess = koffi.load('kernel32.dll').func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']) as
      (access: number, inherit: number, pid: number) => NativePtr | null
    const handles: ReturnType<typeof launch>[] = []
    let foreignProcess: NativePtr | null = null
    try {
      const first = await scope(disposing)
      const second = await scope(other)
      foreignLocator = second.descriptor.locator
      const firstHandle = launch(first)
      handles.push(firstHandle)
      const secondHandle = launch(second)
      handles.push(secondHandle)
      await expect.poll(() => firstHandle.collected.stdout?.readFrom(0).text.trim()).toMatch(/^\d+$/)
      await expect.poll(() => secondHandle.collected.stdout?.readFrom(0).text.trim()).toMatch(/^\d+$/)
      foreignProcess = openProcess(0x100000, 0, Number(secondHandle.collected.stdout?.readFrom(0).text.trim()))
      if (foreignProcess === null) throw new Error('Unable to observe fixture-owned process')
      const disposal = disposing.dispose()
      await draining.promise
      const result = await disposing.recover(second.descriptor, owner)
      expect(result).toMatchObject({ kind: 'unverifiable', reason: 'native-failure' })
      expect(foreignJobOpens).toBe(0)
      expect(existsSync(join(stateDirectory, `${second.descriptor.locator}.seal`))).toBe(false)
      expect(native.waitForSingleObject(foreignProcess, 0)).toBe(258)
      expect(() => launch(first)).toThrow('disposed')
      await expect(disposing.create(owner)).rejects.toThrow('disposing')
      holdTermination = false
      await disposal
      expect(await firstHandle.waitForExit()).toBe(true)
      expect((await firstHandle.done).exitCode).toBe(1)
      expect(native.waitForSingleObject(foreignProcess, 0)).toBe(258)
      await other.dispose()
      expect(await secondHandle.waitForExit()).toBe(true)
      expect((await secondHandle.done).exitCode).toBe(1)
      expect(native.waitForSingleObject(foreignProcess, 5000)).toBe(0)
    } finally {
      holdTermination = false
      try { await Promise.all([disposing.dispose(), other.dispose()]) }
      finally {
        try {
          await Promise.all(handles.map(handle => Promise.all([handle.done.catch(() => {}), handle.waitForExit()])))
        } finally {
          if (foreignProcess !== null) closeHandleChecked(native, foreignProcess, 'disposal fixture process observation')
          rmSync(parent, { recursive: true })
        }
      }
    }
  })

  it('withholds recovery after disposal even when the caller already cancelled its wait', async () => {
    const parent = mkdtempSync(join(process.cwd(), 'operation-disposal-test-'))
    const native = loadWin32OperationBindings()
    let opens = 0
    const instance = provider(join(parent, 'store'), { ...native, openJob: (...args) => {
      opens++
      return native.openJob(...args)
    } })
    try {
      const created = await scope(instance)
      const sealed = await created.seal()
      expect(sealed.kind).toBe('sealed-quiescent')
      await instance.dispose()
      const before = opens
      for (const signal of [AbortSignal.abort('already cancelled'), undefined]) {
        expect(await instance.recover(created.descriptor, owner, signal))
          .toMatchObject({ kind: 'unverifiable', reason: 'native-failure' })
      }
      expect(opens).toBe(before)
      if (sealed.kind === 'sealed-quiescent') expect(instance.verify(sealed.proof, created.descriptor, owner)).toBe(false)
      await expect(instance.create(owner)).rejects.toThrow('disposing')
    } finally {
      try { await instance.dispose() } finally { rmSync(parent, { recursive: true }) }
    }
  })
})
