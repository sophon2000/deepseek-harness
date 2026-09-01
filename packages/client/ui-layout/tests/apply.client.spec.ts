// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as themeApply, inject as themeInject, ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject, LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-layout'
import * as invariant from '@deepseek-ai/dsh-client-ui-layout/invariant'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createLayoutStore } from '../src/client/stores.ts'

beforeEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => { node.remove() })
})

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotRegistry)
  ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: { 's-test': { blank: false } }, current: 's-test' }) } } as never)
  // Theme registers its Appearance settings row and requires the connection
  // seam for persistence; model this bench as a remote, memory-only browser.
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  // ui-theme's Appearance row binds a durable scope through these two.
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: themeInject, apply: themeApply }).await()
  await slotsFiber.await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

describe('ui-layout client apply', () => {
  it('updates the live roster and releases only the removed plugin view', async () => {
    const { ctx, slots } = await bench()
    const owner = ctx.plugin({ inject, apply })
    await owner.await()
    const state = createLayoutStore().create()
    const face = (slots.entries('root')[0]!.inject as (actions: typeof state.actions) => {
      hooks: { detailTabs: { getSnapshot: () => readonly { id: string }[] } }
    })(state.actions)
    const plugin = (id: string) => ctx.plugin({
      inject: ['slots'],
      apply(c: Context) {
        c.slots.inject('shell.details.view', () => c.slots.register({ name: 'shell.details.view', id, label: id }, () => null))
      },
    })
    const first = plugin('plugin-a')
    const second = plugin('plugin-b')
    await first.await()
    await second.await()
    expect(face.hooks.detailTabs.getSnapshot().map(t => t.id)).toEqual(['plugin-a', 'plugin-b'])
    expect(ctx.detailViews.open('s-test' as SessionId, 'plugin-a')).toBe(true)
    await first.dispose()
    expect(state.getSnapshot()).toMatchObject({ view: null, details: 360 })
    expect(face.hooks.detailTabs.getSnapshot().map(t => t.id)).toEqual(['plugin-b'])
    expect(ctx.detailViews.open('s-test' as SessionId, 'plugin-a')).toBe(false)
    expect(ctx.detailViews.open('s-test' as SessionId, 'plugin-b')).toBe(true)
    const reinstalled = plugin('plugin-a')
    await reinstalled.await()
    expect(state.getSnapshot().view?.id).toBe('plugin-b')
    const retained = ctx.detailViews
    await owner.dispose()
    expect(retained.open('s-test' as SessionId, 'plugin-b')).toBe(false)
    expect(retained.close('s-test' as SessionId)).toBe(false)
    expect(ctx.get('detailViews')).toBeUndefined()
    expect(slots.spec('shell.details.view')).toBeUndefined()
    const restoredOwner = ctx.plugin({ inject, apply })
    await restoredOwner.await()
    const restoredState = createLayoutStore().create()
    ;(slots.entries('root')[0]!.inject as (actions: typeof restoredState.actions) => unknown)(restoredState.actions)
    expect(restoredState.getSnapshot().view).toBeNull()
    expect(ctx.detailViews).not.toBe(retained)
    expect(ctx.detailViews.open('s-test' as SessionId, 'plugin-b')).toBe(true)
    expect(retained.open('s-test' as SessionId, 'plugin-b')).toBe(false)
    await restoredOwner.dispose()
    await second.dispose()
    await reinstalled.dispose()
  })
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots', 'theme', 'locale', 'sessions'])
  })

  it('provides ctx.layout and registers AppFrame with native and additive child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.get('layout')).toBeInstanceOf(LayoutController)
    // The one register() call occupied 'root'…
    expect(slots.entries('root')).toHaveLength(1)
    // …and declared the native and additive children in the ledger.
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('shell.details.view')).toEqual({ kind: 'list', scope: 'session' })
  })

  it('injects no business face and attaches the layout actions', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const actions = {
      setSidebar: vi.fn(), setDetails: vi.fn(), toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
    }
    const injected = (slots.entries('root')[0]!.inject as (actions: never) => object)(actions as never)
    expect(Object.keys(injected)).toEqual(['hooks'])
    const layout = ctx.get('layout') as LayoutController
    layout.toggleSidebar()
    expect(actions.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('theme presenter applies the initial snapshot, follows theme/change, and unwinds on dispose', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Initial getter application: jsdom has no matchMedia, system resolves light.
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    const themeColorMeta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    expect(themeColorMeta).not.toBeNull()
    const theme = ctx.get('theme') as ThemeRuntime
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.head.querySelector('meta[name="theme-color"]')).toBe(themeColorMeta)
    await fiber.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    expect(themeColorMeta?.isConnected).toBe(false)
    // Listener is off: further theme changes no longer reach the document.
    theme.setTheme('light')
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
  })

  it('teardown unwinds the service, the root registration, and the child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entries('root')).toHaveLength(0)
    expect(slots.spec('sidebar')).toBeUndefined()
    // The built-in root declaration survives entry teardown (renderer-owned).
    expect(slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
  })
})

describe('node half + invariant companion', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    nodeApply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })

  it('invariant companion registers under the package name', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never
    // The /invariant subpath types live in lib/types (build product); assert
    // the API so the call stays typed where lint runs without a build.
    const dispose = await (invariant as { apply: (ctx: never) => Promise<() => void> }).apply(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-layout', expect.any(Function))
    // The installer is the declared no-op — calling it must not throw.
    expect(() => { (register.mock.calls[0]![1] as (c: never) => void)(undefined as never) }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
