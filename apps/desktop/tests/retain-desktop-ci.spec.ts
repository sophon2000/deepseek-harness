import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { desktopReleasesRoot, retainDesktopCi } from '../scripts/retain-desktop-ci.ts'
import { verifyRetainedDesktopRelease } from '../scripts/desktop-release-store.ts'
import { prepareDesktopPublication } from '../scripts/publish-desktop-ci.ts'

const roots: string[] = []
it('rejects Linux SDK targets before reading publication settings', async () => {
  await expect(retainDesktopCi({ DSH_DESKTOP_TARGET_PLATFORM: 'linux', DSH_DESKTOP_TARGET_ARCH: 'x64' }))
    .rejects.toThrow('Linux SDK builds do not support release publication')
})
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each([
  ['mac-arm64', 'notarized', false], ['win-x64', 'signed', false], ['mac-arm64', 'unnotarized', false], ['win-x64', 'unsigned', false],
  ['mac-arm64', 'notarized', true], ['win-x64', 'unsigned', true],
] as const)('retains the complete %s %s release with external build root=%s without signing or upload credentials', async (target, qualification, external) => {
  const root = await mkdtemp(join(tmpdir(), 'retain-ci-'))
  roots.push(root)
  const appRoot = join(root, 'checkout')
  const config = join(root, 'packaging')
  const debug = qualification === 'unsigned' || qualification === 'unnotarized'
  const buildRoot = external ? join(root, 'external-build') : join(appRoot, '.desktop-build')
  const artifacts = join(buildRoot, 'targets', target, debug ? `${qualification}-artifacts` : 'artifacts')
  await mkdir(artifacts, { recursive: true })
  await mkdir(join(config, 'presets'), { recursive: true })
  await mkdir(appRoot, { recursive: true })
  await writeFile(join(appRoot, 'package.json'), '{"version":"1.0.0"}')
  await writeFile(join(config, 'presets/test.env'), `DSH_DESKTOP_AUTO_UPDATE_ENV=test\nDOWNLOAD_TEST_RELEASE_ID=${'a'.repeat(32)}\n`)
  const names = debug ? (target === 'win-x64' ? [`deepseek-harness-1.0.0-win-x64-${qualification}.exe`]
    : [`deepseek-harness-1.0.0-mac-arm64-${qualification}.dmg`, `deepseek-harness-1.0.0-mac-arm64-${qualification}.zip`]) : target === 'win-x64'
    ? ['deepseek-harness-1.0.0-win-x64.exe', 'deepseek-harness-1.0.0-win-x64.exe.blockmap', 'win-x64-release.json', 'nightly.yml']
    : ['deepseek-harness-1.0.0-mac-arm64.dmg', 'deepseek-harness-1.0.0-mac-arm64.zip', 'deepseek-harness-1.0.0-mac-arm64.zip.blockmap', 'mac-arm64-release.json', 'nightly-mac.yml']
  await Promise.all(names.map(name => writeFile(join(artifacts, name), 'fixture')))
  const env = {
    ...(external ? { DSH_DESKTOP_BUILD_ROOT: buildRoot } : {}),
    DSH_PACKAGING_CONFIG_DIR: config, DSH_PACKAGING_PRESET: 'test', DSH_DESKTOP_TARGET_PLATFORM: target === 'win-x64' ? 'win32' : 'darwin',
    DSH_DESKTOP_TARGET_ARCH: target === 'win-x64' ? 'x64' : 'arm64', PACKAGE_SOURCE_REF: 'master', PACKAGE_SOURCE_SHA: 'b'.repeat(40), PACKAGE_VERSION: '1.0.0',
    PACKAGE_SIGNING: qualification === 'unsigned' ? 'unsigned' : 'signed', PACKAGE_SKIP_NOTARIZATION: qualification === 'unnotarized' ? 'true' : 'false', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
    GITHUB_REPOSITORY: 'owner/repository', GITHUB_SHA: 'b'.repeat(40), RUNNER_NAME: 'dedicated',
  }
  await retainDesktopCi(env, appRoot)
  const manifest = await verifyRetainedDesktopRelease(desktopReleasesRoot(env), '123', '2')
  expect(manifest.files.map(file => file.name)).toEqual(names)
  expect(manifest.source).toMatchObject({ target, qualification })
  expect(manifest.source.publishRequested).toBeUndefined()
  const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8')
  if (debug) {
    expect(summary).toContain('不能发布到 test 或 production')
    expect(summary).not.toContain('Publish separately')
    await expect(prepareDesktopPublication({ ...env, DESKTOP_PUBLISH_ROUTE: JSON.stringify({
      runId: '123', attempt: '2', commit: env.GITHUB_SHA, runnerName: env.RUNNER_NAME, target, preset: 'test', sourceRef: 'master', channel: 'nightly',
    }) })).rejects.toThrow('重跑当前发布任务无效')
    await expect(summary).toMatchFileSnapshot(`./expected/retained-${qualification}.md`)
  } else expect(summary).toContain('Publish separately with package_run_id=123 and package_run_attempt=2')
})
