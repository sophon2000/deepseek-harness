/** Composable, fail-closed inline-code mention vocabulary for closing prose. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ChatFileMentionProvider, ChatFileMentions, TurnTailOwnerProps,
} from './contract/slots.ts'

/**
 * Owns effect-scoped file-mention providers for Chat.
 *
 * A token is interactive only when exactly one provider claims it. This keeps
 * independently composed product vocabularies from silently shadowing each
 * other or opening an unintended resource.
 */
export class ChatFileMentionRegistry implements ChatFileMentions {
  /** Stable renderer source for provider lifetime changes. */
  readonly revision = createSnapshotStore(0)
  readonly #providers = new Map<string, { provider: ChatFileMentionProvider }>()

  register(id: string, provider: ChatFileMentionProvider): () => void {
    if (id.length === 0) throw new Error('chat file mention provider id must not be empty')
    if (this.#providers.has(id)) throw new Error(`chat file mention provider "${id}" is already registered`)
    const registration = { provider }
    this.#providers.set(id, registration)
    this.revision.set(this.revision.getSnapshot() + 1)
    return () => {
      if (this.#providers.get(id) !== registration) return
      this.#providers.delete(id)
      this.revision.set(this.revision.getSnapshot() + 1)
    }
  }

  forClosing(owner: TurnTailOwnerProps, sessionId: SessionId): MarkdownFileMentions | undefined {
    const revision = this.revision.getSnapshot()
    const current = () => this.revision.getSnapshot() === revision
    const resolvers: MarkdownFileMentions[] = []
    for (const { provider } of this.#providers.values()) {
      const resolver = provider.forClosing(owner, sessionId)
      if (resolver !== undefined) resolvers.push(resolver)
    }
    if (resolvers.length === 0) return undefined
    return {
      resolve(value) {
        if (!current()) return undefined
        let match: ReturnType<MarkdownFileMentions['resolve']>
        for (const resolver of resolvers) {
          const candidate = resolver.resolve(value)
          if (candidate === undefined) continue
          if (match !== undefined) return undefined
          match = candidate
        }
        if (match === undefined) return undefined
        const target = match
        return {
          ...target,
          open() {
            // A disposed vocabulary must be inert even before React commits
            // the revision that removes its rendered buttons.
            if (current()) target.open()
          },
        }
      },
    }
  }
}
