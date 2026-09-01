import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DetailViewController } from '../src/client/detail-views.ts'
import { createLayoutStore } from '../src/client/stores.ts'

const a = 'session-a' as SessionId
const b = 'session-b' as SessionId

describe('details view navigation', () => {
  it('rejects stale Sessions and removed views without mutating the current view', () => {
    let current: SessionId | undefined = a
    const ids = new Set(['plugin-a', 'plugin-b'])
    const controller = new DetailViewController(() => current, id => ids.has(id))
    const store = createLayoutStore().create()
    controller.attach(store.actions)
    expect(controller.open(a, 'plugin-a')).toBe(true)
    const first = store.getSnapshot()
    expect(controller.open(b, 'plugin-b')).toBe(false)
    expect(controller.close(b)).toBe(false)
    expect(controller.open(a, 'missing')).toBe(false)
    expect(store.getSnapshot()).toBe(first)
    ids.delete('plugin-b')
    expect(controller.open(a, 'plugin-b')).toBe(false)
    current = undefined
    expect(controller.close(a)).toBe(false)
  })

  it('focuses repeated opens, returns to native tools on removal, and clears on close', () => {
    const controller = new DetailViewController(() => a, () => true)
    const store = createLayoutStore().create()
    controller.attach(store.actions)
    controller.open(a, 'plugin-a')
    controller.open(a, 'plugin-a')
    expect(store.getSnapshot()).toMatchObject({ view: { sessionId: a, id: 'plugin-a' }, focusRevision: 2 })
    store.actions.reconcileViews(['plugin-a', 'plugin-b'])
    expect(store.getSnapshot().view?.id).toBe('plugin-a')
    store.actions.reconcileViews(['plugin-b'])
    expect(store.getSnapshot()).toMatchObject({ view: null, details: 360, focusRevision: 3 })
    controller.open(a, 'plugin-b')
    store.actions.openDetails()
    expect(store.getSnapshot().view).toBeNull()
    expect(controller.close(a)).toBe(true)
    expect(store.getSnapshot()).toMatchObject({ view: null, details: 0 })
  })

  it('requires the rendered root and replaces stale action bindings on remount', () => {
    const controller = new DetailViewController(() => a, () => true)
    expect(() => controller.open(a, 'plugin-a')).toThrow('root entry not mounted')
    const oldStore = createLayoutStore().create()
    const newStore = createLayoutStore().create()
    controller.attach(oldStore.actions)
    controller.attach(newStore.actions)
    controller.open(a, 'plugin-a')
    expect(oldStore.getSnapshot().details).toBe(0)
    expect(newStore.getSnapshot().view?.id).toBe('plugin-a')
    controller.dispose()
    const before = newStore.getSnapshot()
    controller.attach(oldStore.actions)
    expect(controller.open(a, 'plugin-a')).toBe(false)
    expect(controller.close(a)).toBe(false)
    expect(newStore.getSnapshot()).toBe(before)
    expect(oldStore.getSnapshot().details).toBe(0)
  })
})
