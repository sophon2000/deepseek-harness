// Keyless real Loader/browser composition. Test-only plugins use the public
// Slot + detailViews faces; native chat, approvals and replay stay unmodified.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, fixtureUserPrompts, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const PLUGIN = fileURLToPath(new URL('../../../packages/client/ui-layout/tests/fixtures/detail-views/', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/approval-composer/session.jsonl', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.jsonl', import.meta.url))

describe.skipIf(webSnapshotMode() === 'record')('web e2e: additive details views', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let installedProfile: string

  beforeAll(async () => {
    // Mirror a private profile dependency installed outside the monorepo.
    installedProfile = await mkdtemp(join(tmpdir(), 'dsh-detail-views-profile-'))
    await mkdir(join(installedProfile, 'node_modules', '@dsh-test'), { recursive: true })
    await symlink(PLUGIN, join(installedProfile, 'node_modules', '@dsh-test', 'detail-views'), 'junction')
    await writeFile(join(installedProfile, 'package.json'), JSON.stringify({
      name: '@dsh-test/detail-views-profile', private: true,
      dependencies: { '@dsh-test/detail-views': '0.0.0' },
    }))
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE, paceMs: 15, compareReplaySession: false,
      extraOverlayPath: join(PLUGIN, 'cordis.patch.yml'),
      extraInstallAnchors: [join(installedProfile, 'package.json')],
    })
    await seedSession(scaffold, await readFile(SEED, 'utf8'), 'detail-views-seed')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[style*="grid-template-columns"]').first().waitFor({ timeout: 30_000 })
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor()
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close(); await scaffold?.close() }
    finally { if (installedProfile !== undefined) await rm(installedProfile, { recursive: true, force: true }) }
  })

  it('preserves native chat and draft across desktop, compact, disposal and reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auxiliary-details'))
    const input = page.locator('[data-composer-input]').first()
    await input.fill('Keep this unsent draft')
    await page.getByRole('button', { name: 'Open workspace A', exact: true }).click()
    const view = page.locator('[data-fixture-view="Workspace A"]')
    await view.waitFor()
    // The layout animates grid tracks; wait for a usable column, not just mount.
    await expect.poll(async () => (await view.boundingBox())?.width).toBeGreaterThan(250)
    const bounds = await view.boundingBox()
    const chat = await input.boundingBox()
    expect(bounds?.width).toBeGreaterThan(250)
    expect(chat?.width).toBeGreaterThan(200)
    expect(bounds!.x).toBeGreaterThan(chat!.x + chat!.width)
    await page.getByRole('button', { name: 'Tool details', exact: true }).click()
    await page.getByText('Details', { exact: true }).waitFor()
    expect(await view.count()).toBe(0)
    await page.getByRole('button', { name: 'Workspace A', exact: true }).click()
    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    await page.getByRole('table').waitFor()
    expect(await view.isVisible()).toBe(true)
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    expect(await input.innerText()).toBe('Keep this unsent draft')
    await page.getByRole('button', { name: 'Workspace B', exact: true }).click()
    await page.locator('[data-fixture-view="Workspace B"]').waitFor()
    await page.getByRole('button', { name: 'Workspace A', exact: true }).click()
    await page.getByRole('button', { name: 'Remove workspace A', exact: true }).click()
    await expect.poll(() => page.locator('[data-fixture-view]').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Workspace B', exact: true }).isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Restore workspace A', exact: true }).click()
    await page.getByRole('button', { name: 'Workspace A', exact: true }).click()
    await view.waitFor()
    await page.getByRole('button', { name: 'Back to conversation', exact: true }).click()
    expect(await input.innerText()).toBe('Keep this unsent draft')

    await page.setViewportSize({ width: 480, height: 800 })
    const opener = page.getByRole('button', { name: 'Open workspace A', exact: true })
    await opener.focus()
    await opener.press('Enter')
    await expect.poll(() => page.locator('[data-details-compact]').count()).toBe(1)
    await expect.poll(async () => (await view.boundingBox())?.width).toBeGreaterThan(450)
    // Width can settle before the old sidebar track finishes collapsing.
    await expect.poll(async () => {
      const box = await view.boundingBox()
      return box === null ? Infinity : box.x + box.width
    }).toBeLessThanOrEqual(481)
    const compact = await view.boundingBox()
    expect(compact!.width).toBeGreaterThan(450)
    expect(compact!.x).toBeGreaterThanOrEqual(0)
    expect(compact!.x + compact!.width).toBeLessThanOrEqual(481)
    expect(await input.isVisible()).toBe(false)
    await page.getByRole('button', { name: 'Object action', exact: true }).press('Escape')
    await expect.poll(() => input.isVisible()).toBe(true)
    expect(await opener.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await input.innerText()).toBe('Keep this unsent draft')
    for (const width of [480, 1680]) {
      await page.setViewportSize({ width, height: 800 })
      await opener.focus()
      // Compact mode hides the opener; retain its node before leaving conversation.
      const control = await opener.elementHandle()
      if (control === null) throw new Error('workspace opener is missing')
      try {
        await opener.press('Enter')
        await view.waitFor()
        await control.evaluate((element) => { (element as HTMLButtonElement).disabled = true })
        await page.getByRole('button', { name: 'Object action', exact: true }).press('Escape')
        await expect.poll(() => input.evaluate(element =>
          document.activeElement !== document.body && document.activeElement?.contains(element),
        )).toBe(true)
        expect(await input.innerText()).toBe('Keep this unsent draft')
      } finally {
        await control.evaluate((element) => { (element as HTMLButtonElement).disabled = false })
        await control.dispose()
      }
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.getByRole('button', { name: 'Open workspace B', exact: true }).click()
    await page.locator('[data-fixture-view="Workspace B"]').waitFor()
    const warnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warnings)
    await page.getByRole('button', { name: 'Open workspace A', exact: true }).waitFor()
    expect(await page.locator('[data-fixture-view]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('keeps the native approval answer reachable and never answers it on view switching', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auxiliary-approval'))
    // Start from desktop even if the preceding compact assertion failed.
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^(?:New session|新.*会话)$/ }).last().click()
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor()
    await page.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    const [prompt] = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    if (prompt === undefined) throw new Error('approval fixture has no prompt')
    const settled = scaffold.whenTurnSettled(60_000)
    await input.fill(prompt)
    await input.press('Enter')
    const approval = page.locator('[data-approval-key]')
    await approval.waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Open workspace A', exact: true }).click()
    await page.locator('[data-fixture-view="Workspace A"]').waitFor()
    expect(await approval.isVisible()).toBe(true)
    await page.setViewportSize({ width: 480, height: 800 })
    await expect.poll(() => page.locator('[data-fixture-view]').count()).toBe(0)
    expect(await approval.isVisible()).toBe(true)
    const allow = approval.getByRole('button', { name: 'Allow once' })
    const box = await allow.boundingBox()
    expect(box!.y).toBeGreaterThan(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(800)
    await allow.click()
    await settled
    await page.getByText('DONE', { exact: true }).waitFor()
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'notes.txt'), 'utf8')).toContain('tok')
    expect(await approval.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
