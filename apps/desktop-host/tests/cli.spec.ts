import { delimiter, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'
import { runDesktopCli } from '../src/cli.ts'

vi.mock('@deepseek-ai/dsh/lib/bin.js', () => ({ runCli: vi.fn(async () => {}) }))

it('runs the CLI with physical sibling runtime support and Desktop profile access', async () => {
  await runDesktopCli(join('/installed', 'resources', 'dsh'))
  expect(runCli).toHaveBeenCalledWith({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join('/installed', 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join('/installed', 'resources', 'runtime', 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
    },
  })
})
