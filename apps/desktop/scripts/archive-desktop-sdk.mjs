/** Archive one completed Runtime SDK without platform tar traversal of dependency links. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { create } from 'tar'

/**
 * Archive a completed SDK while preserving relative dependency links.
 * @param {string} input - Completed SDK directory.
 * @param {string} destination - New archive in an existing output directory.
 * @returns {Promise<{ file: string, sha256: string, bytes: number, source: unknown, target: unknown }>} Published archive identity.
 */
export async function archiveDesktopSdk(input, destination) {
  const sdk = await realpath(input)
  const output = join(await realpath(dirname(resolve(destination))), basename(destination))
  const local = relative(sdk, output)
  if (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) throw new Error('SDK archive must be outside its input directory')
  const manifest = JSON.parse(await readFile(join(sdk, 'dsh-desktop-sdk.json'), 'utf8'))
  if (manifest.schemaVersion !== 'dsh.desktop-sdk/2') throw new Error('A completed Runtime SDK v2 is required')
  const temporary = await mkdtemp(join(dirname(output), '.sdk-archive-'))
  try {
    const file = join(temporary, 'sdk.tgz')
    await create({ file, cwd: sdk, gzip: { level: 6 }, portable: true, mtime: new Date(0) }, ['.'])
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(file)) hash.update(bytes)
    await link(file, output)
    return { file: output, sha256: hash.digest('hex'), bytes: (await stat(output)).size, source: manifest.source, target: manifest.target }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { sdk: { type: 'string' }, output: { type: 'string' } } })
  if (!values.sdk || !values.output) throw new Error('Usage: archive-desktop-sdk.mjs --sdk <completed-sdk> --output <new-archive.tgz>')
  console.log(JSON.stringify(await archiveDesktopSdk(values.sdk, values.output)))
}
