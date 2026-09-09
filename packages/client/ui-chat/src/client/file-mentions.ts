/** Effect-owned file-reference providers for closing Assistant prose. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatFileMentionProvider, ChatFileMentions, TurnTailOwnerProps } from './contract/slots.ts'

/** Chat owns the provider roster; contributors own reference identity and opening. */
export class FileMentionRegistry implements ChatFileMentions {
  readonly revision = createSnapshotStore(0)
  private readonly providers = new Set<ChatFileMentionProvider>()

  register(provider: ChatFileMentionProvider): () => void {
    if ([...this.providers].some(value => value.id === provider.id)) throw new Error(`Duplicate file-mention provider: ${provider.id}`)
    this.providers.add(provider)
    this.revision.set(this.revision.getSnapshot() + 1)
    return () => {
      if (this.providers.delete(provider)) this.revision.set(this.revision.getSnapshot() + 1)
    }
  }

  forClosing(owner: TurnTailOwnerProps, sessionId: SessionId): MarkdownFileMentions | undefined {
    const revision = this.revision.getSnapshot()
    const references = [...this.providers].flatMap(provider => provider.forClosing(owner, sessionId))
    if (references.length === 0) return undefined
    return {
      resolve: (value) => {
        const exact = references.filter(reference => reference.name === value)
        const matches = exact.length > 0 ? exact : references.filter(reference => reference.aliases?.includes(value))
        if (matches.length !== 1) return undefined
        const reference = matches[0]
        if (reference === undefined) return undefined
        return {
          title: reference.title,
          label: reference.label,
          open: () => {
            // A detached plugin must not retain a clickable capability in old prose.
            if (this.revision.getSnapshot() === revision) reference.open()
          },
        }
      },
    }
  }
}
