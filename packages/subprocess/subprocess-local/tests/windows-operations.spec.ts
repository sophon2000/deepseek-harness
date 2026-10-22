import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import koffi from 'koffi'
import { loadWin32OperationBindings as loadOperationBindings, closeHandleChecked, type NativePtr, type Win32OperationBindings } from '@deepseek-ai/dsh-win32-process'
import { UnsupportedSubprocessOperations } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessOperationDescriptor, SubprocessOperationOwnerKey, SubprocessOperationProvider, SubprocessOperationRecovery, SubprocessOperationScope, SubprocessQuiescenceProof } from '@deepseek-ai/dsh-subprocess'
import { WindowsOperationProvider, launchWindowsOperationTarget } from '../src/windows-operations.ts'
import { WindowsOperationStore } from '../src/operation-store.ts'
import { launchWindowsJob } from '../src/windows-job.ts'
import { targetEnvironment } from '../src/runner-launch.ts'
import { bindManagedProcess } from '../src/spawn.ts'
import { prepareManagedProcessBinding } from '../src/output.ts'

const owner = 'test-home-nonce/project/render/receipt' as SubprocessOperationOwnerKey
const foreignOwner = 'test-home-nonce/project/render/other-receipt' as SubprocessOperationOwnerKey
const providers: SubprocessOperationProvider[] = []
const directories: string[] = []
const expectedDisposalFailures = new Set<SubprocessOperationProvider>()

interface TestOperationBindings extends Win32OperationBindings {
  openProcess(access: number, inherit: number, pid: number): NativePtr | null
}

function loadWin32OperationBindings(): TestOperationBindings {
  const openProcess = koffi.load('kernel32.dll').func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32'])
  return { ...loadOperationBindings(), openProcess: openProcess as TestOperationBindings['openProcess'] }
}

function provider(api = loadWin32OperationBindings(), root?: string): WindowsOperationProvider {
  const parent = root ?? mkdtempSync(join(process.cwd(), 'operation-native-test-'))
  if (root === undefined) directories.push(parent)
  const instance = new WindowsOperationProvider({ stateDirectory: join(parent, 'store') }, (spec, operation) =>
    bindManagedProcess(spec, launchWindowsJob(spec, targetEnvironment(spec), { operation }), prepareManagedProcessBinding()), api)
  providers.push(instance)
  return instance
}

async function scope(p: SubprocessOperationProvider, key = owner): Promise<SubprocessOperationScope> {
  const result = await p.create(key)
  if (result.kind !== 'created') throw new Error('Expected native operation support')
  return result.scope
}

function spec(code = 'console.log("managed")') {
  return { argv: [process.execPath, '-e', code], cwd: process.cwd(), graceMs: 1000,
    stdio: { stdin: 'ignore' as const, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } }
}

async function quiescent(p: SubprocessOperationProvider, s: Pick<SubprocessOperationScope, 'descriptor'>): Promise<Extract<SubprocessOperationRecovery, { kind: 'sealed-quiescent' }>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await p.recover(s.descriptor, owner)
    if (result.kind === 'sealed-quiescent') return result
    if (result.kind !== 'active') throw new Error(JSON.stringify(result))
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Operation did not drain')
}

