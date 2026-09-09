import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TurnTailOwnerProps } from '../src/client/contract/slots.ts'
import { FileMentionRegistry } from '../src/client/file-mentions.ts'

const owner = {} as TurnTailOwnerProps
const session = SessionId('viewed-session')
const reference = (name: string, aliases: string[] = []) => ({ name, aliases, title: name, label: name, open: vi.fn() })

describe('composed file mentions', () => {
  it('combines native and plugin references without guessing shared basenames', () => {
    const registry = new FileMentionRegistry()
    expect(registry.forClosing(owner, session)).toBeUndefined()
    const native = reference('/files/a.mp4', ['a.mp4'])
    const asset = reference('asset-1', ['b.mp4'])
    const nativeProvider = { id: 'native', forClosing: vi.fn(() => [native]) }
    registry.register(nativeProvider)
    const dispose = registry.register({ id: 'asset', forClosing: () => [asset] })
    const resolved = registry.forClosing(owner, session)!
    resolved.resolve('a.mp4')!.open()
    resolved.resolve('b.mp4')!.open()
    expect(native.open).toHaveBeenCalledOnce()
    expect(asset.open).toHaveBeenCalledOnce()
    expect(nativeProvider.forClosing).toHaveBeenCalledWith(owner, session)
    expect(resolved.resolve('mp4')).toBeUndefined()
    dispose()
    resolved.resolve('b.mp4')!.open()
    expect(asset.open).toHaveBeenCalledOnce()
    expect(registry.forClosing(owner, session)!.resolve('b.mp4')).toBeUndefined()
    registry.register({ id: 'asset', forClosing: () => [reference('asset-2', ['a.mp4'])] })
    expect(registry.forClosing(owner, session)!.resolve('a.mp4')).toBeUndefined()
    expect(registry.forClosing(owner, session)!.resolve('/files/a.mp4')).toBeDefined()
  })

  it('rejects duplicate providers, ambiguous exact names, and publishes idempotent disposal', () => {
    const registry = new FileMentionRegistry()
    const notify = vi.fn()
    const unsubscribe = registry.revision.subscribe(notify)
    const provider = { id: 'a', forClosing: () => [reference('same'), reference('same')] }
    const dispose = registry.register(provider)
    expect(registry.revision.getSnapshot()).toBe(1)
    expect(() => registry.register(provider)).toThrow('Duplicate')
    expect(registry.forClosing(owner, session)!.resolve('same')).toBeUndefined()
    dispose(); dispose()
    expect(registry.revision.getSnapshot()).toBe(2)
    expect(notify).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
