// A real Loader/Profile in a child process: process-owned boot hooks never enter Vitest's worker.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const repo = resolve(import.meta.dirname, '../../../../../..')
const require = createRequire(join(repo, 'apps/desktop-host/package.json'))
const gatewayRequire = createRequire(join(repo, 'packages/api/gateway/package.json'))
const { runProfile } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')).href)
const { loadProfileDirectory } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const { default: WebSocket } = await import(pathToFileURL(gatewayRequire.resolve('ws')).href)
const broken = process.argv[2] === 'broken'
const root = await mkdtemp(join(tmpdir(), 'dsh-typed-admission-'))
process.env.DSH_HOME = join(root, 'home')
const project = join(root, 'profile')
const modules = join(project, 'node_modules')
const fixture = join(modules, '@fixture/admission')
let running
let socket
let socketClosed
const version = JSON.parse(await readFile(join(repo, 'apps/cli/package.json'), 'utf8')).version
try {
  await mkdir(fixture, { recursive: true })
  await symlink(join(repo, 'node_modules/.pnpm/node_modules/@deepseek-ai'), join(modules, '@deepseek-ai'), 'dir')
  await symlink(dirname(gatewayRequire.resolve('zod/package.json')), join(modules, 'zod'), 'dir')
  const packages = ['typert-registry', 'api-remote-access', 'api-gateway', 'typert-loader',
    'credentials', 'credentials-local', 'client-connection', 'host-webserver']
  await writeFile(join(project, 'package.json'), JSON.stringify({ private: true,
    dependencies: { ...Object.fromEntries(packages.map(name => [`@deepseek-ai/dsh-${name}`, version])), '@fixture/admission': '0.0.0' },
    dsh: { profile: { bundles: [] } } }))
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: '@fixture/admission', version: '0.0.0',
    type: 'module', exports: { '.': './service.mjs', './package.json': './package.json', './typert': './typert.mjs' } }))
  await writeFile(join(fixture, 'service.mjs'), await readFile(join(import.meta.dirname, 'service.mjs')))
  await writeFile(join(fixture, 'typert.mjs'), broken
    ? `export const TYPERT = { package: '@fixture/admission', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, get invocations() { throw new Error('fixture Host export adapter failed') } }`
    : await readFile(join(import.meta.dirname, 'typert.mjs')))
  await writeFile(join(project, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'credentials-local', name: '@deepseek-ai/dsh-credentials-local', config: { dshHome: process.env.DSH_HOME, watch: false } },
    { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'connection', name: '@deepseek-ai/dsh-client-connection' },
    { id: 'typert', name: '@deepseek-ai/dsh-typert-registry' },
    { id: 'access', name: '@deepseek-ai/dsh-api-remote-access' },
    { id: 'gateway', name: '@deepseek-ai/dsh-api-gateway', config: { requireTypedDefinitions: true } },
    { id: 'fixture', name: '@fixture/admission' },
    { id: 'typed-loader', name: '@deepseek-ai/dsh-typert-loader', config: { packages: ['@fixture/admission'] } },
  ] }]))
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
  running = await runProfile({ environment: new Map(), profile: 'admission-fixture',
    resolvedProfile: { profile: loadProfileDirectory('dsh', project, installAnchor), installAnchor }, patchFiles: [], args: [] })
  const { ctx } = running
  assert.equal(ctx.typertGateway.requiresTypedDefinitions, true)
  const service = ctx.get('admissionFixture')
  assert.ok(service, 'actual SRC service is active')
  let ready = false
  ctx.get('appReady').onReady(() => { ready = true })
  assert.equal(ready, true)
  const origin = ctx.webServer.getOrigin()
  const connect = new URL(ctx.connection.authenticatedUrl(`${origin}/connect`))
  connect.searchParams.set('interactions', 'answer')
  const exchange = await fetch(connect, { redirect: 'manual', headers: { accept: 'application/json' } })
  assert.equal(exchange.status, 302)
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  await exchange.arrayBuffer()
  assert.ok(cookie, 'real browser credential exchange must issue a cookie')
  let rpc = 0
  async function http(method, args) {
    const response = await fetch(`${origin}/api/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: `rpc-${++rpc}`, method, payload: { args } }) })
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: { cookie } })
  const inbox = new Map()
  socket.on('message', data => {
    const frame = JSON.parse(data.toString())
    const box = inbox.get(frame.streamId)
    assert.ok(box, `unexpected stream ${frame.streamId}`)
    box.frames.push(frame)
    if (frame.type === 'error' || frame.type === 'end' || (frame.type === 'item' && frame.value?.type === 'ready')) box.done.resolve(box.frames)
  })
  socket.on('error', error => { for (const box of inbox.values()) box.done.reject(error) })
  socketClosed = new Promise(resolve => socket.once('close', resolve))
  await once(socket, 'open')
  let streams = 0
  function stream(endpoint, args) {
    const streamId = `stream-${++streams}`
    const box = { frames: [], done: Promise.withResolvers() }
    inbox.set(streamId, box)
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    return box.done.promise
  }
  const args = { targetId: 'target-1', request: { title: 'ready' } }
  async function denied() {
    assert.equal((await http('admissionFixture/read', args)).error?.code, 'gateway/definition-unavailable')
    assert.equal((await stream('admissionFixture/follow', args))[0].error?.code, 'gateway/definition-unavailable')
  }
  if (broken) {
    assert.equal(ctx.typert.local.hasSeen('admissionFixture/read'), false)
    await denied()
    assert.equal(service.calls, 0)
    assert.equal(service.lookups, 0)
  } else {
    assert.deepEqual(await http('admissionFixture/read', args), { ok: true, value: 'target-1:ready' })
    const frames = await stream('admissionFixture/follow', args)
    assert.equal(frames[0].value, 'target-1:ready')
    assert.equal(frames[1].type, 'end')
    assert.equal((await http('admissionFixture/read', { ...args, request: { title: 'ready', undeclared: true } })).error?.code, 'gateway/input-invalid')
    assert.equal(service.calls, 2)
    ctx.effect(() => ctx.typertGateway.registerRemoteEvents(async function* (signal) {
      await new Promise(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
    }, { home: process.env.DSH_HOME }))
    const events = await stream('$events', {})
    assert.equal(events[0]?.value?.type, 'ready', JSON.stringify(events))
    // Both authenticated carriers pause at lookup before the actual Loader owner is disposed.
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    let waiting = 0
    service.resolveTarget = async id => {
      if (++waiting === 2) entered.resolve()
      await release.promise
      return { id }
    }
    const pending = Promise.all([http('admissionFixture/read', args), stream('admissionFixture/follow', args)])
    try {
      await entered.promise
      const entry = [...ctx.loader.entries()].find(value => value.options.id === 'typed-loader')
      assert.ok(entry?.fiber, 'actual Typert Loader owns the definitions')
      await entry.fiber.dispose()
      assert.equal(ctx.typert.local.get('admissionFixture/read'), undefined)
      assert.ok(ctx.get('admissionFixture'), 'withdrawing Host definitions leaves the SRC service active')
      const { TYPERT } = await import(pathToFileURL(join(fixture, 'typert.mjs')).href)
      // Loader imports are cached: re-registering the exact artifact must not authorize either prepared request.
      const remove = ctx.typert.register(TYPERT)
      release.resolve()
      const [unary, downlink] = await pending
      assert.equal(unary.error?.code, 'gateway/definition-unavailable')
      assert.equal(downlink[0].error?.code, 'gateway/definition-unavailable')
      assert.equal(service.calls, 2)
      await remove()
      await denied()
      ctx.typert.register(TYPERT)
      service.resolveTarget = id => ({ id })
      assert.equal((await http('admissionFixture/read', args)).value, 'target-1:ready')
      assert.equal((await stream('admissionFixture/follow', args))[0].value, 'target-1:ready')
    } finally { release.resolve(); await pending }
  }
  console.log(`TYPED_ADMISSION_PROFILE_OK ${broken ? 'failed-host-export' : 'live-withdrawal-replacement'}`)
} finally {
  try {
    if (socket) {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
      else socket.close()
      await socketClosed
    }
  } finally {
    try { await running?.shutdown.shutdown(0) }
    finally { await rm(root, { recursive: true, force: true }) }
  }
}
