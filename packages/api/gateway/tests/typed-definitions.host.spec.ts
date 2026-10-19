import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { Remote, bindTypertRemote, type InvocationDescriptor, type TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry, { type TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGateway from '../src/index.ts'
import { ownerPeer } from './peer.ts'

interface Target { readonly id: string }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap { typedAdmission: TypertLookup<Target, string> }
}

class Items extends Service {
  readonly typertRemote = bindTypertRemote(this, 'typedItems')
  calls = 0
  constructor(ctx: Context) { super(ctx, 'typedItems') }
  @Remote
  read(target: Target, request: { title: string }): string {
    this.calls++
    return `${target.id}:${request.title}`
  }
  @Remote({ mode: 'stream' })
  follow(target: Target, request: { title: string }): Iterable<string> {
    this.calls++
    return [`${target.id}:${request.title}`]
  }
}

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

function descriptor(method: 'read' | 'follow'): InvocationDescriptor {
  return {
    id: `@fixture/typed-admission#typedItems/${method}`, service: 'typedItems', namespace: 'typedItems', method,
    invocation: { kind: 'direct' }, ...(method === 'follow' ? { mode: 'stream' as const } : {}),
    parameters: [
      { name: 'target', wire: 'targetId', source: 'lookup', lookup: 'typedAdmission',
        codec: { mode: 'strict', typeSymbol: 'string', create: () => z.string() } },
      { name: 'request', wire: 'request', source: 'json',
        codec: { mode: 'strict', typeSymbol: '@fixture/admission#Request', create: () => z.strictObject({ title: z.string() }) } },
    ],
    result: { mode: 'strict', typeSymbol: 'string', create: () => z.string() },
  }
}

function register(ctx: Context, invocation: InvocationDescriptor) {
  const contribution: TypertContribution = { package: '@fixture/typed-admission', face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: [invocation] }
  return ctx.typert.register(contribution)
}

async function setup(requireTypedDefinitions = true) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGateway, { requireTypedDefinitions })
  const service = new Items(ctx)
  const lookup = { calls: 0, resolve: (id: string): Target | Promise<Target> => ({ id }) }
  ctx.typert.lookups.register('typedAdmission', {
    parameter: 'target', wire: 'targetId', hostTypeSymbol: '@fixture/admission#Target', wireTypeSymbol: 'string',
    resolve(id) { lookup.calls++; return lookup.resolve(id) },
  })
  const request = (method: 'read' | 'follow') => ({ namespace: 'typedItems', method,
    args: { targetId: 'target-1', request: { title: 'ready' } }, peer: ownerPeer(ctx) })
  const call = (method: 'read' | 'follow') => method === 'read'
    ? ctx.typertGateway.invoke(request(method)) : ctx.typertGateway.stream(request(method))
  return { ctx, service, lookup, call }
}

it.each(['read', 'follow'] as const)('refuses unseen %s definitions before lookup or business code', async (method) => {
  const f = await setup()
  await expect(f.call(method)).rejects.toMatchObject({ code: 'gateway/definition-unavailable' })
  expect(f.lookup.calls).toBe(0)
  expect(f.service.calls).toBe(0)
})

it.each(['read', 'follow'] as const)('accepts a live typed %s definition', async (method) => {
  const f = await setup()
  register(f.ctx, descriptor(method))
  const result = await f.call(method)
  if (method === 'read') {
    expect(result).toBe('target-1:ready')
  } else {
    const items: string[] = []
    for await (const item of result as AsyncIterable<string>) items.push(item)
    expect(items).toEqual(['target-1:ready'])
  }
  expect(f.lookup.calls).toBe(1)
  expect(f.service.calls).toBe(1)
})

it.each(['read', 'follow'] as const)('does not accept registered source-only %s codecs as typed definitions', async (method) => {
  const f = await setup()
  const value = descriptor(method)
  register(f.ctx, { ...value, parameters: value.parameters.map(parameter => ({ ...parameter, codec: { mode: 'src-json' } })) })
  await expect(f.call(method)).rejects.toMatchObject({ code: 'gateway/definition-unavailable' })
  expect(f.lookup.calls).toBe(0)
  expect(f.service.calls).toBe(0)
})

it.each(['read', 'follow'] as const)('rejects %s after a definition is removed during lookup', async (method) => {
  const f = await setup()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.lookup.resolve = async (id) => { entered.resolve(undefined); await release.promise; return { id } }
  const unregister = register(f.ctx, descriptor(method))
  const pending = f.call(method)
  const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    await unregister()
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ error: { code: 'gateway/definition-unavailable' } })
    expect(f.lookup.calls).toBe(1)
    expect(f.service.calls).toBe(0)
  } finally { release.resolve(undefined); await outcome }
})

it.each(['result', 'context', 'uplink'] as const)('refuses a source-only %s codec before lookup', async (field) => {
  const f = await setup()
  const value = descriptor('read')
  const source = { mode: 'src-json' as const }
  register(f.ctx, { ...value,
    ...(field === 'result' ? { result: source } : {}),
    ...(field === 'context' ? { invocation: { kind: 'context' as const, context: 'unused', wire: 'scopeId', codec: source } } : {}),
    ...(field === 'uplink' ? { uplink: { codec: source } } : {}),
  })
  await expect(f.call('read')).rejects.toMatchObject({ code: 'gateway/definition-unavailable' })
  expect(f.lookup.calls).toBe(0)
  expect(f.service.calls).toBe(0)
})

it('rejects a replaced definition before dispatch and admits the next call with its new definition', async () => {
  const f = await setup()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.lookup.resolve = async (id) => { entered.resolve(undefined); await release.promise; return { id } }
  const unregister = register(f.ctx, descriptor('read'))
  const outcome = f.call('read').then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    await unregister()
    register(f.ctx, descriptor('read'))
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ error: { code: 'gateway/definition-unavailable' } })
    expect(f.service.calls).toBe(0)
    await expect(f.call('read')).resolves.toBe('target-1:ready')
  } finally { release.resolve(undefined); await outcome }
})

it.each(['read', 'follow'] as const)('rejects %s when a withdrawn descriptor object is registered again during lookup', async (method) => {
  const f = await setup()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.lookup.resolve = async (id) => { entered.resolve(undefined); await release.promise; return { id } }
  const value = descriptor(method)
  const unregister = register(f.ctx, value)
  const outcome = f.call(method).then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    await unregister()
    register(f.ctx, value)
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ error: { code: 'gateway/definition-unavailable' } })
    expect(f.service.calls).toBe(0)
  } finally { release.resolve(undefined); await outcome }
})

it('preserves explicitly selected source compatibility', async () => {
  const f = await setup(false)
  await expect(f.call('read')).resolves.toBe('target-1:ready')
  expect(f.service.calls).toBe(1)
})
