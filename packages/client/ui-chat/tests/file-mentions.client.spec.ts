import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatFileMentionProvider, TurnTailOwnerProps } from '../src/client/contract/slots.ts'
import { ChatFileMentionRegistry } from '../src/client/file-mentions.ts'

const SESSION_ID = 'viewed-session' as SessionId

function closingOwner(): TurnTailOwnerProps {
  return {
    seq: 12,
    openFile: vi.fn(),
    turn: {
      turn: 2, start: undefined, end: undefined, status: 'closed', steps: [],
      data: {
        get: () => undefined,
        source(): never { throw new Error('Unexpected Turn data subscription in registry test') },
      },
    },
  }
}

function mention(label: string): NonNullable<ReturnType<MarkdownFileMentions['resolve']>> {
  return { label, title: `/workspace/${label}`, open: vi.fn() }
}

function providerFor(target: NonNullable<ReturnType<MarkdownFileMentions['resolve']>>): ChatFileMentionProvider {
  return { forClosing: () => ({ resolve: value => value === target.label ? target : undefined }) }
}

describe('ChatFileMentionRegistry', () => {
  it('rejects an empty provider id without adding a vocabulary', () => {
    const registry = new ChatFileMentionRegistry()
    expect(() => registry.register('', providerFor(mention('README.md'))))
      .toThrow('chat file mention provider id must not be empty')
    expect(registry.forClosing(closingOwner(), SESSION_ID)).toBeUndefined()
  })

  it('rejects a duplicate id without replacing its registered provider', () => {
    const registry = new ChatFileMentionRegistry()
    const owner = closingOwner()
    const original = mention('README.md')
    const replacement = mention('other.md')
    const dispose = registry.register('files', providerFor(original))

    expect(() => registry.register('files', providerFor(replacement)))
      .toThrow('chat file mention provider "files" is already registered')
    const resolver = registry.forClosing(owner, SESSION_ID)!
    expect(resolver.resolve(original.label)).toBe(original)
    expect(resolver.resolve(replacement.label)).toBeUndefined()
    dispose()
    expect(registry.forClosing(owner, SESSION_ID)).toBeUndefined()
  })

  it('disposes only its own registration and leaves a later replacement intact', () => {
    const registry = new ChatFileMentionRegistry()
    const owner = closingOwner()
    const first = mention('first.md')
    const other = mention('other.md')
    const replacement = mention('replacement.md')
    const disposeFirst = registry.register('files', providerFor(first))
    const disposeOther = registry.register('other', providerFor(other))

    disposeFirst()
    disposeFirst()
    expect(registry.forClosing(owner, SESSION_ID)!.resolve(first.label)).toBeUndefined()
    expect(registry.forClosing(owner, SESSION_ID)!.resolve(other.label)).toBe(other)

    const disposeReplacement = registry.register('files', providerFor(replacement))
    disposeFirst()
    expect(registry.forClosing(owner, SESSION_ID)!.resolve(replacement.label)).toBe(replacement)
    disposeOther()
    expect(registry.forClosing(owner, SESSION_ID)!.resolve(other.label)).toBeUndefined()
    disposeReplacement()
    disposeReplacement()
    expect(registry.forClosing(owner, SESSION_ID)).toBeUndefined()
  })

  it('forwards the closing owner and viewed Session to unavailable providers', () => {
    const registry = new ChatFileMentionRegistry()
    const owner = closingOwner()
    const first = vi.fn<ChatFileMentionProvider['forClosing']>(() => undefined)
    const second = vi.fn<ChatFileMentionProvider['forClosing']>(() => undefined)
    registry.register('first', { forClosing: first })
    registry.register('second', { forClosing: second })

    expect(registry.forClosing(owner, SESSION_ID)).toBeUndefined()
    expect(first).toHaveBeenCalledExactlyOnceWith(owner, SESSION_ID)
    expect(second).toHaveBeenCalledExactlyOnceWith(owner, SESSION_ID)
  })

  it('resolves unique tokens across vocabularies and leaves unknown tokens inert', () => {
    const registry = new ChatFileMentionRegistry()
    const first = mention('first.md')
    const second = mention('second.md')
    registry.register('unavailable', { forClosing: () => undefined })
    registry.register('first', providerFor(first))
    registry.register('second', providerFor(second))

    const resolver = registry.forClosing(closingOwner(), SESSION_ID)!
    expect(resolver.resolve(first.label)).toBe(first)
    expect(resolver.resolve(second.label)).toBe(second)
    expect(resolver.resolve('unknown.md')).toBeUndefined()
    expect(first.open).not.toHaveBeenCalled()
    expect(second.open).not.toHaveBeenCalled()
    resolver.resolve(second.label)!.open()
    expect(second.open).toHaveBeenCalledExactlyOnceWith()
    expect(first.open).not.toHaveBeenCalled()
  })

  it('fails closed when multiple providers claim the same token', () => {
    const registry = new ChatFileMentionRegistry()
    const owner = closingOwner()
    const first = mention('shared.md')
    const second = mention('shared.md')
    second.title = '/different-workspace/shared.md'
    registry.register('first', providerFor(first))
    registry.register('unrelated', providerFor(mention('other.md')))
    const disposeSecond = registry.register('second', providerFor(second))

    expect(registry.forClosing(owner, SESSION_ID)!.resolve('shared.md')).toBeUndefined()
    expect(first.open).not.toHaveBeenCalled()
    expect(second.open).not.toHaveBeenCalled()
    disposeSecond()
    expect(registry.forClosing(owner, SESSION_ID)!.resolve('shared.md')).toBe(first)
  })
})