function crashHost(mode: string) {
  const parent = mkdtempSync(join(process.cwd(), 'operation-native-test-'))
  directories.push(parent)
  const checkpoint = join(parent, 'checkpoint')
  const descriptorPath = join(parent, 'reservation.json')
  const host = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
    fileURLToPath(new URL('./fixtures/operation-crash-host.ts', import.meta.url)), mode,
    join(parent, 'store'), descriptorPath, checkpoint], { cwd: process.cwd(), windowsHide: true,
    env: targetEnvironment(spec()), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const messages: Array<Record<string, unknown>> = []
  const api = loadWin32OperationBindings()
  const runners = new Set<NativePtr>()
  let errors = ''
  host.stderr?.on('data', (bytes: Buffer) => { errors += bytes.toString() })
  host.on('message', (value: unknown) => {
    if (value === null || typeof value !== 'object') return
    const message = value as Record<string, unknown>
    messages.push(message)
    if (message.type === 'runner' && typeof message.pid === 'number') {
      const handle = api.openProcess(0x101001, 0, message.pid)
      if (handle !== null) runners.add(handle)
    }
  })
  const killHost = async (): Promise<void> => {
    if (host.exitCode !== null || host.signalCode !== null) return
    const exited = new Promise<void>((resolve) => { host.once('exit', () => { resolve() }) })
    host.kill('SIGKILL')
    await exited
  }
  return { parent, checkpoint, descriptorPath, host, errors: () => errors,
    message: async (type: string) => {
      await expect.poll(() => messages.find(message => message.type === type), { timeout: 5000,
        message: `Fixture ${type} checkpoint; stderr: ${errors}` }).toBeDefined()
      return messages.find(message => message.type === type)!
    },
    kill: killHost,
    cleanup: async () => {
      await killHost()
      for (const handle of runners) {
        try {
          api.terminateProcess(handle, 1)
          expect(api.waitForSingleObject(handle, 5000)).toBe(0)
        } finally { closeHandleChecked(api, handle, 'fixture-owned runner cleanup') }
      }
      runners.clear()
    },
  }
}

afterEach(async () => {
  for (const p of providers.splice(0)) {
    if (expectedDisposalFailures.delete(p)) await expect(p.dispose()).rejects.toThrow('could not prove quiescence')
    else await p.dispose()
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true })
})

