import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { list } from 'tar'
import { archiveDesktopSdk } from '../scripts/archive-desktop-sdk.mjs'

test('SDK archiving preserves relative links, pins bytes and refuses overwrites or input aliases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sdk = join(root, 'sdk'), output = join(root, 'sdk.tgz')
  await mkdir(join(sdk, 'packages'), { recursive: true })
  await writeFile(join(sdk, 'dsh-desktop-sdk.json'), JSON.stringify({ schemaVersion: 'dsh.desktop-sdk/2' }))
  await writeFile(join(sdk, 'packages/value.js'), 'export const value = 7')
  await symlink('packages', join(sdk, 'modules'), 'dir')
  const receipt = await archiveDesktopSdk(sdk, output)
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/u)
  assert.equal(receipt.bytes, (await readFile(output)).length)
  const entries = []
  await list({ file: output, onReadEntry: entry => entries.push({ path: entry.path, type: entry.type, link: entry.linkpath }) })
  assert.deepEqual(entries.find(entry => entry.path === './modules'), { path: './modules', type: 'SymbolicLink', link: 'packages' })
  assert.equal(entries.some(entry => entry.path.startsWith('./modules/')), false)
  await assert.rejects(archiveDesktopSdk(sdk, output), { code: 'EEXIST' })
  await assert.rejects(archiveDesktopSdk(sdk, join(sdk, 'inside.tgz')), /outside/u)
  await symlink('sdk', join(root, 'alias'), 'dir')
  await assert.rejects(archiveDesktopSdk(sdk, join(root, 'alias/inside.tgz')), /outside/u)
  assert.equal((await readdir(root)).some(name => name.startsWith('.sdk-archive-')), false)
})
