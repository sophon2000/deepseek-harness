/** Reject maintained references to repository commits and the disallowed organization URL. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalReferenceText } from './verify-public-repository-links.ts'

const root = resolve(import.meta.dirname, '..')
const organization = ['deepseek', 'harness'].join('-')
const organizationUrl = new RegExp(`\\bgithub\\.com/${organization}(?![a-z0-9-])`)
// The independent kit repository owns the engine source and documentation.
const kitRepositoryUrl = new RegExp(`\\bgithub\\.com/${organization}/libreoffice-kit(?:\\.git)?(?=/|[^a-zA-Z0-9_.-]|$)`, 'g')
const commitCandidate = /(?<![a-z0-9])[\da-f]{7,40}(?![a-z0-9])/gi
const excludedPrefixes = ['vendor/', '.agents/notes/archived/']
/** The sole immutable fork-ref snapshot allowed to retain historical commit identifiers. */
export const forkArchiveManifestPath = 'docs/history/2026-09-30-fork-archive-manifest.json'
// Seal the original bytes, including all candidates, captured refs, and historical status.
// A later snapshot requires explicit policy review; never refresh this historical seal.
const forkArchiveManifestHash = '1e82755ac2e7352ff905e483c1a4b4a48c33bd92f82e5dd8acb6baaa9c254c2f'
const gitOutputLimit = 64 * 1024 * 1024

/** One reference-policy or immutable historical-evidence violation. */
export interface RepositoryReference {
  /** Repository-relative path, with forward slashes. */
  file: string
  /** One-based source line containing the reference. */
  line: number
  /** Prohibited reference type, or a missing/changed historical snapshot. */
  kind: 'commit-hash' | 'organization-url' | 'historical-manifest-integrity'
}

function isMaintained(file: string): boolean {
  return !excludedPrefixes.some(prefix => file.startsWith(prefix))
}

/**
 * Inspect a maintained source file against known commit identifiers.
 * @param file - Repository-relative path used in diagnostics and exclusions.
 * @param source - File text or a symlink's stored target.
 * @param commits - Lowercase, unambiguous full or abbreviated commit identifiers.
 * @returns Reference findings and snapshot-integrity failures; only the sealed fork snapshot permits commits.
 */
export function findRepositoryReferences(
  file: string,
  source: string,
  commits: ReadonlySet<string>,
): RepositoryReference[] {
  if (!isMaintained(file)) return []
  const references: RepositoryReference[] = []
  const historicalManifest = file === forkArchiveManifestPath
  const sealedManifest = historicalManifest
    && createHash('sha256').update(source).digest('hex') === forkArchiveManifestHash
  if (historicalManifest && !sealedManifest) {
    references.push({ file, line: 1, kind: 'historical-manifest-integrity' })
  }
  for (const [index, line] of source.split('\n').entries()) {
    if (organizationUrl.test(canonicalReferenceText(line).replace(kitRepositoryUrl, ''))) {
      references.push({ file, line: index + 1, kind: 'organization-url' })
    }
    if (!sealedManifest && [...line.matchAll(commitCandidate)].some(match => commits.has(match[0].toLowerCase()))) {
      references.push({ file, line: index + 1, kind: 'commit-hash' })
    }
  }
  return references
}

function readMaintainedFiles(repoRoot: string): Map<string, string> {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: gitOutputLimit,
  }).split('\0').filter(file => file !== '' && isMaintained(file))
  const sources = new Map<string, string>()
  for (const file of files) {
    const path = resolve(repoRoot, file)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink() === true) sources.set(file, readlinkSync(path))
    else if (stat?.isFile() === true) sources.set(file, readFileSync(path, 'utf8'))
  }
  return sources
}

function repositoryCommits(repoRoot: string, sources: Iterable<string>): Set<string> {
  const candidates = [...new Set([...sources].flatMap(source =>
    [...source.matchAll(commitCandidate)].map(match => match[0].toLowerCase())))]
  if (candidates.length === 0) return new Set()
  const results = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: repoRoot,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    encoding: 'utf8',
    input: `${candidates.join('\n')}\n`,
    maxBuffer: gitOutputLimit,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd().split('\n')
  // Git resolves prefixes across all available objects, including unreachable ones.
  // Ambiguous prefixes do not identify one object and cannot establish a commit reference.
  return new Set(candidates.filter((candidate, index) => {
    const [object, type] = results[index]?.split(' ') ?? []
    return type === 'commit' && object?.startsWith(candidate) === true
  }))
}

/**
 * Scan tracked and nonignored new files using only the local Git object database.
 * @param repoRoot - Working tree whose files and Git objects are inspected.
 * @returns Policy findings, including missing/changed sealed evidence; absent shallow-history commits cannot match.
 */
export function scanRepositoryReferences(repoRoot: string): RepositoryReference[] {
  const sources = readMaintainedFiles(repoRoot)
  const commits = repositoryCommits(repoRoot, sources.values())
  const references = [...sources].flatMap(([file, source]) => findRepositoryReferences(file, source, commits))
  if (!sources.has(forkArchiveManifestPath)) {
    references.push({ file: forkArchiveManifestPath, line: 1, kind: 'historical-manifest-integrity' })
  }
  return references
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const references = scanRepositoryReferences(root)
  if (references.length === 0) {
    console.log('verify-repository-references: historical fork evidence is intact; maintained references satisfy policy.')
  } else {
    console.error('verify-repository-references: preserve the sealed fork snapshot; elsewhere use release tags or maintained repository links:')
    for (const { file, line, kind } of references) console.error(`  ${file}:${String(line)} ${kind}`)
    process.exitCode = 1
  }
}
