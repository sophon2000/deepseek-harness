/**
 * Deliverables plugin, browser half: registers the produced-files row into
 * the chat view's turn-tail chain, and contributes produced and presented
 * paths to chat's file-reference registry. Mutation policy and copy live here;
 * unique-reference matching lives in chat. Removing this plugin removes its
 * cards and references without removing other plugins' contributions.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ChatFileMentionProvider } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PresentedOpenController } from './present-open.ts'
import { PresentRow } from './PresentRow.tsx'
import { Deliverables, selectDeliverables, type DeliverablesInjected } from './Deliverables.tsx'
import { en, NS, zh, type DeliverablesKey } from './locales.ts'
import {
  basename, deliverablesDefinition, presentedForClosing, selectProducedFiles,
} from './turn-deliverables.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Produced-files row copy. */
    'deliverables': DeliverablesKey
  }
}

export { ProducedFiles, type ProducedFilesProps } from './ProducedFiles.tsx'
export { producedForClosing } from './turn-deliverables.ts'

/** Required services for the tail-slot registration and its dictionaries. */
export const inject = ['slots', 'locale', 'uiConversation', 'remote', 'remote.session', 'chatFileMentions']

/**
 * Client plugin body: register the dictionaries and the turn-tail entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const opener = new PresentedOpenController()
  ctx.effect(() => () => opener.dispose())
  ctx.on('connection/reset', () => { opener.resetHost() })
  ctx.uiConversation.events.register(deliverablesDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-deliverables: dictionaries')
  ctx.slots.inject(
    'conversation.chat.turnTail',
    () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      select: selectDeliverables,
      locale: NS,
      inject: (): DeliverablesInjected => ({
        hooks: { presentedOpen: opener.state, presentedHost: opener.host },
        reloadPresentedHost: () => opener.loadHost(),
        openPresented: (sessionId, seq, index, action) => opener.open(sessionId, seq, index, action),
      }),
    }, Deliverables),
  )
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'present', locale: NS }, PresentRow,
  ))
  // Default prose clicks preview in-app, like the card's preview action.
  // Native application and file-manager actions remain explicit card choices.
  const t = ctx.locale.bind(NS)
  const mentions: ChatFileMentionProvider = {
    id: 'deliverables',
    forClosing(owner) {
      // Same claim test the turn-tail chain entry runs: no produced files,
      // no vocabulary — the two surfaces agree by construction.
      const paths = selectProducedFiles(owner)
      const presented = presentedForClosing(owner)
      if (paths === null && presented.length === 0) return []
      const deliveries = new Map(presented.map(file => [file.path, file]))
      return [...new Set([...paths ?? [], ...deliveries.keys()])].map(path => ({
        name: path, aliases: [basename(path)], title: path,
        label: t(deliveries.has(path) ? 'presented.open' : 'produced.open', { name: path }),
        open: () => owner.openFile(path),
      }))
    },
  }
  ctx.effect(() => ctx.chatFileMentions.register(mentions), 'ui-deliverables: file mentions')
}
