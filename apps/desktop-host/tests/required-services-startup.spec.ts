import { fork } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('withholds built Desktop Host ready and disposes a real profile after an optional provider fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-required-startup-'))
  const runtime = resolve(import.meta.dirname, '..')
  const disposed = join(root, 'disposed')
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
  await writeFile(join(root, 'observer.mjs'), `
    import { writeFileSync } from 'node:fs'
    export function apply(ctx) { ctx.effect(() => () => writeFileSync(${JSON.stringify(disposed)}, 'disposed')) }
  `)
  await writeFile(join(root, 'optional.mjs'), 'export function apply() { throw new Error("fixture optional provider failed") }')
  await writeFile(join(root, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'observer', name: pathToFileURL(join(root, 'observer.mjs')).href },
    { id: 'optional', name: pathToFileURL(join(root, 'optional.mjs')).href },
  ] }]))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:path|systemroot|windir|comspec|pathext)$/iu.test(name)))
  const child = fork(join(runtime, 'lib/index.js'), [runtime, root, join(root, 'unused-runtime'), '', '', '["fixtureRequired"]'], {
    cwd: root, env: { ...environment, DSH_HOME: root, HOME: root, USERPROFILE: root, DSH_TELEMETRY_MODE: 'DISABLED' },
    execArgv: ['--expose-internals'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const messages: { type?: string; message?: string }[] = []
  let output = ''
  child.on('message', (message) => { messages.push(message as { type?: string; message?: string }) })
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk) => { output += String(chunk) })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  const deadline = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
  try {
    expect(await closed, output).toEqual({ code: 1, signal: null })
    expect(output).toContain('fixture optional provider failed')
    expect(messages.some(message => message.type === 'ready')).toBe(false)
    expect(messages.find(message => message.type === 'fatal')?.message).toContain('fixtureRequired')
    expect(await readFile(disposed, 'utf8')).toBe('disposed')
  } finally {
    clearTimeout(deadline)
    child.kill('SIGKILL')
    await closed
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
