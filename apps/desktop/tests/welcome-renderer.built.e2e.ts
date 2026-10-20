/** Execute the standalone welcome bundle with its bundled React runtime. */
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { WelcomeApi } from '../src/welcome-api.ts'

it('mounts the built welcome entry without contacting a provider', { retry: 0 }, () => {
  const dom = new JSDOM('<body><div id="root"></div></body>', { runScripts: 'outside-only' })
  onTestFinished(() => dom.window.close())
  dom.window.matchMedia = media => ({
    matches: false, media, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => true,
  })
  const api: WelcomeApi = {
    ...resolveDesktopLocale('en'),
    analyticsEnabled: async () => false,
    takeNotice: async () => undefined,
    startSignIn: async () => { throw new Error('Unexpected sign in') },
    cancelSignIn: async () => { throw new Error('Unexpected sign in cancellation') },
    copySignInLink: async () => { throw new Error('Unexpected sign in link') },
    saveApiKey: async () => { throw new Error('Unexpected credential write') },
    skip: async () => { throw new Error('Unexpected welcome action') },
    onAccountState: () => () => {},
  }
  Object.assign(dom.window, { dshWelcome: api })
  dom.window.eval(readFileSync(new URL('../lib/welcome/welcome.js', import.meta.url), 'utf8'))
  expect([...dom.window.document.querySelectorAll('button')].map(button => button.textContent))
    .toContain(api.messages.welcomeApiKey)
  expect(dom.window.document.getElementById('root')?.textContent).toContain(api.messages.welcomeSignIn)
  dom.window.dispatchEvent(new dom.window.Event('pagehide'))
})
