/**
 * Test-only plain-Node driver: --consumer-root <absolute package/consumer directory> --mode built|packed.
 * Built mode uses subprocess-local's workspace directory; packed mode uses a separate installed consumer.
 * Both modes require completed package artifacts and install no dependencies.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { closeHandleChecked, isJobEmpty, loadWin32OperationBindings, terminateJob } from '@deepseek-ai/dsh-win32-process'
import koffi from 'koffi'

const { values } = parseArgs({ options: {
  'consumer-root': { type: 'string' }, mode: { type: 'string' }, 'interrupt-consumers': { type: 'boolean' },
} })
assert.equal(process.platform, 'win32', 'This smoke requires native Windows')
assert.ok(values['consumer-root'] && isAbsolute(values['consumer-root']), '--consumer-root must be absolute')
assert.ok(values.mode === 'built' || values.mode === 'packed', '--mode must be built or packed')
const consumerRoot = realpathSync(values['consumer-root'])
const fixture = fileURLToPath(new URL('./operation-artifact-host.mjs', import.meta.url))
const runs = []
const directories = []
const jobs = []
const api = loadWin32OperationBindings()
const openProcess = koffi.load('kernel32.dll').func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32'])

function startConsumer() {
  const directory = mkdtempSync(join(consumerRoot, '.operation-artifact-'))
  directories.push(directory)
  const script = join(directory, 'host.mjs')
  copyFileSync(fixture, script)
  const job = api.createJobObjectW(null, null)
  assert.ok(job, 'Create the driver-owned cleanup Job')
  jobs.push(job)
  const limits = Buffer.alloc(144)
  limits.writeUInt32LE(0x2000, 16)
  assert.notEqual(api.setInformationJobObject(job, 9, limits, limits.length), 0)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(NODE_|TSX_|DSH_)/i.test(name)))
  env.DSH_HOME = join(directory, 'home')
  env.DSH_AGENTS_HOME = join(directory, 'agents')
  env.DSH_TELEMETRY_MODE = 'DISABLED'
  const child = spawn(process.execPath, [script, values.mode, consumerRoot], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const run = { directory, child, stdout: '', stderr: '', timedOut: false, report: undefined }
  runs.push(run)
  for (const [stream, field] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    stream.on('data', bytes => {
      run[field] += bytes.toString()
      if (run[field].length > 1_000_000) {
        run[field] = run[field].slice(-1_000_000)
        child.kill()
      }
    })
  }
  let readyResolve
  let readyReject
  run.ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject })
  let activeResolve
  let activeReject
  run.active = new Promise((accept, reject) => { activeResolve = accept; activeReject = reject })
  // Keep failure observed even if acquiring the second consumer fails.
  void run.ready.catch(() => {})
  void run.active.catch(() => {})
  child.on('message', message => {
    if (message?.kind === 'ready') readyResolve(message)
    if (message?.kind === 'descendant-ready') activeResolve(message)
    if (message?.kind === 'result') run.report = message
  })
  let launchError
  child.once('error', error => { launchError = error; readyReject(error); activeReject(error) })
  const timer = setTimeout(() => { run.timedOut = true; child.kill() }, 90_000)
  run.closed = new Promise(accept => child.once('close', (code, signal) => {
    clearTimeout(timer)
    const disposition = JSON.stringify({ code, signal, timedOut: run.timedOut })
    readyReject(new Error(`Consumer exited before readiness ${disposition}: ${run.stderr}`))
    activeReject(new Error(`Consumer exited before descendant readiness ${disposition}: ${run.stderr}`))
    accept({ code, signal, launchError })
  }))
  // No target launch occurs before the IPC barrier; the test Job owns the Host and all later descendants.
  assert.ok(child.pid, 'Consumer Host must start')
  const host = openProcess(0x101101, 0, child.pid)
  assert.ok(host, 'Open the newly spawned test Host')
  try { assert.notEqual(api.assignProcessToJobObject(job, host), 0, 'Assign the test Host to its cleanup Job') }
  finally { closeHandleChecked(api, host, 'artifact smoke Host') }
  return run
}

try {
  const first = startConsumer()
  const second = startConsumer()
  const ready = await Promise.all(runs.map(run => run.ready))
  assert.notEqual(ready[0].locator, ready[1].locator)
  // Both providers have durable reservations before either starts target work.
  await Promise.all(runs.map(run => new Promise((accept, reject) => {
    run.child.send({ kind: 'go' }, error => error ? reject(error) : accept())
  })))
  const active = await Promise.all(runs.map(run => run.active))
  assert.notEqual(active[0].pid, active[1].pid)
  if (values['interrupt-consumers']) throw new Error('Intentional interruption with both owned descendants alive')
  // Both real detached descendants are alive before either consumer seals its operation.
  await Promise.all(runs.map(run => new Promise((accept, reject) => {
    run.child.send({ kind: 'seal' }, error => error ? reject(error) : accept())
  })))
  const outcomes = await Promise.all(runs.map(run => run.closed))
  outcomes.forEach((outcome, index) => {
    const run = runs[index]
    assert.equal(run.timedOut, false, `Consumer deadline expired: ${run.stderr}`)
    assert.equal(outcome.launchError, undefined)
    assert.equal(outcome.signal, null, `Consumer ended by signal: ${run.stderr}`)
    assert.equal(outcome.code, 0, `Consumer failed: ${run.stderr}`)
    assert.equal(run.report?.verified, true, 'Consumer omitted verified result')
  })
  console.log(JSON.stringify({ mode: values.mode, node: process.version, consumerRoot,
    consumers: [first.report, second.report] }, null, 2))
} finally {
  await Promise.all(runs.map(async run => {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill()
    await run.closed
  }))
  const cleanup = await Promise.allSettled(jobs.map(async job => {
    try {
      terminateJob(api, job, 1)
      const deadline = performance.now() + 15_000
      while (!isJobEmpty(api, job)) {
        assert.ok(performance.now() < deadline, 'Driver-owned consumer Job did not become empty')
        await delay(10)
      }
    } finally { closeHandleChecked(api, job, 'artifact smoke cleanup Job') }
  }))
  const failed = cleanup.filter(result => result.status === 'rejected')
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Native cleanup failed; fixture directories retained')
  console.error(JSON.stringify({ cleanupJobsJoined: jobs.length }))
  for (const directory of directories) {
    // Only remove the exact real directory allocated by this driver beneath the supplied consumer.
    const path = realpathSync(directory)
    const childPath = relative(consumerRoot, path)
    assert.ok(childPath !== '' && childPath !== '..' && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath))
    assert.equal(lstatSync(directory).isSymbolicLink(), false)
    assert.equal(path, resolve(directory))
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 100 })
  }
}
