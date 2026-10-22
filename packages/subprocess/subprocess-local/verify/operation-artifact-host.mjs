/** Test-only plain-Node Loader fixture copied beside the packages under verification. */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { closeHandleChecked, loadWin32OperationBindings } from '@deepseek-ai/dsh-win32-process'
import koffi from 'koffi'

const [mode, consumerRoot] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.deepEqual(process.execArgv, [], 'Artifact fixture must run under plain Node')
assert.equal(process.env.NODE_OPTIONS, undefined)
assert.equal(process.env.NODE_PATH, undefined)
const resolved = Object.fromEntries([
  '@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-subprocess-local/runner', '@deepseek-ai/dsh-win32-process',
].map(name => {
  const path = realpathSync(fileURLToPath(import.meta.resolve(name)))
  assert.ok(path.endsWith('.js') && path.includes(`${sep}lib${sep}`), `Expected built export: ${path}`)
  if (mode === 'packed') {
    const installedPath = relative(join(consumerRoot, 'node_modules'), path)
    assert.ok(installedPath !== '..' && !installedPath.startsWith(`..${sep}`) && !isAbsolute(installedPath),
      `Packed export escaped installed consumer: ${path}`)
  }
  return [name, path]
}))

const api = loadWin32OperationBindings()
const openProcess = koffi.load('kernel32.dll').func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32'])
const context = new Context()
context.logger.exporter({ colors: false, export: message => {
  if (message.type === 'error' || message.type === 'warn') console.error(...message.args)
} })
const providers = []
const handles = []
let descendant
let nativeCleanupComplete = false

function request(code) {
  return { argv: [process.execPath, '-e', code], cwd: process.cwd(), graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } }
}

function descendantExited() {
  const result = api.waitForSingleObject(descendant, 0)
  assert.ok(result === 0 || result === 258, `Descendant observation failed: ${result}`)
  return result === 0
}

async function waitUntil(condition, label) {
  const deadline = performance.now() + 15_000
  while (!condition()) {
    assert.ok(performance.now() < deadline, `${label} deadline expired`)
    await delay(10)
  }
}

async function obtainProof(provider, descriptor, owner) {
  const deadline = performance.now() + 15_000
  for (;;) {
    const result = await provider.recover(descriptor, owner)
    if (result.kind === 'sealed-quiescent') return result.proof
    assert.equal(result.kind, 'active', JSON.stringify(result))
    assert.ok(performance.now() < deadline, 'Native operation did not drain')
    await delay(10)
  }
}

function notify(message) {
  assert.ok(process.send, 'Driver IPC is required')
  return new Promise((accept, reject) => process.send(message, error => error ? reject(error) : accept()))
}

function barrier(kind) {
  return new Promise((accept, reject) => {
    const disconnected = () => { process.off('message', message); reject(new Error(`Driver disconnected before ${kind}`)) }
    const message = value => {
      process.off('disconnect', disconnected)
      if (value?.kind === kind) accept()
      else reject(new Error(`Expected ${kind} barrier`))
    }
    process.once('message', message)
    process.once('disconnect', disconnected)
  })
}

