/** Native public-factory smoke through built exports and plain-Node consumer processes. */

import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { list } from 'tar'
import { describe, expect, it } from 'vitest'
import { pnpmCommand } from '../../../../scripts/release/process.ts'

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const invocation = [
  fileURLToPath(new URL('../verify/operation-artifact.mjs', import.meta.url)),
  '--consumer-root', packageRoot, '--mode', 'built',
]

it('packs every emitted subprocess runtime entry and shared chunk', { timeout: 120_000, retry: 0 }, async () => {
  const destination = mkdtempSync(join(tmpdir(), 'dsh-operation-pack-'))
  try {
    const runtime = readdirSync(join(packageRoot, 'lib')).filter(name => name.endsWith('.js'))
    expect(runtime).toContain('index.js')
    expect(runtime).toContain('runner.js')
    const [command, ...prefix] = pnpmCommand()
    await execute(command, [...prefix, '--dir', packageRoot, 'pack', '--pack-destination', destination], {
      windowsHide: true, maxBuffer: 2_000_000,
    })
    const archives = readdirSync(destination).filter(name => name.endsWith('.tgz'))
    expect(archives).toHaveLength(1)
    const members = new Set<string>()
    await list({ file: join(destination, archives[0]!), onReadEntry: (entry) => { members.add(entry.path) } })
    for (const filename of runtime) expect(members.has(`package/lib/${filename}`), `Packed runtime omitted ${filename}`).toBe(true)
  } finally {
    rmSync(destination, { recursive: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe.skipIf(process.platform !== 'win32')('Windows operation package artifacts', () => {
  it('runs two independent installed-style consumers through durable native admission', { timeout: 120_000, retry: 0 }, async () => {
    const { stdout } = await execute(process.execPath, invocation, { windowsHide: true, maxBuffer: 2_000_000 })
    const report = JSON.parse(stdout) as { mode: string; consumers: Array<{ verified: boolean; durableRunnerRejection: boolean }> }
    expect(report.mode).toBe('built')
    expect(report.consumers).toHaveLength(2)
    for (const consumer of report.consumers) {
      expect(consumer.verified).toBe(true)
      expect(consumer.durableRunnerRejection).toBe(true)
    }
  })

  it('joins both native ranges when both consumer Hosts are forcibly interrupted', { timeout: 120_000, retry: 0 }, async () => {
    const failure = await execute(process.execPath, [...invocation, '--interrupt-consumers'], {
      windowsHide: true, maxBuffer: 2_000_000,
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 1, killed: false, signal: null })
    const stderr = typeof failure === 'object' && failure !== null && 'stderr' in failure ? failure.stderr : undefined
    expect(stderr).toContain('"cleanupJobsJoined":2')
    expect(stderr).toContain('Intentional interruption with both owned descendants alive')
  })
})
