/** Materialize product resource links as physical files before sealing the signed runtime. */
import { constants, copyFileSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

/**
 * Copy a product resource tree without symlinks, rejecting escaping links and directory cycles.
 * All entries are validated before destination writes; copy failures leave a partial destination for caller cleanup.
 * @param source - Immutable, validated product resources directory.
 * @param destination - New directory inside the prepared DSH runtime.
 */
export function materializeDesktopProductResources(source: string, destination: string): void {
  const root = realpathSync(source)
  const directories: string[] = []
  const files: { source: string; relative: string }[] = []
  function visit(directory: string, local: string, ancestors: ReadonlySet<string>): void {
    const resolved = realpathSync(directory)
    if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error(`desktop product: resource link escapes payload: ${local}`)
    if (ancestors.has(resolved)) throw new Error(`desktop product: resource directory cycle: ${local}`)
    directories.push(local)
    const active = new Set([...ancestors, resolved])
    for (const entry of readdirSync(resolved, { withFileTypes: true })) {
      const path = join(resolved, entry.name)
      const name = join(local, entry.name)
      const target = realpathSync(path)
      if (target !== root && !target.startsWith(root + sep)) throw new Error(`desktop product: resource link escapes payload: ${name}`)
      const metadata = statSync(target)
      if (metadata.isDirectory()) visit(target, name, active)
      else if (metadata.isFile()) files.push({ source: target, relative: name })
      else throw new Error(`desktop product: unsupported resource entry: ${name}`)
    }
  }
  visit(root, '', new Set())
  for (const directory of directories) mkdirSync(join(destination, directory), { recursive: true })
  for (const file of files) copyFileSync(file.source, join(destination, file.relative), constants.COPYFILE_FICLONE)
}
