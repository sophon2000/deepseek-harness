import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const run = promisify(execFile)
it.concurrent.each(['broken', 'live'])('enforces typed admission through an authenticated real Profile (%s)', async (scenario) => {
  const fixture = fileURLToPath(new URL('./fixtures/typed-admission/profile.mjs', import.meta.url))
  const { stdout } = await run(process.execPath, [fixture, scenario], { timeout: 45_000, maxBuffer: 1024 * 1024 })
  expect(stdout).toContain('TYPED_ADMISSION_PROFILE_OK')
}, 50_000)
