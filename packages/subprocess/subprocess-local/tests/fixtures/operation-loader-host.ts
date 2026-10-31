/** Source-mode test application loading its subprocess provider through a private cordis.yml. */

import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { SubprocessOperationOwnerKey } from '@deepseek-ai/dsh-subprocess'

const [configPath, stateDirectory, resultPath] = process.argv.slice(2)
if (configPath === undefined || stateDirectory === undefined || resultPath === undefined) throw new Error('Missing fixture paths')
const ctx = new Context()
await ctx.plugin(Loader, { baseUrl: import.meta.url })
try {
  await ctx.plugin(Include, { path: pathToFileURL(configPath).href })
  await ctx.loader.await()
  const service = ctx.get('subprocess')
  if (service === undefined) throw new Error('Loader did not publish the subprocess service')
  const provider = service.operationProvider({ stateDirectory })
  const owner = 'loader-home/project/render/receipt' as SubprocessOperationOwnerKey
  const created = await provider.create(owner)
  if (created.kind !== 'created') throw new Error('Expected Windows operation support')
  const handle = created.scope.spawn({ argv: [process.execPath, '-e', 'console.log("loader-operation")'],
    cwd: process.cwd(), graceMs: 1000, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
  const outcome = await handle.done
  if (outcome.exitCode !== 0 || !await handle.waitForExit()) throw new Error('Loaded provider target failed')
  const result = await created.scope.seal()
  if (result.kind !== 'sealed-quiescent' || !provider.verify(result.proof, created.scope.descriptor, owner)) {
    throw new Error('Loaded provider did not verify native evidence')
  }
  writeFileSync(resultPath, JSON.stringify({ exitCode: outcome.exitCode,
    output: handle.collected.stdout?.readFrom(0).text.trim(), verified: true }), { flush: true })
} finally {
  await ctx.fiber.dispose()
}