describe.skipIf(process.platform !== 'win32')('native Windows operation recovery', () => {
  it('loads the actual service from cordis.yml and verifies a real operation through its public factory', async () => {
    const parent = mkdtempSync(join(process.cwd(), 'operation-native-test-'))
    directories.push(parent)
    const config = join(parent, 'cordis.yml')
    const result = join(parent, 'result.json')
    writeFileSync(config, `- id: operations\n  name: ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../src/index.ts', import.meta.url))).href)}\n`)
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
      fileURLToPath(new URL('./fixtures/operation-loader-host.ts', import.meta.url)), config, join(parent, 'store'), result], {
      cwd: process.cwd(), windowsHide: true, env: targetEnvironment(spec()), stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString() })
    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => { resolve({ code, signal }) })
      })
      expect(exit, stderr).toEqual({ code: 0, signal: null })
      expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({ exitCode: 0, output: 'loader-operation', verified: true })
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
        child.kill('SIGKILL')
        await exited
      }
    }
  })
  it('creates without launching, persists identity, and issues only instance-bound proof', async () => {
    const p = provider()
    const s = await scope(p)
    const root = directories[0]!
    expect(existsSync(join(root, 'store', `${s.descriptor.locator}.admission`))).toBe(true)
    const result = await quiescent(p, s)
    expect(p.verify(result.proof, s.descriptor, owner)).toBe(true)
    expect(p.verify(JSON.parse(JSON.stringify(result.proof)) as SubprocessQuiescenceProof, s.descriptor, owner)).toBe(false)
    expect(p.verify(result.proof, s.descriptor, foreignOwner)).toBe(false)
    const other = provider(loadWin32OperationBindings(), root)
    expect(other.verify(result.proof, s.descriptor, owner)).toBe(false)
    const fresh = await other.recover(s.descriptor, owner)
    expect(fresh.kind).toBe('sealed-quiescent')
    expect((await quiescent(p, s)).proof).not.toBe(result.proof)
  })

  it('never adopts a prior scope when the owner key is repeated', async () => {
    const p = provider()
    const first = await scope(p)
    const second = await scope(p)
    expect(first.descriptor.locator).not.toBe(second.descriptor.locator)
    await quiescent(p, first)
    const h = second.spawn(spec())
    expect((await h.done).exitCode).toBe(0)
    expect(h.collected.stdout?.readFrom(0).text).toContain('managed')
    expect(await h.waitForExit()).toBe(true)
    await quiescent(p, second)
  })

  it('keeps one operation open across sequential commands and rejects a late real runner after seal', async () => {
    const p = provider()
    const s = await scope(p)
    for (const word of ['probe', 'encoder']) {
      const h = s.spawn(spec(`console.log(${JSON.stringify(word)})`))
      expect((await h.done).exitCode).toBe(0)
      expect(await h.waitForExit()).toBe(true)
      expect(h.collected.stdout?.readFrom(0).text.trim()).toBe(word)
    }
    await quiescent(p, s)
    expect(() => s.spawn(spec())).toThrow('sealed')
    const request = spec('throw Error("MUST NOT RUN")')
    const late = bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request), {
      operation: { stateDirectory: join(directories[0]!, 'store'), descriptor: s.descriptor, expectedOwnerKey: owner },
    }), prepareManagedProcessBinding())
    await expect(late.done).rejects.toThrow('permanently sealed')
    await expect(late.waitForExit()).rejects.toThrow()
  })

  it('observes detached descendants after the direct child exits and terminates the entire operation', async () => {
    const p = provider()
    const s = await scope(p)
    const code = 'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{detached:true,stdio:"ignore"}); c.unref(); console.log(c.pid)'
    const h = s.spawn(spec(code))
    expect((await h.done).exitCode).toBe(0)
    expect(Number(h.collected.stdout?.readFrom(0).text.trim())).toBeGreaterThan(0)
    expect(await h.waitForExit(AbortSignal.timeout(30))).toBe(false)
    await quiescent(p, s)
    expect(await h.waitForExit()).toBe(true)
  })

  it('excludes a late creator waiting on the same OS admission lock', async () => {
    const p = provider()
    const s = await scope(p)
    const api = loadWin32OperationBindings()
    const store = new WindowsOperationStore(api, join(directories[0]!, 'store'), false)
    const lock = store.lock(s.descriptor.locator)
    try {
      const late = launchWindowsOperationTarget({ stateDirectory: store.root, descriptor: s.descriptor, expectedOwnerKey: owner }, {
        command: process.execPath, applicationName: process.execPath, args: ['-e', 'throw Error("MUST NOT RUN")'],
        cwd: process.cwd(), env: {}, stdio: { stdin: 4, stdout: 5, stderr: 6 },
      }, () => false)
      expect(await p.recover(s.descriptor, owner)).toMatchObject({ kind: 'active', sealed: false, reason: 'busy' })
      const record = store.authenticate(lock, s.descriptor, owner)
      store.seal(record)
      closeHandleChecked(api, lock, 'test admission barrier')
      await expect(late).rejects.toThrow('permanently sealed')
    } finally { store.dispose() }
    await quiescent(p, s)
  })

  it('rejects a valid locator exchanged between receipts before native Job access', async () => {
    let opens = 0
    const native = loadWin32OperationBindings()
    const api = { ...native, openJob: (...args: Parameters<Win32OperationBindings['openJob']>) => {
      opens++
      return native.openJob(...args)
    } }
    const p = provider(api)
    const s = await scope(p)
    expect(await p.recover({ ...s.descriptor, ownerKey: foreignOwner }, foreignOwner)).toMatchObject({ kind: 'unverifiable', reason: 'identity-mismatch' })
    expect(opens).toBe(0)
    await quiescent(p, s)
  })

  it('withholds proof on a failed native query', async () => {
    const native = loadWin32OperationBindings()
    const p = provider({ ...native, queryInformationJobObject: () => 0, getLastError: () => 5 })
    expectedDisposalFailures.add(p)
    const s = await scope(p)
    const envelope = JSON.parse(readFileSync(join(directories[0]!, 'store', `${s.descriptor.locator}.admission`), 'utf8')) as { payload: string }
    const record = JSON.parse(envelope.payload) as { job: string }
    const retained = native.openJob(0x0F, 0, record.job)!
    try { expect(await p.recover(s.descriptor, owner)).toMatchObject({ kind: 'unverifiable', reason: 'native-failure' }) }
    finally { closeHandleChecked(native, retained, 'test retained query owner') }
  })

  it('rejects a simulated boot change without attempting Job lookup', async () => {
    const native = loadWin32OperationBindings()
    let changed = false
    let opens = 0
    const p = provider({ ...native, systemInformation: (cls, information, length, returned) => {
      const status = native.systemInformation(cls, information, length, returned)
      if (changed) information[0] = information[0]! ^ 1
      return status
    }, openJob: (...args) => { opens++; return native.openJob(...args) } })
    const s = await scope(p)
    changed = true
    expect(await p.recover(s.descriptor, owner)).toMatchObject({ kind: 'unverifiable', reason: 'boot-mismatch' })
    expect(opens).toBe(0)
    changed = false
    await quiescent(p, s)
  })

  it('permanently denies launches after a seal write failure and retains unverifiable state', async () => {
    const native = loadWin32OperationBindings()
    let fail = false
    const p = provider({ ...native, writeOperationFile: (...args) => fail ? 0 : native.writeOperationFile(...args) })
    expectedDisposalFailures.add(p)
    const s = await scope(p)
    fail = true
    expect(await p.recover(s.descriptor, owner)).toMatchObject({ kind: 'unverifiable', reason: 'store-failure' })
    fail = false
    expect(await p.recover(s.descriptor, owner)).toMatchObject({ kind: 'unverifiable', reason: 'store-failure' })
    const late = s.spawn(spec('throw Error("MUST NOT RUN")'))
    await expect(late.done).rejects.toThrow('permanently sealed')
    await expect(late.waitForExit()).rejects.toThrow()
  })

  it('safely retries a complete seal after flush failure', async () => {
    const native = loadWin32OperationBindings()
    let fail = false
    const p = provider({ ...native, flushFile: handle => fail ? 0 : native.flushFile(handle) })
    const s = await scope(p)
    fail = true
    expect(await p.recover(s.descriptor, owner)).toMatchObject({ kind: 'unverifiable', reason: 'store-failure' })
    fail = false
    await quiescent(p, s)
  })

  it('never manufactures evidence for legacy or unsupported providers', async () => {
    const p = new UnsupportedSubprocessOperations()
    expect(await p.recover(undefined)).toMatchObject({ kind: 'unverifiable', reason: 'legacy-no-scope' })
    const native = provider()
    const s = await scope(native)
    expect(await native.recover({ ...s.descriptor, providerVersion: 2 }, owner)).toMatchObject({ kind: 'unsupported' })
    expect(await native.recover(undefined, owner)).toMatchObject({ kind: 'unverifiable', reason: 'legacy-no-scope' })
    await quiescent(native, s)
  })

  it('retains integrity failure without opening any Job when authenticated identity bytes are changed', async () => {
    const native = loadWin32OperationBindings()
    let opens = 0
    const p = provider({ ...native, openJob: (...args) => { opens++; return native.openJob(...args) } })
    expectedDisposalFailures.add(p)
    const s = await scope(p)
    const path = join(directories[0]!, 'store', `${s.descriptor.locator}.admission`)
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { payload: string; mac: string }
    const data = JSON.parse(envelope.payload) as Record<string, unknown>
    data.ownerKey = foreignOwner
    envelope.payload = JSON.stringify(data)
    writeFileSync(path, JSON.stringify(envelope))
    expect(await p.recover(s.descriptor, owner)).toMatchObject({ kind: 'unverifiable', reason: 'identity-mismatch' })
    expect(opens).toBe(0)
  })

  it('rejects an existing broad directory without changing its ACL or launching anything', async () => {
    const parent = mkdtempSync(join(process.cwd(), 'operation-native-test-'))
    directories.push(parent)
    mkdirSync(join(parent, 'store'))
    const p = provider(loadWin32OperationBindings(), parent)
    await expect(p.create(owner)).rejects.toThrow('DACL is not private')
    expect(existsSync(join(parent, 'store', 'machine-key'))).toBe(false)
  })

  it('aborts observation without reopening a later committed seal', async () => {
    const p = provider()
    const s = await scope(p)
    const aborted = AbortSignal.abort('test wait cancellation')
    expect(await s.seal(aborted)).toMatchObject({ kind: 'active', sealed: false, reason: 'aborted' })
    const first = s.spawn(spec())
    expect((await first.done).exitCode).toBe(0)
    expect(await first.waitForExit()).toBe(true)
    await quiescent(p, s)
    expect(await s.seal(aborted)).toMatchObject({ kind: 'active', reason: 'aborted' })
    expect(() => s.spawn(spec())).toThrow('sealed')
    await quiescent(p, s)
  })

  it('terminates two concurrent launches under the same permanent operation seal', async () => {
    const p = provider()
    const s = await scope(p)
    const handles = [s.spawn(spec('console.log("ready");setInterval(()=>{},1000)')),
      s.spawn(spec('console.log("ready");setInterval(()=>{},1000)'))]
    for (const handle of handles) {
      await expect.poll(() => handle.collected.stdout?.readFrom(0).text.includes('ready'), { timeout: 5000 }).toBe(true)
    }
    await quiescent(p, s)
    for (const handle of handles) {
      expect((await handle.done).exitCode).toBe(1)
      expect(await handle.waitForExit()).toBe(true)
    }
  })

  it('never consults a reused or unrelated PID to recover a legacy or unsupported locator', async () => {
    const native = loadWin32OperationBindings()
    const p = provider({ ...native, openProcess: () => { throw new Error('PID lookup is forbidden in recovery') } })
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore', env: targetEnvironment(spec()) })
    try {
      await new Promise<void>((resolve, reject) => { unrelated.once('spawn', resolve); unrelated.once('error', reject) })
      expect(await p.recover(undefined, owner)).toMatchObject({ kind: 'unverifiable', reason: 'legacy-no-scope' })
      expect(await p.recover({ providerKind: 'legacy-pid', providerVersion: 0,
        locator: String(unrelated.pid) as SubprocessOperationScope['descriptor']['locator'], ownerKey: owner }, owner)).toMatchObject({ kind: 'unsupported' })
      expect(unrelated.exitCode).toBeNull()
      expect(unrelated.killed).toBe(false)
    } finally {
      const exited = new Promise<void>((resolve) => { unrelated.once('exit', () => { resolve() }) })
      unrelated.kill('SIGKILL')
      await exited
    }
  })

  it('cold-recovers a durable reservation after the Host dies before launching any runner', async () => {
    const fixture = crashHost('reservation-only')
    try {
      await fixture.message('reserved')
      const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, 'utf8')) as SubprocessOperationDescriptor
      await fixture.kill()
      const cold = provider(loadWin32OperationBindings(), fixture.parent)
      const result = await cold.recover(descriptor, owner)
      expect(result.kind).toBe('sealed-quiescent')
      if (result.kind === 'sealed-quiescent') expect(cold.verify(result.proof, descriptor, owner)).toBe(true)
    } finally { await fixture.cleanup() }
  })

  it('cold-recovers the default runner and target when Host death closes their parent-owned Jobs', async () => {
    const fixture = crashHost('live-default')
    const api = loadWin32OperationBindings()
    let child: NativePtr | null = null
    let runner: NativePtr | null = null
    try {
      await fixture.message('reserved')
      const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, 'utf8')) as SubprocessOperationDescriptor
      fixture.host.send('launch')
      const message = await fixture.message('runner')
      await expect.poll(() => existsSync(fixture.checkpoint), { timeout: 5000 }).toBe(true)
      child = api.openProcess(0x101001, 0, Number(readFileSync(fixture.checkpoint, 'utf8')))
      runner = api.openProcess(0x101001, 0, message.pid as number)
      expect(child).toBeTruthy()
      expect(runner).toBeTruthy()
      expect(api.waitForSingleObject(child!, 0)).toBe(258)
      await fixture.kill()
      expect(api.waitForSingleObject(runner!, 5000)).toBe(0)
      expect(api.waitForSingleObject(child!, 5000)).toBe(0)
      const cold = provider(api, fixture.parent)
      const result = await quiescent(cold, { descriptor })
      expect(cold.verify(result.proof, descriptor, owner)).toBe(true)
    } finally {
      await fixture.cleanup()
      if (runner) closeHandleChecked(api, runner, 'default runner observation')
      if (child) closeHandleChecked(api, child, 'default target observation')
    }
  })

  it('withholds proof when the native boot layout is unsupported', async () => {
    const native = loadWin32OperationBindings()
    const p = provider(native)
    const s = await scope(p)
    let opens = 0
    const unknown = provider({ ...native,
      systemInformation: (_cls, _information, _length, returned) => { returned.writeUInt32LE(16); return 0 },
      openJob: (...args) => { opens++; return native.openJob(...args) },
    }, directories[0])
    expect(await unknown.recover(s.descriptor, owner)).toMatchObject({ kind: 'unverifiable', reason: 'native-failure' })
    expect(opens).toBe(0)
    await quiescent(p, s)
  })

  it('releases admission and withholds proof if closing the native observation handle fails', async () => {
    const native = loadWin32OperationBindings()
    let observation: NativePtr | null = null
    let failed = false
    const p = provider({ ...native,
      openJob: (...args) => { observation = native.openJob(...args); return observation },
      closeHandle: (handle) => {
        if (handle === observation && !failed) { failed = true; return 0 }
        return native.closeHandle(handle)
      },
    })
    const s = await scope(p)
    try {
      expect(await p.recover(s.descriptor, owner)).toMatchObject({ kind: 'unverifiable', reason: 'native-failure' })
      const store = new WindowsOperationStore(native, join(directories[0]!, 'store'), false)
      try {
        const lock = store.lock(s.descriptor.locator)
        closeHandleChecked(native, lock, 'admission after observation close failure')
      } finally { store.dispose() }
    } finally { if (observation) closeHandleChecked(native, observation, 'injected unclosed observation handle') }
    await quiescent(p, s)
  })

  it('recovers when Host and runner die after atomic creation but before initial resume', async () => {
    const fixture = crashHost('atomic-crash')
    const api = loadWin32OperationBindings()
    let child: ReturnType<TestOperationBindings['openProcess']> = null
    let runner: ReturnType<TestOperationBindings['openProcess']> = null
    try {
      await fixture.message('reserved')
      const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, 'utf8')) as SubprocessOperationDescriptor
      fixture.host.send('launch')
      const runnerMessage = await fixture.message('runner')
      await expect.poll(() => existsSync(fixture.checkpoint), { timeout: 5000 }).toBe(true)
      const creation = JSON.parse(readFileSync(fixture.checkpoint, 'utf8')) as { childPid: number; creatorPid: number; creatorThread: number }
      const childPid = creation.childPid
      expect(creation.creatorPid).toBe(runnerMessage.pid)
      child = api.openProcess(0x101001, 0, childPid)
      runner = api.openProcess(0x101001, 0, runnerMessage.pid as number)
      expect(child).toBeTruthy()
      expect(runner).toBeTruthy()
      expect(api.waitForSingleObject(child!, 0)).toBe(258)
      expect(api.waitForSingleObject(runner!, 0)).toBe(258)
      const kernel = koffi.load('kernel32.dll')
      const openThread = kernel.func('__stdcall', 'OpenThread', 'void *', ['uint32', 'int', 'uint32']) as
        (access: number, inherit: number, id: number) => NativePtr | null
      const suspendThread = kernel.func('__stdcall', 'SuspendThread', 'uint32', ['void *']) as (handle: NativePtr) => number
      const thread = openThread(0x42, 0, creation.creatorThread)
      expect(thread).toBeTruthy()
      if (thread === null) throw new Error('Unable to retain fixture creator thread')
      try { expect(suspendThread(thread)).not.toBe(0xFFFFFFFF) }
      finally { api.closeHandle(thread) }
      const before = provider(api, fixture.parent)
      expect(await before.recover(descriptor, owner)).toMatchObject({ kind: 'active', sealed: false, reason: 'busy' })
      await fixture.kill()
      const cold = provider(api, fixture.parent)
      expect(api.waitForSingleObject(runner!, 0)).toBe(258)
      expect(api.waitForSingleObject(child!, 0)).toBe(258)
      expect(existsSync(fixture.checkpoint + '.runner-failure')).toBe(false)
      expect(await cold.recover(descriptor, owner)).toMatchObject({ kind: 'active', sealed: false, reason: 'busy' })
      expect(api.terminateProcess(runner!, 1)).not.toBe(0)
      expect(api.waitForSingleObject(runner!, 5000)).toBe(0)
      expect(api.waitForSingleObject(child!, 5000)).toBe(0)
      expect((await cold.recover(descriptor, owner)).kind).toBe('sealed-quiescent')
    } finally {
      await fixture.cleanup()
      if (runner) { api.terminateProcess(runner, 1); closeHandleChecked(api, runner, 'test crash runner') }
      if (child) closeHandleChecked(api, child, 'test atomic child')
    }
  })

  it('retries recovery after the recovering Host dies with a durably committed seal', async () => {
    const fixture = crashHost('seal-crash')
    try {
      await fixture.message('reserved')
      const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, 'utf8')) as SubprocessOperationDescriptor
      fixture.host.send('seal')
      await expect.poll(() => existsSync(fixture.checkpoint), { timeout: 5000 }).toBe(true)
      expect(readFileSync(fixture.checkpoint, 'utf8')).toBe('durable-seal-committed')
      await fixture.kill()
      const cold = provider(loadWin32OperationBindings(), fixture.parent)
      const result = await cold.recover(descriptor, owner)
      expect(result.kind).toBe('sealed-quiescent')
      expect((await cold.recover(descriptor, owner)).kind).toBe('sealed-quiescent')
    } finally { await fixture.cleanup() }
  })

  it('proves a permanently sealed empty Job while a runner is paused after releasing launch admission', async () => {
    const fixture = crashHost('tail-proof')
    const api = loadWin32OperationBindings()
    let runner: ReturnType<TestOperationBindings['openProcess']> = null
    try {
      await fixture.message('reserved')
      const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, 'utf8')) as SubprocessOperationDescriptor
      fixture.host.send('launch')
      const runnerMessage = await fixture.message('runner')
      await expect.poll(() => existsSync(fixture.checkpoint), { timeout: 5000 }).toBe(true)
      runner = api.openProcess(0x101001, 0, runnerMessage.pid as number)
      expect(runner).toBeTruthy()
      expect(api.waitForSingleObject(runner!, 0)).toBe(258)
      const cold = provider(api, fixture.parent)
      const result = await quiescent(cold, { descriptor })
      expect(cold.verify(result.proof, descriptor, owner)).toBe(true)
      expect(readFileSync(join(fixture.parent, 'store', `${descriptor.locator}.seal`), 'utf8')).toMatch(/^[a-f0-9]{64}$/)
      expect(api.waitForSingleObject(runner!, 0)).toBe(258)
      fixture.host.send('launch')
      const denied = await fixture.message('target-error')
      expect(denied.detail).toContain('permanently sealed')
      expect(api.waitForSingleObject(runner!, 0)).toBe(258)
    } finally {
      await fixture.cleanup()
      if (runner) {
        api.terminateProcess(runner, 1)
        expect(api.waitForSingleObject(runner, 5000)).toBe(0)
        closeHandleChecked(api, runner, 'test tail-only runner')
      }
    }
  })
})
