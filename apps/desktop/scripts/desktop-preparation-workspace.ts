/** Keep each runtime installation private while optionally retaining its pnpm content store. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopTargetBuildPaths } from './desktop-build-paths.mjs'

/** A unique install directory whose cleanup never removes a configured persistent store. */
export interface DesktopPreparationWorkspace {
  readonly directory: string
  readonly store: string
  /** Remove this installation and its default temporary store. */
  cleanup(): void
}

/**
 * Allocate one install directory after the build and cache paths have been validated.
 * @param paths Resolved target paths, including an optional persistent pnpm store.
 * @returns Private installation paths and their idempotent cleanup operation.
 */
export function createDesktopPreparationWorkspace(paths: DesktopTargetBuildPaths): DesktopPreparationWorkspace {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
  return {
    directory,
    store: paths.pnpmStore ?? join(directory, 'store'),
    cleanup: () => { rmSync(directory, { recursive: true, force: true }) },
  }
}
