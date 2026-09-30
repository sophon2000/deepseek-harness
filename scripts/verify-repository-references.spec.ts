import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { findRepositoryReferences, forkArchiveManifestPath, scanRepositoryReferences } from './verify-repository-references.ts'

const organizationUrl = `https://${['github.com', ['deepseek', 'harness'].join('-')].join('/')}`
const forkArchiveManifestSource = readFileSync(resolve(import.meta.dirname, '..', forkArchiveManifestPath), 'utf8')

interface ForkSnapshot {
  upstream_rc2: string
  archive_candidates: { sha: string; remote_verified_sha: string; remote_tag_created: boolean }[]
  archive_candidates_count: number
  remote_refs: Record<string, string>
  archive_status: string
}

function forkSnapshot(): ForkSnapshot {
  return JSON.parse(forkArchiveManifestSource) as ForkSnapshot
}

function repository(test: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repository-references-'))
  test.onTestFinished(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  function git(args: string[], input?: string): string {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Repository reference test',
        GIT_AUTHOR_EMAIL: 'repository-reference@example.invalid',
        GIT_COMMITTER_NAME: 'Repository reference test',
        GIT_COMMITTER_EMAIL: 'repository-reference@example.invalid',
      },
      ...(input === undefined ? {} : { input }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  }
  function write(file: string, source: string): void {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  git(['init', '--quiet'])
  write('tracked.md', 'release tags\n')
  write(forkArchiveManifestPath, forkArchiveManifestSource)
  git(['add', 'tracked.md', forkArchiveManifestPath])
  const tree = git(['write-tree'])
  const commit = git(['commit-tree', tree, '-m', 'fixture'])
  git(['update-ref', 'HEAD', commit])
  return { root, git, write, commit, tree }
}

describe('maintained repository reference policy', () => {
  it('admits the original 14-candidate, 33-ref historical snapshot at its exact sealed path', (test) => {
    const snapshot = forkSnapshot()
    expect(snapshot.archive_candidates).toHaveLength(14)
    expect(snapshot.archive_candidates_count).toBe(14)
    expect(Object.keys(snapshot.remote_refs)).toHaveLength(33)
    expect(snapshot.archive_candidates.every(candidate => candidate.sha === candidate.remote_verified_sha)).toBe(true)
    expect(findRepositoryReferences(forkArchiveManifestPath, forkArchiveManifestSource, new Set([snapshot.upstream_rc2])))
      .toEqual([])
    expect(scanRepositoryReferences(repository(test).root)).toEqual([])
  })

  it.for([
    ['missing candidate', (snapshot: ForkSnapshot) => { snapshot.archive_candidates.pop() }],
    ['changed candidate SHA', (snapshot: ForkSnapshot) => { snapshot.archive_candidates[0]!.sha = '0'.repeat(40) }],
    ['changed verification SHA', (snapshot: ForkSnapshot) => { snapshot.archive_candidates[0]!.remote_verified_sha = '0'.repeat(40) }],
    ['changed tag status', (snapshot: ForkSnapshot) => { snapshot.archive_candidates[0]!.remote_tag_created = true }],
    ['changed candidate count', (snapshot: ForkSnapshot) => { snapshot.archive_candidates_count = 13 }],
    ['missing remote ref', (snapshot: ForkSnapshot) => { snapshot.remote_refs = Object.fromEntries(Object.entries(snapshot.remote_refs).slice(1)) }],
    ['changed remote ref', (snapshot: ForkSnapshot) => { snapshot.remote_refs[Object.keys(snapshot.remote_refs)[0]!] = '0'.repeat(40) }],
    ['changed historical status', (snapshot: ForkSnapshot) => { snapshot.archive_status = 'complete' }],
  ] as const)('rejects snapshot corruption without needing the historical Git objects: %s', ([_name, mutate], test) => {
    const fixture = repository(test)
    const snapshot = forkSnapshot()
    mutate(snapshot)
    fixture.write(forkArchiveManifestPath, `${JSON.stringify(snapshot, null, 2)}\n`)
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: forkArchiveManifestPath, line: 1, kind: 'historical-manifest-integrity' },
    ])
  })

  it.each(['', '{}\n', '{invalid\n', `${forkArchiveManifestSource}\n`, `${forkArchiveManifestSource}\nextra content\n`])(
    'rejects empty, malformed, replaced, or appended snapshot bytes', (source) => {
      expect(findRepositoryReferences(forkArchiveManifestPath, source, new Set())).toContainEqual(
        { file: forkArchiveManifestPath, line: 1, kind: 'historical-manifest-integrity' },
      )
    },
  )

  it('rejects a deleted snapshot even though ordinary deleted files are skipped', (test) => {
    const fixture = repository(test)
    unlinkSync(join(fixture.root, forkArchiveManifestPath))
    fixture.git(['rm', '--cached', forkArchiveManifestPath])
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: forkArchiveManifestPath, line: 1, kind: 'historical-manifest-integrity' },
    ])
  })

  it('does not exempt adjacent files, copied evidence, or the former snapshot path', () => {
    const commits = new Set([forkSnapshot().upstream_rc2])
    for (const file of ['docs/fork-archive-manifest.json', `${forkArchiveManifestPath}.copy`, 'docs/history/other.json', 'docs/history/current.md']) {
      expect(findRepositoryReferences(file, forkArchiveManifestSource, commits)).toContainEqual(
        { file, line: 6, kind: 'commit-hash' },
      )
    }
  })

  it('revokes the commit exception after alteration and retains organization URL checking', (test) => {
    const fixture = repository(test)
    fixture.write(forkArchiveManifestPath, `${forkArchiveManifestSource}${fixture.commit}\n${organizationUrl}\n`)
    expect(scanRepositoryReferences(fixture.root)).toEqual(expect.arrayContaining([
      { file: forkArchiveManifestPath, line: 1, kind: 'historical-manifest-integrity' },
      { file: forkArchiveManifestPath, line: 149, kind: 'organization-url' },
      { file: forkArchiveManifestPath, line: 148, kind: 'commit-hash' },
    ]))
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink replacing the snapshot with an identical external file', (test) => {
    const fixture = repository(test)
    fixture.write('outside.json', forkArchiveManifestSource)
    unlinkSync(join(fixture.root, forkArchiveManifestPath))
    symlinkSync(join(fixture.root, 'outside.json'), join(fixture.root, forkArchiveManifestPath))
    expect(scanRepositoryReferences(fixture.root)).toContainEqual(
      { file: forkArchiveManifestPath, line: 1, kind: 'historical-manifest-integrity' },
    )
  })

  it('permits only the independent kit repository and its source URLs', () => {
    for (const suffix of ['', '.git', '/tree/main/packages/entry']) {
      expect(findRepositoryReferences('package.json', `${organizationUrl}/libreoffice-kit${suffix}`, new Set())).toEqual([])
    }
    for (const suffix of ['-other', '.example', 's']) {
      expect(findRepositoryReferences('package.json', `${organizationUrl}/libreoffice-kit${suffix}`, new Set())).toHaveLength(1)
    }
  })

  it('rejects complete and abbreviated commit identifiers in tracked, staged, and new files', (test) => {
    const fixture = repository(test)
    fixture.write('tracked.md', `release\n${fixture.commit}\n${fixture.commit.toUpperCase()}\n`)
    fixture.write('staged.md', fixture.commit.slice(0, 7))
    fixture.git(['add', 'staged.md'])
    fixture.write('new.md', `\0${fixture.commit.slice(0, 12)}`)

    expect(scanRepositoryReferences(fixture.root)).toEqual(expect.arrayContaining([
      { file: 'tracked.md', line: 2, kind: 'commit-hash' },
      { file: 'tracked.md', line: 3, kind: 'commit-hash' },
      { file: 'staged.md', line: 1, kind: 'commit-hash' },
      { file: 'new.md', line: 1, kind: 'commit-hash' },
    ]))
    expect(scanRepositoryReferences(fixture.root)).toHaveLength(4)
  })

  it('checks available unreachable commits without requiring a branch or network', (test) => {
    const fixture = repository(test)
    const unreachable = fixture.git(['commit-tree', fixture.tree, '-m', 'unreachable fixture'])
    fixture.write('unreachable.md', unreachable)
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: 'unreachable.md', line: 1, kind: 'commit-hash' },
    ])
  })

  it('does not fetch missing commits from a partial clone\'s promisor remote', (test) => {
    const remote = repository(test)
    remote.git(['config', 'uploadpack.allowFilter', 'true'])
    const clone = join(remote.root, 'partial-clone')
    remote.git(['clone', '--filter=blob:none', '--no-local', remote.root, clone])
    const missing = remote.git(['commit-tree', remote.tree, '-p', remote.commit, '-m', 'remote-only fixture'])
    remote.git(['update-ref', 'HEAD', missing])
    remote.write('partial-clone/new.md', missing)

    expect(scanRepositoryReferences(clone)).toEqual([])
    expect(execFileSync('git', ['cat-file', '--batch-check'], {
      cwd: clone,
      encoding: 'utf8',
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      input: `${missing}\n`,
    }).trim()).toBe(`${missing} missing`)
  })

  it('accepts blobs, trees, unknown hex, long digests, and identifiers embedded in alphanumeric words', (test) => {
    const fixture = repository(test)
    const blob = fixture.git(['hash-object', '-w', '--stdin'], 'blob fixture')
    fixture.write('accepted.md', [
      blob,
      fixture.tree,
      '0'.repeat(40),
      `${fixture.commit}${'0'.repeat(24)}`,
      fixture.commit.slice(0, 6),
      `prefix${fixture.commit}`,
      `${fixture.commit}suffix`,
      'dsh-v0.0.1-rc.1',
    ].join('\n'))
    expect(scanRepositoryReferences(fixture.root)).toEqual([])
  })

  it('accepts hexadecimal branch names that do not match the referenced commit identifier', (test) => {
    const fixture = repository(test)
    const branch = 'b'.repeat(12)
    fixture.git(['update-ref', `refs/heads/${branch}`, fixture.commit])
    fixture.write('branch.md', branch)
    expect(scanRepositoryReferences(fixture.root)).toEqual([])
  })

  it('excludes only ignored new files, vendored sources, frozen notes, and deleted files', (test) => {
    const fixture = repository(test)
    fixture.write('.gitignore', 'ignored.md\ntracked-ignore.md\n')
    fixture.write('ignored.md', fixture.commit)
    fixture.write('vendor/project/file.md', `${fixture.commit}\n${organizationUrl}`)
    fixture.write('.agents/notes/archived/process/frozen.md', `${fixture.commit}\n${organizationUrl}`)
    fixture.write('tracked-ignore.md', fixture.commit)
    fixture.git(['add', '--force', 'tracked-ignore.md'])
    unlinkSync(join(fixture.root, 'tracked.md'))

    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: 'tracked-ignore.md', line: 1, kind: 'commit-hash' },
    ])
  })

  it.skipIf(process.platform === 'win32')('inspects dangling symlink targets without following files outside the tree', (test) => {
    const fixture = repository(test)
    symlinkSync(`../${fixture.commit}`, join(fixture.root, 'reference-link'))
    symlinkSync('../outside', join(fixture.root, 'ordinary-link'))
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: 'reference-link', line: 1, kind: 'commit-hash' },
    ])
  })

  it('rejects literal, encoded, escaped, case-varied, and compatibility forms of the organization URL', () => {
    const fullwidth = organizationUrl.split('').map(character =>
      String.fromCodePoint(character.charCodeAt(0) + 0xfee0)).join('')
    const source = [
      organizationUrl,
      `${organizationUrl.toUpperCase()}/project`,
      organizationUrl.replaceAll('/', '\\/'),
      organizationUrl.replaceAll('/', String.raw`\u002f`),
      organizationUrl.replaceAll('/', String.raw`\x2f`),
      organizationUrl.replaceAll('/', '%2F').replace('github', '%67ithub'),
      organizationUrl.replaceAll('/', '&#47;'),
      organizationUrl.replaceAll('/', '&#x2f;'),
      organizationUrl.replaceAll('/', '&sol;').replaceAll('-', '&hyphen;'),
      fullwidth,
      `${organizationUrl}?tab=repositories`,
    ].join('\n')
    expect(findRepositoryReferences('source.md', source, new Set())).toEqual(
      source.split('\n').map((_line, index) => ({ file: 'source.md', line: index + 1, kind: 'organization-url' })),
    )
  })

  it('accepts distinct organization names and excludes the frozen and vendored paths', () => {
    expect(findRepositoryReferences('source.md', `${organizationUrl}-tools/project`, new Set())).toEqual([])
    expect(findRepositoryReferences('vendor/project/source.md', organizationUrl, new Set())).toEqual([])
    expect(findRepositoryReferences('.agents/notes/archived/process/frozen.md', organizationUrl, new Set())).toEqual([])
    expect(findRepositoryReferences('.agents/notes/implemented/process/current.md', organizationUrl, new Set()))
      .toEqual([{ file: '.agents/notes/implemented/process/current.md', line: 1, kind: 'organization-url' }])
  })
})
