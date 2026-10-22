import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { loadWin32OperationBindings, closeHandleChecked, isJobEmpty, terminateJob, type NativePtr } from '@deepseek-ai/dsh-win32-process'
import type { SubprocessHandle, SubprocessOperationOwnerKey, SubprocessOperationRecovery, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { WindowsOperationProvider } from '../src/windows-operations.ts'
import { WindowsOperationStore } from '../src/operation-store.ts'
import { launchWindowsJob } from '../src/windows-job.ts'
import { targetEnvironment } from '../src/runner-launch.ts'
import { bindManagedProcess } from '../src/spawn.ts'
import { prepareManagedProcessBinding } from '../src/output.ts'

const checkpoints = ['seal-create', 'seal-write', 'seal-flush', 'job-open', 'job-limits', 'job-terminate', 'job-accounting']
  .flatMap(name => ['before', 'after'].map(phase => ({ checkpoint: `${name}:${phase}`, existingSeal: false })))
checkpoints.push(...['before', 'after'].map(phase => ({ checkpoint: `seal-flush:${phase}`, existingSeal: true })))

async function killFixture(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await closed
}

describe.skipIf(process.platform !== 'win32')('Windows recovery syscall crash checkpoints', () => {
  it.each(checkpoints)('preserves recovery guarantees after $checkpoint (existing seal: $existingSeal)', async ({ checkpoint, existingSeal }) => {
    const root = mkdtempSync(join(process.cwd(), 'operation-checkpoint-'))
    const stateDirectory = join(root, 'store')
    const descriptorPath = join(root, 'reservation.json')
    const checkpointPath = join(root, 'checkpoint.json')
    const native = loadWin32OperationBindings()
    const owner = 'checkpoint-home/project/render/receipt' as SubprocessOperationOwnerKey
    const provider = new WindowsOperationProvider({ stateDirectory }, (spec, operation) =>
      bindManagedProcess(spec, launchWindowsJob(spec, targetEnvironment(spec), { operation }), prepareManagedProcessBinding()), native)
    let fixture: ChildProcess | undefined
    let fixtureClosed = Promise.resolve()
    let retained: NativePtr | null = null
    let damagedSeal = false
    let stderr = ''
    let target: SubprocessHandle | undefined
    try {
      const created = await provider.create(owner)
      const scope = created.scope
      writeFileSync(descriptorPath, JSON.stringify(scope.descriptor), { flag: 'wx', flush: true })
      const request: SubprocessSpawnSpec = { argv: [process.execPath, '-e', 'console.log("ready");setInterval(()=>{},1000)'],
        cwd: root, graceMs: 1000, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } }
      target = scope.spawn(request)
      await expect.poll(() => target!.collected.stdout?.readFrom(0).text.trim()).toBe('ready')
      const store = new WindowsOperationStore(native, stateDirectory, false)
      try {
        const lock = store.lock(scope.descriptor.locator)
        try {
          const record = store.authenticate(lock, scope.descriptor, owner)
          retained = native.openJob(0x0F, 0, record.job)
          if (existingSeal) store.seal(record)
        } finally { closeHandleChecked(native, lock, 'checkpoint fixture admission') }
      } finally { store.dispose() }
      if (retained === null) throw new Error('Unable to retain authenticated operation Job')
      expect(isJobEmpty(native, retained)).toBe(false)
      fixture = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
        fileURLToPath(new URL('./fixtures/operation-recovery-checkpoint.ts', import.meta.url)),
        stateDirectory, descriptorPath, checkpoint, checkpointPath], {
        cwd: process.cwd(), windowsHide: true, env: targetEnvironment(request), stdio: ['ignore', 'ignore', 'pipe'],
      })
      fixtureClosed = new Promise((resolve) => { fixture!.once('close', () => { resolve() }) })
      fixture.stderr?.on('data', (bytes: Buffer) => { stderr += bytes.toString() })
      let launchError: Error | undefined
      fixture.once('error', (error) => { launchError = error })
      await expect.poll(() => {
        if (launchError) throw launchError
        if (fixture!.exitCode !== null || fixture!.signalCode !== null) throw new Error(`Checkpoint fixture exited early: ${stderr}`)
        try { return JSON.parse(readFileSync(checkpointPath, 'utf8')) as { name: string; phase: string; pid: number } }
        catch { return undefined }
      }).toEqual({ name: checkpoint.split(':')[0], phase: checkpoint.split(':')[1], pid: fixture.pid })
      expect(await provider.recover(scope.descriptor, owner)).toEqual({ kind: 'active', sealed: false, reason: 'busy' })
      if (!checkpoint.startsWith('job-accounting') && checkpoint !== 'job-terminate:after') expect(isJobEmpty(native, retained)).toBe(false)
      await killFixture(fixture, fixtureClosed)
      damagedSeal = !existingSeal && (checkpoint === 'seal-create:after' || checkpoint === 'seal-write:before')
      if (damagedSeal) {
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(await provider.recover(scope.descriptor, owner)).toMatchObject({ kind: 'unverifiable', reason: 'store-failure' })
        }
        expect(isJobEmpty(native, retained)).toBe(false)
        const late = scope.spawn({ ...request, argv: [process.execPath, '-e', 'throw Error("MUST NOT RUN")'] })
        await expect(late.done).rejects.toThrow('permanently sealed')
        await expect(late.waitForExit()).rejects.toThrow()
      } else {
        let recovered: SubprocessOperationRecovery | undefined
        await expect.poll(async () => {
          recovered = await provider.recover(scope.descriptor, owner)
          return recovered.kind
        }).toBe('sealed-quiescent')
        if (recovered?.kind !== 'sealed-quiescent') throw new Error('Expected fresh native proof')
        expect(provider.verify(recovered.proof, scope.descriptor, owner)).toBe(true)
        expect(isJobEmpty(native, retained)).toBe(true)
        expect(() => scope.spawn(request)).toThrow('sealed')
        expect((await target.done).exitCode).toBe(1)
        expect(await target.waitForExit()).toBe(true)
      }
    } finally {
      try {
        if (fixture) await killFixture(fixture, fixtureClosed)
      } finally {
        try {
          if (retained !== null) {
            terminateJob(native, retained, 1)
            await expect.poll(() => isJobEmpty(native, retained!)).toBe(true)
          }
        } finally {
          try {
            try {
              if (damagedSeal) await expect(provider.dispose()).rejects.toThrow('could not prove quiescence')
              else await provider.dispose()
            } finally {
              if (target) {
                try { await target.done } finally { await target.waitForExit() }
              }
            }
          } finally {
            try {
              if (retained !== null) closeHandleChecked(native, retained, 'checkpoint fixture retained Job')
            } finally { rmSync(root, { recursive: true }) }
          }
        }
      }
    }
  })
})