try {
  const config = join(process.cwd(), 'cordis.yml')
  writeFileSync(config, '- id: operations\n  name: "@deepseek-ai/dsh-subprocess-local"\n', { flag: 'wx' })
  await context.plugin(Loader, { baseUrl: import.meta.url })
  await context.plugin(Include, { path: pathToFileURL(config).href })
  await context.loader.await()
  const service = context.get('subprocess')
  assert.ok(service, 'Loader must publish the actual subprocess service')
  const stateDirectory = join(process.cwd(), 'store')
  const provider = service.operationProvider({ stateDirectory })
  providers.push(provider)
  const owner = 'artifact-home/project/render/receipt'
  const created = await provider.create(owner)
  assert.equal(created.kind, 'created')
  const scope = created.scope
  writeFileSync(join(process.cwd(), 'reservation.json'), JSON.stringify(scope.descriptor), { flag: 'wx', flush: true })
  const start = barrier('go')
  await notify({ kind: 'ready', locator: scope.descriptor.locator })
  await start

  for (const word of ['probe', 'encoder']) {
    const handle = scope.spawn(request(`console.log(${JSON.stringify(word)})`))
    handles.push(handle)
    const outcome = await handle.done
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.signal, null)
    assert.equal(await handle.waitForExit(), true)
    assert.equal(handle.collected.stdout?.readFrom(0).text.trim(), word)
  }

  const checkpoint = join(process.cwd(), 'descendant-ready.json')
  const descendantCode = `const fs=require('node:fs');const path=${JSON.stringify(checkpoint)};fs.writeFileSync(path+'.tmp',JSON.stringify({pid:process.pid}));fs.renameSync(path+'.tmp',path);setInterval(()=>{},1000)`
  const parentCode = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{detached:true,stdio:'ignore',windowsHide:true});child.unref();console.log(child.pid)`
  const handle = scope.spawn(request(parentCode))
  handles.push(handle)
  assert.equal((await handle.done).exitCode, 0)
  await waitUntil(() => existsSync(checkpoint), 'Detached descendant readiness')
  const { pid } = JSON.parse(readFileSync(checkpoint, 'utf8'))
  assert.equal(pid, Number(handle.collected.stdout?.readFrom(0).text.trim()))
  descendant = openProcess(0x101001, 0, pid)
  assert.ok(descendant, 'Retain the fixture-owned descendant process before observation')
  assert.equal(api.waitForSingleObject(descendant, 0), 258, 'Descendant must survive direct child exit')
  assert.equal(await handle.waitForExit(AbortSignal.abort()), false)
  const seal = barrier('seal')
  await notify({ kind: 'descendant-ready', pid })
  await seal
  assert.equal(descendantExited(), false, 'Descendant must remain alive through the concurrent barrier')

  const sealed = await scope.seal()
  assert.ok(sealed.kind === 'active' || sealed.kind === 'sealed-quiescent', JSON.stringify(sealed))
  const proof = sealed.kind === 'sealed-quiescent' ? sealed.proof : await obtainProof(provider, scope.descriptor, owner)
  assert.equal(provider.verify(proof, scope.descriptor, owner), true)
  assert.equal(provider.verify(JSON.parse(JSON.stringify(proof)), scope.descriptor, owner), false)
  assert.equal(provider.verify(proof, scope.descriptor, `${owner}/other`), false)
  await waitUntil(descendantExited, 'Descendant termination')
  assert.equal(await handle.waitForExit(), true)
  const lateFile = join(process.cwd(), 'late-launch-ran')
  assert.throws(() => scope.spawn(request(`require('node:fs').writeFileSync(${JSON.stringify(lateFile)},'unexpected')`)), /sealed/)
  assert.equal(existsSync(lateFile), false)

  const reopened = service.operationProvider({ stateDirectory })
  providers.push(reopened)
  assert.equal(reopened.verify(proof, scope.descriptor, owner), false)
  const fresh = await obtainProof(reopened, scope.descriptor, owner)
  assert.equal(reopened.verify(fresh, scope.descriptor, owner), true)
  assert.equal(provider.verify(fresh, scope.descriptor, owner), false)

  // The original provider has not observed this second scope's seal: rejection must come from the real runner.
  const delayed = await provider.create(`${owner}/late`)
  assert.equal(delayed.kind, 'created')
  writeFileSync(join(process.cwd(), 'late-reservation.json'), JSON.stringify(delayed.scope.descriptor), { flag: 'wx', flush: true })
  const lateProof = await obtainProof(reopened, delayed.scope.descriptor, `${owner}/late`)
  assert.equal(reopened.verify(lateProof, delayed.scope.descriptor, `${owner}/late`), true)
  const late = delayed.scope.spawn(request(`require('node:fs').writeFileSync(${JSON.stringify(lateFile)},'unexpected')`))
  await Promise.all([
    assert.rejects(late.done, /permanently sealed/),
    assert.rejects(late.waitForExit()),
  ])
  assert.equal(existsSync(lateFile), false)
  await notify({ kind: 'result', verified: true, sequentialChildren: 2, descendantTerminated: true,
    lateLaunchRejected: true, durableRunnerRejection: true, freshProviderProof: true, node: process.version, resolved })
} finally {
  const failures = []
  for (const provider of providers.reverse()) {
    try { await provider.dispose() } catch (error) { failures.push(error) }
  }
  for (const handle of handles) {
    try {
      handle.terminate()
      await handle.done
      assert.equal(await handle.waitForExit(AbortSignal.timeout(15_000)), true)
    } catch (error) { failures.push(error) }
  }
  if (descendant) {
    try {
      if (!descendantExited()) {
        assert.notEqual(api.terminateProcess(descendant, 1), 0)
        await waitUntil(descendantExited, 'Owned descendant cleanup')
      }
      nativeCleanupComplete = true
    } catch (error) { failures.push(error) }
    finally { closeHandleChecked(api, descendant, 'artifact smoke descendant') }
  }
  try { await context.fiber.dispose() } catch (error) { failures.push(error) }
  if (process.connected) process.disconnect()
  if (failures.length) throw new AggregateError(failures, `Artifact consumer cleanup failed (descendant joined: ${nativeCleanupComplete})`)
}
