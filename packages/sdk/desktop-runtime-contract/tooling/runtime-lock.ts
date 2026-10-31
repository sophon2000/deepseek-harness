/** Select and preserve the exact production dependency lock used by one Desktop composition. */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Copy an explicitly supplied lock, or resolve one when the producer requests discovery.
 * The caller validates core identities and patch hashes before installation.
 * @param project - Disposable production installation directory.
 * @param supplied - Optional absolute path to an already qualified composition lock.
 * @param resolveLock - Resolution operation used only when no lock is supplied.
 * @returns Resolves after a lock exists; a failed copy or resolution prevents installation.
 */
export async function selectDesktopRuntimeLock(
  project: string,
  supplied: string | undefined,
  resolveLock: () => Promise<void>,
): Promise<void> {
  if (supplied === undefined) await resolveLock()
  else copyFileSync(supplied, join(project, 'pnpm-lock.yaml'))
}

/**
 * Preserve a validated composition lock before the disposable install directory is removed.
 * @param project - Production installation directory containing its validated lock.
 * @param output - Optional lock destination; omission retains the ordinary packaging behavior.
 */
export function preserveDesktopRuntimeLock(project: string, output: string | undefined): void {
  if (output === undefined) return
  mkdirSync(dirname(output), { recursive: true })
  copyFileSync(join(project, 'pnpm-lock.yaml'), output)
}
