/**
 * End-to-end runner tests: spawn the REAL runner entry through tsx (exactly
 * the argv shape dsh-sandbox-local's confine() builds), with piped stdio
 * inherited through the runner into the confined child — the same chain a
 * production confined execution walks.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { COVERAGE_TEST_TIMEOUT_ENV, parseCoverageTestTimeout } from '../../../../scripts/coverage-partitions.ts'
import { AclWriteGrant, tempWriteSid, workspaceWriteSid } from '../src/index.ts'

const isWin32 = process.platform === 'win32'
const runnerEntry = fileURLToPath(new URL('../src/runner.ts', import.meta.url))
// These multi-process probes retain their local budget but use CI's validated lane budget.
const nativeProbeTimeout = parseCoverageTestTimeout(process.env[COVERAGE_TEST_TIMEOUT_ENV]) ?? 60_000

// Functional probe, not where.exe: spawnSync never throws on a missing
// binary (status null) and where.exe exits 1 without pwsh — only an actual
// pwsh invocation's exit status is truth.
function pwshAvailable(): boolean {
  return spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0
}

function runRunner(args: string[], timeoutMs = 30_000) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', runnerEntry, ...args], {
    timeout: timeoutMs,
    encoding: 'utf8',
  })
}

describe.skipIf(!isWin32 || !pwshAvailable())('windows-acl runner', () => {
  let scratchRoot!: string
  let writableDir!: string
  let isolatedTemp!: string
  let secretFile!: string
  let escapeFile!: string
  let worldWritableDir!: string
  // The ambient-writable probe target: a subdirectory of C:\Users\Public.
  // INTERACTIVE/LOCAL are absent from BOTH restricting lists, so the Public
  // tree's INTERACTIVE grant must NOT satisfy the write check — the ambient
  // boundary the dual-list design closes (bot-reported blind spot). The
  // Public tree may be unavailable or unwritable for the test user on some
  // hosts; the probe test skips itself when the directory cannot be created.
  let publicProbeDir: string | undefined

  beforeAll(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'dsh-acl-runner-'))
    writableDir = join(scratchRoot, 'writable')
    mkdirSync(writableDir)
    isolatedTemp = mkdtempSync(join(tmpdir(), 'dsh-acl-runner-temp-'))
    secretFile = join(scratchRoot, 'secret.txt')
    writeFileSync(secretFile, 'top secret - must stay readable to prove the read boundary')
    escapeFile = join(scratchRoot, 'escaped.txt')
    worldWritableDir = join(scratchRoot, 'world-writable')
    mkdirSync(worldWritableDir)
    const worldGrant = spawnSync('icacls', [worldWritableDir, '/grant', '*S-1-1-0:(OI)(CI)(M)'], { encoding: 'utf8' })
    if (worldGrant.status !== 0) {
      throw new Error(`icacls Everyone grant failed: ${worldGrant.stdout}\n${worldGrant.stderr}`)
    }
    try {
      publicProbeDir = mkdtempSync(join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'dsh-acl-public-'))
    } catch {
      publicProbeDir = undefined
    }
  })

  afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true })
    rmSync(isolatedTemp, { recursive: true, force: true })
    if (publicProbeDir !== undefined) rmSync(publicProbeDir, { recursive: true, force: true })
  })

  it('workspace-write: the confined child writes granted directories only', () => {
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      // The private-temp capability lets PowerShell complete its startup
      // AppLocker probe, so workspace-write stays in FullLanguage. Read-only
      // cannot create those scratch files and fails that probe closed to
      // ConstrainedLanguage (pinned below).
      '\'LANGMODE: \' + $ExecutionContext.SessionState.LanguageMode;',
      `try{Set-Content -Path '${writableDir}\\child-wrote.txt' -Value ok -ErrorAction Stop;'TARGET-WRITE: OK'}catch{'TARGET-WRITE: DENIED'};`,
      "try{Set-Content -Path (Join-Path $env:TEMP 'child-wrote.txt') -Value ok -ErrorAction Stop;'TEMP-WRITE: OK'}catch{'TEMP-WRITE: DENIED'};",
      `try{Set-Content -Path '${escapeFile}' -Value ok -ErrorAction Stop;'ESCAPE-WRITE: OK (ESCAPE!)'}catch{'ESCAPE-WRITE: DENIED'};`,
      `try{Get-Content '${secretFile}' -ErrorAction Stop | Out-Null;'SECRET-READ: OK'}catch{'SECRET-READ: DENIED'};`,
      // Authenticated Users is absent from BOTH lists: the WMI namespace
      // security check fails (0x80041003) — CIM is unavailable under every
      // confined mode (the documented contract; the C:\-root tree-creation
      // escape is closed in both as the other side of the trade).
      "try{Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Out-Null;'CIM: OK'}catch{'CIM: DENIED'}",
    ].join('')
    const result = runRunner([
      '--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'workspace-write',
      '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
    ])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('LANGMODE: FullLanguage')
    expect(result.stdout).toContain('TARGET-WRITE: OK')
    expect(result.stdout).toContain('TEMP-WRITE: OK')
    expect(result.stdout).toContain('ESCAPE-WRITE: DENIED')
    expect(result.stdout).toContain('SECRET-READ: OK')
    expect(result.stdout).toContain('CIM: DENIED')
    expect(existsSync(escapeFile)).toBe(false)
    expect(existsSync(join(writableDir, 'child-wrote.txt'))).toBe(true)
  }, 30_000)

  it('read-only: no write-SID grants — workspace/temp writes denied, reads and $null redirection fine, CIM unavailable', () => {
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      '\'LANGMODE: \' + $ExecutionContext.SessionState.LanguageMode;',
      `try{Set-Content -Path '${writableDir}\\readonly-child-wrote.txt' -Value ok -ErrorAction Stop;'TARGET-WRITE: OK'}catch{'TARGET-WRITE: DENIED'};`,
      `try{Set-Content -Path '${isolatedTemp}\\readonly-child-wrote.txt' -Value ok -ErrorAction Stop;'TEMP-WRITE: OK'}catch{'TEMP-WRITE: DENIED'};`,
      // Set-Content NUL fails at the PowerShell/.NET layer even though the
      // device DACL's Everyone rights remain an ambient backend boundary.
      'try{Set-Content -Path \'NUL\' -Value ok -ErrorAction Stop;\'NUL-WRITE: OK\'}catch{\'NUL-WRITE: DENIED\'};',
      // PowerShell's $null redirection discards without opening NUL — must keep working.
      'echo hi > $null;\'DOLLAR-NULL: OK\';',
      `try{Get-Content '${secretFile}' -ErrorAction Stop | Out-Null;'SECRET-READ: OK'}catch{'SECRET-READ: DENIED'};`,
      // BOTH lists drop Authenticated Users: the WMI namespace security
      // check fails (0x80041003) — the documented CIM boundary of every
      // confined mode, the price of the zero ambient-write surface.
      "try{Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Out-Null;'CIM: OK'}catch{'CIM: DENIED'}",
    ].join('')
    const result = runRunner([
      '--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'read-only',
      '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
    ])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('LANGMODE: ConstrainedLanguage')
    expect(result.stdout).toContain('TARGET-WRITE: DENIED')
    expect(result.stdout).toContain('TEMP-WRITE: DENIED')
    expect(result.stdout).toContain('NUL-WRITE: DENIED')
    expect(result.stdout).toContain('DOLLAR-NULL: OK')
    expect(result.stdout).toContain('SECRET-READ: OK')
    expect(result.stdout).toContain('CIM: DENIED')
    expect(existsSync(join(writableDir, 'readonly-child-wrote.txt'))).toBe(false)
  }, 30_000)

  it('workspace-write: Remove-Item and Rename-Item succeed in the granted workspace (DELETE + FILE_DELETE_CHILD)', () => {
    // Deleting a file and renaming a directory both hit the second access
    // check on the workspace itself: the grant must carry DELETE (on the
    // object) and FILE_DELETE_CHILD (on its parent).
    const victimFile = join(writableDir, 'delete-me.txt')
    writeFileSync(victimFile, 'remove me')
    const victimDir = join(writableDir, 'rename-me')
    mkdirSync(victimDir)
    const renamedDir = join(writableDir, 'renamed-by-child')
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      `try{Remove-Item -LiteralPath '${victimFile}' -ErrorAction Stop;'DELETE-FILE: OK'}catch{'DELETE-FILE: DENIED'};`,
      `try{Rename-Item -LiteralPath '${victimDir}' -NewName 'renamed-by-child' -ErrorAction Stop;'RENAME-DIR: OK'}catch{'RENAME-DIR: DENIED'}`,
    ].join('')
    const result = runRunner([
      '--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'workspace-write',
      '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
    ])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('DELETE-FILE: OK')
    expect(result.stdout).toContain('RENAME-DIR: OK')
    expect(existsSync(victimFile)).toBe(false)
    expect(existsSync(renamedDir)).toBe(true)
  }, 30_000)

  it('paired SIDs: the runner trusts caller-owned private-temp grants and materializes nothing itself', () => {
    const seamWorkspace = join(scratchRoot, 'seam-workspace')
    mkdirSync(seamWorkspace)
    const writeSid = workspaceWriteSid(seamWorkspace)
    const privateTemp = join(isolatedTemp, 'private-subdir')
    mkdirSync(privateTemp)
    const privateTempSid = tempWriteSid(privateTemp)
    const grant = AclWriteGrant.create(privateTempSid)
    grant.add(privateTemp)
    try {
      const probe = [
        "$ErrorActionPreference='SilentlyContinue';",
        `try{Set-Content -Path '${seamWorkspace}\\server-granted.txt' -Value ok -ErrorAction Stop;'WORKSPACE-WRITE: OK'}catch{'WORKSPACE-WRITE: DENIED'};`,
        `try{Set-Content -Path '${privateTemp}\\server-granted.txt' -Value ok -ErrorAction Stop;'PRIVATE-TEMP-WRITE: OK'}catch{'PRIVATE-TEMP-WRITE: DENIED'};`,
        "'TEMP-ENV: ' + $env:TEMP;",
        "'TMP-ENV: ' + $env:TMP",
      ].join('')
      const result = runRunner([
        '--workspace', seamWorkspace, '--temp', privateTemp, '--mode', 'workspace-write', '--write-sid', writeSid,
        '--temp-write-sid', privateTempSid,
        '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
      ])
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      // The runner granted nothing (only the caller's temp-SID grant
      // stands): the workspace write is denied, the private temp write lands,
      // and the child's TMP/TEMP point at the private subdirectory.
      expect(result.stdout).toContain('WORKSPACE-WRITE: DENIED')
      expect(result.stdout).toContain('PRIVATE-TEMP-WRITE: OK')
      expect(result.stdout).toContain(`TEMP-ENV: ${privateTemp}`)
      expect(result.stdout).toContain(`TMP-ENV: ${privateTemp}`)
      expect(existsSync(join(seamWorkspace, 'server-granted.txt'))).toBe(false)
      expect(existsSync(join(privateTemp, 'server-granted.txt'))).toBe(true)
    } finally {
      grant.dispose()
      rmSync(privateTemp, { recursive: true, force: true })
    }
  }, 30_000)

  it('temp capabilities isolate sibling sessions that share one workspace SID', () => {
    const writeSid = workspaceWriteSid(writableDir)
    const tempA = join(isolatedTemp, 'session-a')
    const tempB = join(isolatedTemp, 'session-b')
    mkdirSync(tempA)
    mkdirSync(tempB)
    const sidA = tempWriteSid(tempA)
    const sidB = tempWriteSid(tempB)
    const workspaceGrant = AclWriteGrant.create(writeSid)
    const grantA = AclWriteGrant.create(sidA)
    const grantB = AclWriteGrant.create(sidB)
    workspaceGrant.add(writableDir)
    grantA.add(tempA)
    grantB.add(tempB)
    const sharedWorkspaceFile = join(writableDir, 'shared-between-sessions.txt')
    const probe = [
      "const fs = require('node:fs');",
      "const targets = [['OWN', process.argv[1]], ['SIBLING', process.argv[2]], ['WORKSPACE', process.argv[3]]];",
      "if (process.argv[4]) targets.push(['SIBLING-EXISTING', process.argv[4]]);",
      'for (const [name, target] of targets) {',
      "try { fs.writeFileSync(target, name); console.log(name + ': OK'); } catch { console.log(name + ': DENIED'); }",
      '}',
    ].join('')
    try {
      const resultA = runRunner([
        '--workspace', writableDir, '--temp', tempA, '--mode', 'workspace-write',
        '--write-sid', writeSid, '--temp-write-sid', sidA,
        '--', process.execPath, '-e', probe, join(tempA, 'a.txt'), join(tempB, 'a-escaped.txt'), sharedWorkspaceFile,
      ])
      expect(resultA.status, `stderr: ${resultA.stderr}`).toBe(0)
      expect(resultA.stdout).toContain('OWN: OK')
      expect(resultA.stdout).toContain('SIBLING: DENIED')
      expect(resultA.stdout).toContain('WORKSPACE: OK')

      const resultB = runRunner([
        '--workspace', writableDir, '--temp', tempB, '--mode', 'workspace-write',
        '--write-sid', writeSid, '--temp-write-sid', sidB,
        '--', process.execPath, '-e', probe, join(tempB, 'b.txt'), join(tempA, 'b-escaped.txt'), sharedWorkspaceFile, join(tempA, 'a.txt'),
      ])
      expect(resultB.status, `stderr: ${resultB.stderr}`).toBe(0)
      expect(resultB.stdout).toContain('OWN: OK')
      expect(resultB.stdout).toContain('SIBLING: DENIED')
      expect(resultB.stdout).toContain('SIBLING-EXISTING: DENIED')
      expect(resultB.stdout).toContain('WORKSPACE: OK')
      expect(existsSync(join(tempB, 'a-escaped.txt'))).toBe(false)
      expect(existsSync(join(tempA, 'b-escaped.txt'))).toBe(false)
      expect(readFileSync(join(tempA, 'a.txt'), 'utf8')).toBe('OWN')
    } finally {
      workspaceGrant.dispose()
      grantA.dispose()
      grantB.dispose()
      rmSync(tempA, { recursive: true, force: true })
      rmSync(tempB, { recursive: true, force: true })
    }
  }, 30_000)

  it('agentless workspace-write creates a fresh private temp per call and removes it on exit', () => {
    const captureA = join(writableDir, 'agentless-temp-a.txt')
    const captureB = join(writableDir, 'agentless-temp-b.txt')
    for (const capture of [captureA, captureB]) {
      const result = runRunner([
        '--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'workspace-write',
        '--', process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], process.env.TEMP)", capture,
      ])
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    }
    const tempA = readFileSync(captureA, 'utf8')
    const tempB = readFileSync(captureB, 'utf8')
    expect(tempA).not.toBe(tempB)
    expect(tempA.startsWith(isolatedTemp)).toBe(true)
    expect(tempB.startsWith(isolatedTemp)).toBe(true)
    expect(existsSync(tempA)).toBe(false)
    expect(existsSync(tempB)).toBe(false)
  }, 30_000)

  it('agentless workspace-write rejects a temp root inside the workspace before spawning', () => {
    const overlapWorkspace = join(scratchRoot, 'overlap-workspace')
    const nestedTempRoot = join(overlapWorkspace, 'temp')
    const marker = join(overlapWorkspace, 'command-ran.txt')
    mkdirSync(overlapWorkspace)
    mkdirSync(nestedTempRoot)

    const result = runRunner([
      '--workspace', overlapWorkspace, '--temp', nestedTempRoot, '--mode', 'workspace-write',
      '--', process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker,
    ])
    expect(result.status, `stderr: ${result.stderr}`).toBe(127)
    expect(result.stderr).toContain('windows-acl-run: Windows ACL temp root must be outside the workspace')
    expect(existsSync(marker)).toBe(false)
  }, 15_000)

  it('confined children spawn grandchildren with inherited stdio; piped capture stays denied (named-pipe default SD template)', () => {
    // Two-layer pin of the grandchild-spawn boundary:
    //  - the token default DACL carries a restricting-SID ACE (set in init),
    //    so ANONYMOUS pipe creation (CreatePipe — the token-default-DACL
    //    consumer) works and inherited/ignored stdio spawns succeed;
    //  - libuv's pipe-stdio uses NAMED pipes, whose default security
    //    descriptor is the Win32 layer's user-mode default SD template
    //    (built by KernelBase — owner/SYSTEM/Admins full, Everyone/ANONYMOUS
    //    read-only) — NOT the token default DACL, which is what the kernel
    //    applies to a raw SD-null create — so the client-end open requests
    //    write access no restricting SID is
    //    granted: ERROR_ACCESS_DENIED, surfaced as spawn EPERM. That is the
    //    POC-documented "no output redirection" boundary of WRITE_RESTRICTED
    //    tokens; piped capture cannot work and is pinned as DENIED.
    const probe = [
      "const { spawnSync } = require('child_process');",
      "const t = (name, opts) => { const s = spawnSync(process.execPath, ['-e', '1'], { encoding: 'utf8', ...opts }); console.log(name + ':' + (s.status === 0 ? 'OK' : 'DENIED')); };",
      "t('inherit', { stdio: 'inherit' });",
      "t('ignore', { stdio: 'ignore' });",
      "t('pipe', { stdio: 'pipe' });",
    ].join('')
    for (const mode of ['workspace-write', 'read-only'] as const) {
      const result = runRunner([
        '--workspace', writableDir, '--temp', isolatedTemp, '--mode', mode,
        '--', 'node', '-e', probe,
      ])
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      expect(result.stdout, `mode: ${mode}`).toContain('inherit:OK')
      expect(result.stdout, `mode: ${mode}`).toContain('ignore:OK')
      expect(result.stdout, `mode: ${mode}`).toContain('pipe:DENIED')
    }
  }, 30_000)

  it('mode-downgrade leak regression: a STANDING workspace grant is inert under read-only and effective again on re-upgrade', () => {
    // The reported defect: a session that materialized its grant in
    // workspace-write keeps the ACE standing for the server lifetime. After
    // switching to read-only, the restricted token's read-only list must carry NO
    // capability SID — the standing ACE stays but the pass-2 check cannot use
    // it, so the workspace write is denied instead of leaking through the
    // standing ACE. The switch back reuses the SAME standing ACE: the
    // re-upgrade write lands without any re-grant.
    const writeSid = workspaceWriteSid(writableDir)
    const privateTemp = join(isolatedTemp, 'mode-switch-temp')
    mkdirSync(privateTemp)
    const privateTempSid = tempWriteSid(privateTemp)
    const grant = AclWriteGrant.create(writeSid)
    grant.add(writableDir)
    try {
      const downgradeProbe = [
        "$ErrorActionPreference='SilentlyContinue';",
        `try{Set-Content -Path '${writableDir}\\downgraded.txt' -Value ok -ErrorAction Stop;'DOWNGRADE-WRITE: OK (LEAK!)'}catch{'DOWNGRADE-WRITE: DENIED'}`,
      ].join('')
      const downgraded = runRunner([
        '--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'read-only',
        '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', downgradeProbe,
      ])
      expect(downgraded.status, `stderr: ${downgraded.stderr}`).toBe(0)
      expect(downgraded.stdout).toContain('DOWNGRADE-WRITE: DENIED')
      expect(existsSync(join(writableDir, 'downgraded.txt'))).toBe(false)

      const reupgradeProbe = [
        "$ErrorActionPreference='SilentlyContinue';",
        `try{Set-Content -Path '${writableDir}\\reupgraded.txt' -Value ok -ErrorAction Stop;'REUPGRADE-WRITE: OK'}catch{'REUPGRADE-WRITE: DENIED'}`,
      ].join('')
      const reupgraded = runRunner([
        '--workspace', writableDir, '--temp', privateTemp, '--mode', 'workspace-write', '--write-sid', writeSid,
        '--temp-write-sid', privateTempSid,
        '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', reupgradeProbe,
      ])
      expect(reupgraded.status, `stderr: ${reupgraded.stderr}`).toBe(0)
      expect(reupgraded.stdout).toContain('REUPGRADE-WRITE: OK')
      expect(existsSync(join(writableDir, 'reupgraded.txt'))).toBe(true)
    } finally {
      grant.dispose()
      rmSync(privateTemp, { recursive: true, force: true })
    }
  }, 30_000)

  it('ambient-writable escape regression: a C:\\Users\\Public subdirectory is denied under BOTH modes (INTERACTIVE absent from both lists)', (ctx) => {
    // The Public tree grants write to INTERACTIVE; the D1-D6 matrix pinned
    // that removing INTERACTIVE from the restricting lists closes the escape.
    // The committed suites never probed it — this pins the ambient boundary
    // end to end with the real restricted token.
    if (publicProbeDir === undefined) {
      ctx.skip() // Public unavailable/unwritable on this host
      return
    }
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      `try{Set-Content -Path '${publicProbeDir}\\public-escaped.txt' -Value ok -ErrorAction Stop;'PUBLIC-WRITE: OK (ESCAPE!)'}catch{'PUBLIC-WRITE: DENIED'}`,
    ].join('')
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const result = runRunner([
        '--workspace', writableDir, '--temp', isolatedTemp, '--mode', mode,
        '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
      ])
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      expect(result.stdout, `mode: ${mode}`).toContain('PUBLIC-WRITE: DENIED')
      expect(existsSync(join(publicProbeDir, 'public-escaped.txt')), `mode: ${mode}`).toBe(false)
    }
  }, 30_000)

  it('delete-escape regression: deletes outside the granted roots are denied in BOTH modes, through every delete authority', () => {
    // Windows authorizes a delete from the object's own DELETE right OR the
    // parent directory's FILE_DELETE_CHILD, and the write-restricted
    // intersection only covers the first — so `cmd /c del` used to delete
    // outside the workspace. The Low label plus the grant's deny close both
    // routes; these are the deleters a confined child reaches for.
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const victims = {
        cmd: join(scratchRoot, `delete-${mode}-cmd.txt`),
        dotnet: join(scratchRoot, `delete-${mode}-dotnet.txt`),
        remove: join(scratchRoot, `delete-${mode}-remove.txt`),
        unlink: join(scratchRoot, `delete-${mode}-unlink.txt`),
        inside: join(writableDir, `delete-${mode}-inside.txt`),
      }
      for (const path of Object.values(victims)) writeFileSync(path, 'delete me')
      const quoted = (path: string) => `'${path}'`
      const probe = [
        "$ErrorActionPreference='SilentlyContinue';",
        `& '${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe' /c del /f /q ${quoted(victims.cmd)} 2>&1 | Out-Null;`
          + `'CMD-DEL: ' + $(if (Test-Path -LiteralPath ${quoted(victims.cmd)}) {'DENIED'} else {'DELETED'});`,
        `try{[System.IO.File]::Delete(${quoted(victims.dotnet)});'DOTNET-DELETE: DELETED'}catch{'DOTNET-DELETE: DENIED'};`,
        `try{Remove-Item -LiteralPath ${quoted(victims.remove)} -ErrorAction Stop;'REMOVE-ITEM: DELETED'}catch{'REMOVE-ITEM: DENIED'};`,
        `& "${process.execPath}" -e "const fs=require('node:fs');try{fs.unlinkSync(process.argv[1]);console.log('NODE-UNLINK: DELETED')}catch(e){console.log('NODE-UNLINK: DENIED')}" ${quoted(victims.unlink)};`,
        `try{[System.IO.File]::Delete(${quoted(victims.inside)});'INSIDE-DELETE: DELETED'}catch{'INSIDE-DELETE: DENIED'}`,
      ].join('')
      const result = runRunner([
        '--workspace', writableDir, '--temp', isolatedTemp, '--mode', mode,
        '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
      ])
      expect(result.status, `mode: ${mode}\nstderr: ${result.stderr}`).toBe(0)
      expect(result.stdout, `mode: ${mode}`).toContain('CMD-DEL: DENIED')
      expect(result.stdout, `mode: ${mode}`).toContain('DOTNET-DELETE: DENIED')
      expect(result.stdout, `mode: ${mode}`).toContain('REMOVE-ITEM: DENIED')
      expect(result.stdout, `mode: ${mode}`).toContain('NODE-UNLINK: DENIED')
      for (const path of [victims.cmd, victims.dotnet, victims.remove, victims.unlink]) {
        expect(existsSync(path), `mode: ${mode}, ${path}`).toBe(true)
      }
      // The granted root keeps its own delete authority: read-only carries no
      // write SID, so only workspace-write may delete there.
      expect(result.stdout, `mode: ${mode}`).toContain(
        mode === 'workspace-write' ? 'INSIDE-DELETE: DELETED' : 'INSIDE-DELETE: DENIED',
      )
      expect(existsSync(victims.inside), `mode: ${mode}`).toBe(mode === 'read-only')
    }
  }, 60_000)

  it('cross-root delete regression: one session cannot delete inside ANOTHER granted root', () => {
    // Both roots carry the Low label, so the integrity check alone would not
    // stop this: Windows also authorizes a delete from the parent directory's
    // FILE_DELETE_CHILD right, which the capability intersection never reaches.
    // The grant denies that right, leaving the capability DELETE bit as the
    // only delete authority inside a granted root.
    const otherWorkspace = join(scratchRoot, 'other-workspace')
    const otherTemp = join(scratchRoot, 'other-temp')
    mkdirSync(otherWorkspace)
    mkdirSync(otherTemp)
    const otherWorkspaceSid = workspaceWriteSid(otherWorkspace)
    const otherTempSid = tempWriteSid(otherTemp)
    const otherWorkspaceGrant = AclWriteGrant.create(otherWorkspaceSid)
    const otherTempGrant = AclWriteGrant.create(otherTempSid)
    otherWorkspaceGrant.add(otherWorkspace, true)
    otherTempGrant.add(otherTemp)
    // Session A's own roots, granted the same way, run through the runner.
    const ownWorkspace = join(scratchRoot, 'own-workspace')
    const ownTemp = join(scratchRoot, 'own-temp')
    mkdirSync(ownWorkspace)
    mkdirSync(ownTemp)
    const ownWorkspaceSid = workspaceWriteSid(ownWorkspace)
    const ownTempSid = tempWriteSid(ownTemp)
    const ownWorkspaceGrant = AclWriteGrant.create(ownWorkspaceSid)
    const ownTempGrant = AclWriteGrant.create(ownTempSid)
    ownWorkspaceGrant.add(ownWorkspace, true)
    ownTempGrant.add(ownTemp)
    try {
      const victims = {
        ownWork: join(ownWorkspace, 'victim.txt'),
        otherWork: join(otherWorkspace, 'victim.txt'),
        ownTemp: join(ownTemp, 'victim.txt'),
        otherTemp: join(otherTemp, 'victim.txt'),
      }
      for (const path of Object.values(victims)) writeFileSync(path, 'delete me')
      const probe = [
        "$ErrorActionPreference='SilentlyContinue';",
        ...Object.entries(victims).map(([name, path]) =>
          `try{[System.IO.File]::Delete('${path}');'${name}: DELETED'}catch{'${name}: DENIED'};`),
      ].join('')
      const result = runRunner([
        '--workspace', ownWorkspace, '--temp', ownTemp, '--mode', 'workspace-write',
        '--write-sid', ownWorkspaceSid, '--temp-write-sid', ownTempSid,
        '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
      ])
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('ownWork: DELETED')
      expect(result.stdout).toContain('ownTemp: DELETED')
      expect(result.stdout).toContain('otherWork: DENIED')
      expect(result.stdout).toContain('otherTemp: DENIED')
      expect(existsSync(victims.otherWork)).toBe(true)
      expect(existsSync(victims.otherTemp)).toBe(true)
      expect(existsSync(victims.ownWork)).toBe(false)
      expect(existsSync(victims.ownTemp)).toBe(false)
    } finally {
      ownWorkspaceGrant.dispose()
      ownTempGrant.dispose()
      otherWorkspaceGrant.dispose()
      otherTempGrant.dispose()
      rmSync(ownTemp, { recursive: true, force: true })
      rmSync(otherTemp, { recursive: true, force: true })
    }
  }, 60_000)

  it('cross-root delete regression: pre-existing peer temp descendants resist foreign deletes despite explicit user allows', () => {
    const ownWork = join(scratchRoot, 'nested-own-work')
    const ownTemp = join(scratchRoot, 'nested-own-temp')
    const peerTemp = join(scratchRoot, 'nested-peer-temp')
    const branches = { root: peerTemp, inherited: join(peerTemp, 'inherited'), explicit: join(peerTemp, 'explicit') }
    const modes = ['workspace-write', 'read-only'] as const
    const peerVictims = modes.flatMap(mode => Object.entries(branches).map(([label, dir]) => ({ mode, label, path: join(dir, `${mode}.txt`) })))
    const peerPaths = [...Object.values(branches), ...peerVictims.map(victim => victim.path)]
    const ownSid = workspaceWriteSid(ownWork)
    const ownTempSid = tempWriteSid(ownTemp)
    const peerSid = tempWriteSid(peerTemp)
    const grants: AclWriteGrant[] = []
    const quote = (path: string): string => `'${path.replaceAll("'", "''")}'`
    try {
      for (const dir of [ownWork, ownTemp, ...Object.values(branches)]) mkdirSync(dir)
      for (const victim of peerVictims) writeFileSync(victim.path, 'peer victim')
      for (const mode of modes) writeFileSync(join(ownWork, `${mode}.txt`), 'own victim')
      const fixtureSecurity = `
Add-Type -Namespace Peer -Name FixtureSecurity -MemberDefinition @'
[DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)]
private static extern uint GetNamedSecurityInfoW(string path, int kind, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
[DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)]
private static extern uint SetNamedSecurityInfoW(string path, int kind, uint info, IntPtr owner, IntPtr group, byte[] dacl, IntPtr sacl);
[DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)]
private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
[DllImport("kernel32.dll", SetLastError=true)]
private static extern IntPtr LocalFree(IntPtr memory);
public static void SetDacl(string path, byte[] dacl) {
  if (dacl == null || dacl.Length < 8) throw new ArgumentException("A real DACL is required");
  uint result = SetNamedSecurityInfoW(path, 1, 0x4, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
  if (result != 0) throw new System.ComponentModel.Win32Exception((int)result, "Set fixture DACL: " + path);
}
public static string ReadLabel(string path) { return ReadSections(path, 0x10); }
public static string ReadIdentityAndLabel(string path) { return ReadSections(path, 0x13); }
private static string ReadSections(string path, uint info) {
  IntPtr owner, group, dacl, sacl, descriptor;
  uint result = GetNamedSecurityInfoW(path, 1, info, out owner, out group, out dacl, out sacl, out descriptor);
  if (result != 0) throw new System.ComponentModel.Win32Exception((int)result, "Read security sections: " + path);
  try {
    IntPtr text;
    uint length;
    if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, info, out text, out length))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Format security sections: " + path);
    try { return Marshal.PtrToStringUni(text); }
    finally { if (LocalFree(text) != IntPtr.Zero) throw new InvalidOperationException("LocalFree(security text)"); }
  } finally { if (LocalFree(descriptor) != IntPtr.Zero) throw new InvalidOperationException("LocalFree(security descriptor)"); }
}
'@ | Out-Null
`
      // All victims predate the grant. Only the explicit branch receives a
      // direct user allow; the sibling is an inherited-only denial control.
      // Set-Acl can copy the SACL too, so write only DACL_SECURITY_INFORMATION.
      const setupScript = `
$ErrorActionPreference='Stop'
${fixtureSecurity}
foreach ($path in @(${peerPaths.map(quote).join(', ')})) {
  & icacls.exe $path /reset
  if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed for $path with exit $LASTEXITCODE" }
}
$unchangedSections = @{}
foreach ($path in @(${peerPaths.map(quote).join(', ')})) {
  $sections = [Peer.FixtureSecurity]::ReadIdentityAndLabel($path)
  "BEFORE-EXPLICIT-ACE PATH=$path IDENTITY-LABEL=$sections"
  if ($sections -match 'S:[^(]*P') { throw "Peer fixture already has a protected SACL: $path" }
  $unchangedSections[$path] = $sections
}
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$explicit = ${quote(branches.explicit)}
$acl = Get-Acl -LiteralPath $explicit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
$dacl = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl).DiscretionaryAcl
if ($null -eq $dacl) { throw 'Explicit peer fixture must have a DACL' }
$daclBytes = [byte[]]::new($dacl.BinaryLength)
$dacl.GetBinaryForm($daclBytes, 0)
[Peer.FixtureSecurity]::SetDacl($explicit, $daclBytes)
foreach ($path in @(${peerPaths.map(quote).join(', ')})) {
  $sections = [Peer.FixtureSecurity]::ReadIdentityAndLabel($path)
  "AFTER-EXPLICIT-ACE PATH=$path IDENTITY-LABEL=$sections"
  if ($sections -cne $unchangedSections[$path]) { throw "DACL-only fixture edit changed owner, group, or label inheritance: $path" }
}
foreach ($path in @(${quote(branches.inherited)}, ${quote(branches.explicit)})) {
  $acl = Get-Acl -LiteralPath $path
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  "PRE-GRANT PATH=$path ORDERED-SDDL=$($acl.Sddl)"
  if ($acl.AreAccessRulesProtected -or -not $acl.AreAccessRulesCanonical -or $rules.Count -eq 0) { throw "Invalid peer fixture DACL: $path" }
  if ($path -eq $explicit) {
    if (@($rules | Where-Object { -not $_.IsInherited -and $_.IdentityReference -eq $user -and $_.AccessControlType -eq 'Allow' -and ([int]$_.FileSystemRights -band 0x1f01ff) -eq 0x1f01ff }).Count -eq 0) { throw 'Missing explicit current-user FullControl fixture' }
  } elseif (@($rules | Where-Object { -not $_.IsInherited }).Count -ne 0) { throw 'Inherited peer fixture has an explicit ACE' }
}
'PEER-FIXTURE: READY'
`
      const setup = spawnSync('pwsh', ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', setupScript], { encoding: 'utf8', timeout: 60_000 })
      const setupDetails = `fixture stdout: ${setup.stdout}\nfixture stderr: ${setup.stderr}`
      expect(setup.error, setupDetails).toBeUndefined()
      expect(setup.signal, setupDetails).toBeNull()
      expect(setup.status, setupDetails).toBe(0)
      expect(setup.stdout, setupDetails).toMatch(/^PEER-FIXTURE: READY\r?$/mu)
      for (const [path, sid] of [[ownWork, ownSid], [ownTemp, ownTempSid], [peerTemp, peerSid]] as const) {
        const grant = AclWriteGrant.create(sid)
        grants.push(grant)
        grant.add(path)
      }
      const inspectScript = `
$ErrorActionPreference='Stop'
${fixtureSecurity}
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($path in @(${peerPaths.map(quote).join(', ')})) {
  $acl = Get-Acl -LiteralPath $path
  $label = [Peer.FixtureSecurity]::ReadLabel($path)
  "POST-GRANT PATH=$path ORDERED-SDDL=$($acl.Sddl) LABEL=$label"
  if ($label -notmatch '\\(ML;[^;]*;NW;;;LW\\)') { throw "Peer object is not Low/no-write-up: $path" }
  $aces = @([System.Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl).DiscretionaryAcl)
  if (@($aces | Where-Object { $_.SecurityIdentifier.Value -in @('${ownSid}', '${ownTempSid}') }).Count -ne 0) { throw "Peer object carries an A capability: $path" }
  if (@($aces | Where-Object { $_.AceType -eq 'AccessAllowed' -and $_.SecurityIdentifier.Value -eq '${peerSid}' -and $_.AccessMask -eq 0x110156 }).Count -eq 0) { throw "Peer object lacks its B capability: $path" }
  if ($path -in @(${quote(branches.root)}, ${quote(branches.inherited)})) {
    $denyIndex = -1
    $firstAllow = $aces.Count
    for ($index = 0; $index -lt $aces.Count; $index++) {
      $ace = $aces[$index]
      if ($path -eq ${quote(branches.inherited)} -and ([int]$ace.AceFlags -band 0x10) -eq 0) { throw "Inherited peer control gained an explicit ACE: $($acl.Sddl)" }
      if ($ace.AceType -eq 'AccessAllowed' -and ([int]$ace.AceFlags -band 0x08) -eq 0) { $firstAllow = [Math]::Min($firstAllow, $index) }
      if ($ace.AceType -eq 'AccessDenied' -and $ace.SecurityIdentifier.Value -eq 'S-1-1-0' -and ([int]$ace.AceFlags -band 0x08) -eq 0 -and $ace.AccessMask -eq 0x40) { $denyIndex = $index }
    }
    if ($denyIndex -lt 0 -or $denyIndex -ge $firstAllow) { throw "Peer denial control lacks an effective leading deny: $path $($acl.Sddl)" }
  }
  if ($path -eq ${quote(branches.explicit)}) {
    $allowIndex = -1
    $denyIndex = -1
    for ($index = 0; $index -lt $aces.Count; $index++) {
      $ace = $aces[$index]
      if ($ace.AceType -eq 'AccessAllowed' -and $ace.SecurityIdentifier.Value -eq $userSid -and ([int]$ace.AceFlags -band 0x18) -eq 0 -and ($ace.AccessMask -band 0x1f01ff) -eq 0x1f01ff) { $allowIndex = $index }
      if ($ace.AceType -eq 'AccessDenied' -and $ace.SecurityIdentifier.Value -eq 'S-1-1-0' -and ([int]$ace.AceFlags -band 0x18) -eq 0x10 -and $ace.AccessMask -eq 0x40) { $denyIndex = $index }
    }
    if ($allowIndex -lt 0 -or $denyIndex -le $allowIndex) { throw 'Explicit peer FullControl must precede the inherited Everyone delete-child deny' }
  }
}
'PEER-ACL: VERIFIED'
`
      const inspection = spawnSync('pwsh', ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', inspectScript], { encoding: 'utf8', timeout: 60_000 })
      const inspectionDetails = `${setupDetails}\ninspection stdout: ${inspection.stdout}\ninspection stderr: ${inspection.stderr}`
      expect(inspection.error, inspectionDetails).toBeUndefined()
      expect(inspection.signal, inspectionDetails).toBeNull()
      expect(inspection.status, inspectionDetails).toBe(0)
      expect(inspection.stdout, inspectionDetails).toMatch(/^PEER-ACL: VERIFIED\r?$/mu)
      const probe = `
const fs = require('node:fs');
const results = JSON.parse(process.argv[1]).map(({ label, path }) => {
  try { fs.unlinkSync(path); return { label, deleted: true }; }
  catch (error) { return { label, deleted: false, code: error.code }; }
});
console.log(JSON.stringify(results));
`
      // Run both modes and every target before asserting, so a failure retains
      // the root, inherited, explicit, and own-root controls together.
      const observations = modes.map((mode) => {
        const victims = [...peerVictims.filter(victim => victim.mode === mode), { label: 'own', path: join(ownWork, `${mode}.txt`) }]
        const result = runRunner([
          '--workspace', ownWork, '--temp', ownTemp, '--mode', mode,
          ...(mode === 'workspace-write' ? ['--write-sid', ownSid, '--temp-write-sid', ownTempSid] : []),
          '--', process.execPath, '-e', probe, JSON.stringify(victims),
        ])
        return { mode, victims, result }
      })
      const details = `${inspectionDetails}\n${observations.map(({ mode, result }) => `${mode} stdout: ${result.stdout}\nstderr: ${result.stderr}`).join('\n')}`
      const deniedCode: unknown = expect.stringMatching(/^(?:EACCES|EPERM)$/u)
      for (const { mode, victims, result } of observations) {
        expect(result.error, details).toBeUndefined()
        expect(result.signal, details).toBeNull()
        expect(result.status, details).toBe(0)
        expect(JSON.parse(result.stdout), details).toEqual(victims.map(({ label }) =>
          label === 'own' && mode === 'workspace-write'
            ? { label, deleted: true }
            : { label, deleted: false, code: deniedCode }))
        for (const { label, path } of victims) {
          expect(existsSync(path), `${details}\n${mode}: ${path}`).toBe(label !== 'own' || mode === 'read-only')
        }
      }
    } finally {
      const failures: unknown[] = []
      for (const grant of grants.reverse()) {
        try { grant.dispose() } catch (error) { failures.push(error) }
      }
      for (const path of [ownWork, ownTemp, peerTemp]) {
        try { rmSync(path, { recursive: true, force: true }) } catch (error) { failures.push(error) }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Nested cross-root fixture cleanup failed')
    }
  }, nativeProbeTimeout)

  it('NUL writes stay ambient under the Low token in BOTH modes', () => {
    // The device DACL grants Everyone write and carries no higher label, so
    // the documented `> NUL` redirection must survive the lowered token. The
    // redirection stays inside cmd's own command line: PowerShell's `>nul`
    // opens a file named nul instead, which is a different probe.
    const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32\\cmd.exe')
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      `& '${cmd}' /c 'echo ok>NUL&&echo CMD-NUL: OK';`,
      `& "${process.execPath}" -e "try{require('node:fs').writeFileSync(process.argv[1],'x');console.log('NODE-NUL: OK')}catch(e){console.log('NODE-NUL: DENIED '+e.code)}" '\\\\.\\NUL'`,
    ].join('')
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const result = runRunner([
        '--workspace', writableDir, '--temp', isolatedTemp, '--mode', mode,
        '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
      ])
      expect(result.status, `mode: ${mode}\nstderr: ${result.stderr}`).toBe(0)
      expect(result.stdout, `mode: ${mode}`).toContain('CMD-NUL: OK')
      expect(result.stdout, `mode: ${mode}`).toContain('NODE-NUL: OK')
    }
  }, 30_000)

  it('a FullControl open inside a granted root still works for files (the deny inherits to containers only)', () => {
    // The ambient-delete deny is 0x40, a member of FILE_ALL_ACCESS: inheriting
    // it onto files would deny every GENERIC_ALL/FullControl open by the user,
    // Administrators, SYSTEM, or the DSH host. In this inherited-only fixture,
    // directories keep the deny where FILE_DELETE_CHILD is evaluated, so a
    // FullControl open of a DIRECTORY must fail.
    const granted = join(scratchRoot, 'fullcontrol-root')
    const child = join(granted, 'child')
    const rootFile = join(granted, 'file.txt')
    const nestedFile = join(child, 'deep.txt')
    const fixturePaths = [granted, child, rootFile, nestedFile]
    mkdirSync(granted)
    mkdirSync(child)
    writeFileSync(rootFile, 'x')
    writeFileSync(nestedFile, 'x')
    const grant = AclWriteGrant.create(workspaceWriteSid(granted))
    try {
      // Explicit child allows outrank an inherited deny. This inheritance
      // regression owns an inherited-only tree, including its existing files.
      // Reset only these four objects before granting; never repair the result.
      const fixtureSetup = `
$ErrorActionPreference='Stop'
foreach ($path in @(${fixturePaths.map(path => `'${path.replaceAll("'", "''")}'`).join(', ')})) {
  $before = Get-Acl -LiteralPath $path
  "BEFORE-RESET PATH=$path ORDERED-SDDL=$($before.Sddl)"
  & icacls.exe $path /reset
  if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed for $path with exit $LASTEXITCODE" }
  $acl = Get-Acl -LiteralPath $path
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  "PRE-GRANT PATH=$path PROTECTED=$($acl.AreAccessRulesProtected) CANONICAL=$($acl.AreAccessRulesCanonical) ORDERED-SDDL=$($acl.Sddl)"
  if ($acl.AreAccessRulesProtected -or -not $acl.AreAccessRulesCanonical -or $rules.Count -eq 0 -or @($rules | Where-Object { -not $_.IsInherited }).Count -ne 0) {
    throw "Expected a nonempty, unprotected, canonical inherited-only DACL before grant: $path"
  }
}
'INHERITED-FIXTURE: READY'
`
      const setup = spawnSync('pwsh', ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', fixtureSetup], { encoding: 'utf8', timeout: 60_000 })
      const setupDiagnostics = `fixture stdout: ${setup.stdout}\nfixture stderr: ${setup.stderr}`
      expect(setup.error, setupDiagnostics).toBeUndefined()
      expect(setup.signal, setupDiagnostics).toBeNull()
      expect(setup.status, setupDiagnostics).toBe(0)
      expect(setup.stdout, setupDiagnostics).toMatch(/^INHERITED-FIXTURE: READY\r?$/mu)
      grant.add(granted, true)
      const probe = `
$ErrorActionPreference='Stop'
Add-Type -Namespace P -Name F -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CreateFileW")]
private static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
[DllImport("kernel32.dll", SetLastError=true)]
private static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll")]
private static extern IntPtr GetCurrentProcess();
[DllImport("advapi32.dll", SetLastError=true)]
private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
[DllImport("advapi32.dll", SetLastError=true)]
private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
[DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
private static extern bool LookupPrivilegeValueW(string system, string name, out long luid);

public static string OpenFullControl(string path) {
  IntPtr handle = CreateFileW(path, 0x10000000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
  if (handle == new IntPtr(-1)) {
    int error = Marshal.GetLastWin32Error();
    if (error != 5) throw new System.ComponentModel.Win32Exception(error, "CreateFileW: " + path);
    return "DENIED WIN32=5";
  }
  if (handle == IntPtr.Zero) throw new InvalidOperationException("CreateFileW returned a null handle: " + path);
  if (!CloseHandle(handle)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle: " + path);
  return "OK HANDLE=0x" + handle.ToInt64().ToString("X");
}

// Query this PowerShell process's token; never enable or remove privileges.
public static string[] BackupPrivilegeStates() {
  IntPtr token;
  if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token))
    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken(TOKEN_QUERY)");
  try {
    int needed;
    bool sized = GetTokenInformation(token, 3, IntPtr.Zero, 0, out needed);
    int error = Marshal.GetLastWin32Error();
    if (sized || error != 122 || needed < 4)
      throw new InvalidOperationException("TokenPrivileges size query: " + error + ", bytes=" + needed);
    IntPtr data = Marshal.AllocHGlobal(needed);
    try {
      int returned;
      if (!GetTokenInformation(token, 3, data, needed, out returned))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation(TokenPrivileges)");
      int count = Marshal.ReadInt32(data);
      if (returned < 4 || returned > needed || count < 0 || count > (returned - 4) / 12)
        throw new InvalidOperationException("Invalid TOKEN_PRIVILEGES length");
      string[] names = { "SeBackupPrivilege", "SeRestorePrivilege" };
      string[] states = new string[names.Length];
      for (int n = 0; n < names.Length; n++) {
        long luid;
        if (!LookupPrivilegeValueW(null, names[n], out luid))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "LookupPrivilegeValueW: " + names[n]);
        states[n] = names[n] + "=ABSENT";
        for (int i = 0; i < count; i++) {
          int offset = 4 + i * 12;
          if (Marshal.ReadInt64(data, offset) != luid) continue;
          int attributes = Marshal.ReadInt32(data, offset + 8);
          states[n] = names[n] + ((attributes & 2) != 0 ? "=ENABLED" : "=DISABLED") + " ATTRIBUTES=0x" + attributes.ToString("X");
          break;
        }
      }
      return states;
    } finally { Marshal.FreeHGlobal(data); }
  } finally {
    if (!CloseHandle(token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle(token)");
  }
}
'@ | Out-Null
function AssertInheritedResult([string]$path, [bool]$directory) {
  $acl = Get-Acl -LiteralPath $path
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
  $aces = @($raw.DiscretionaryAcl)
  if ($acl.AreAccessRulesProtected -or -not $acl.AreAccessRulesCanonical -or $aces.Count -eq 0) {
    throw "Invalid inherited DACL after grant: $path $($acl.Sddl)"
  }
  $denyCount = 0
  $denyIndex = -1
  $firstAllow = $aces.Count
  for ($index = 0; $index -lt $aces.Count; $index++) {
    $ace = $aces[$index]
    if (([int]$ace.AceFlags -band 0x10) -eq 0) {
      throw "Grant introduced an explicit child ACE: $path $($acl.Sddl)"
    }
    if ($ace.AceType -eq [System.Security.AccessControl.AceType]::AccessAllowed -and ([int]$ace.AceFlags -band 0x08) -eq 0) {
      $firstAllow = [Math]::Min($firstAllow, $index)
    }
    if ($ace.AceType -eq [System.Security.AccessControl.AceType]::AccessDenied -and $ace.SecurityIdentifier.Value -eq 'S-1-1-0' -and ($ace.AccessMask -band 0x40) -ne 0) {
      $denyCount++
      $denyIndex = $index
      if ($directory -and ($ace.AccessMask -ne 0x40 -or [int]$ace.AceFlags -ne 0x12)) {
        throw "Unexpected inherited directory deny: $path $($acl.Sddl)"
      }
    }
  }
  if ($directory) {
    if ($denyCount -ne 1 -or $denyIndex -ge $firstAllow) {
      throw "Expected the inherited directory deny before effective allows: $path $($acl.Sddl)"
    }
  } elseif ($denyCount -ne 0) {
    throw "The directory-only deny reached a file: $path $($acl.Sddl)"
  }
}
$unexpected = $true
try {
  AssertInheritedResult '${child}' $true
  AssertInheritedResult '${rootFile}' $false
  AssertInheritedResult '${nestedFile}' $false
  $file = [P.F]::OpenFullControl('${rootFile}')
  "FILE: $file"
  $nestedFile = [P.F]::OpenFullControl('${nestedFile}')
  "NESTED-FILE: $nestedFile"
  $directory = [P.F]::OpenFullControl('${child}')
  "DIRECTORY: $directory"
  $unexpected = -not ($file.StartsWith('OK HANDLE=') -and $nestedFile.StartsWith('OK HANDLE=') -and $directory -eq 'DENIED WIN32=5')
} finally {
  if ($unexpected) {
    try { [P.F]::BackupPrivilegeStates() } catch { "PRIVILEGE-DIAGNOSTIC-ERROR: $_" }
    foreach ($path in @('${granted}', '${child}')) {
      try {
        $acl = Get-Acl -LiteralPath $path
        "ACL PATH=$path PROTECTED=$($acl.AreAccessRulesProtected) ORDERED-SDDL=$($acl.Sddl)"
      } catch { "ACL-DIAGNOSTIC-ERROR: $path $_" }
    }
  }
}
`
      const result = spawnSync('pwsh', ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', probe], { encoding: 'utf8', timeout: 60_000 })
      const diagnostics = `${setupDiagnostics}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      expect(result.error, diagnostics).toBeUndefined()
      expect(result.signal, diagnostics).toBeNull()
      expect(result.status, diagnostics).toBe(0)
      expect(result.stdout, diagnostics).toMatch(/^FILE: OK HANDLE=0x[0-9A-F]+\r?$/mu)
      expect(result.stdout, diagnostics).toMatch(/^NESTED-FILE: OK HANDLE=0x[0-9A-F]+\r?$/mu)
      expect(result.stdout, diagnostics).toMatch(/^DIRECTORY: DENIED WIN32=5\r?$/mu)
    } finally {
      grant.dispose()
      rmSync(granted, { recursive: true, force: true })
    }
  }, nativeProbeTimeout)

  it('revoking one of two grants on a directory leaves the shared Low label usable', () => {
    // Two capabilities may target one directory; the revoke of the first must
    // not strip the label the second one's child still writes through.
    const shared = join(scratchRoot, 'shared-root')
    mkdirSync(shared)
    const sidA = workspaceWriteSid(shared)
    const sidB = `${sidA}-1`
    const grantA = AclWriteGrant.create(sidA)
    const grantB = AclWriteGrant.create(sidB)
    grantA.add(shared, true)
    grantB.add(shared)
    try {
      grantB.dispose() // revokes B's ACE, must keep the shared label
      const target = join(shared, 'after-revoke.txt')
      const result = runRunner([
        '--workspace', shared, '--temp', isolatedTemp, '--mode', 'workspace-write',
        '--write-sid', sidA, '--temp-write-sid', tempWriteSid(isolatedTemp),
        '--', process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'written')", target,
      ])
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      expect(existsSync(target)).toBe(true)
    } finally {
      grantA.dispose()
      rmSync(shared, { recursive: true, force: true })
    }
  }, 60_000)

  it('the Low mandatory label closes the Everyone-Modify ambient boundary under BOTH modes', () => {
    // Everyone is a required keep-alive restricting SID: without it early DLL
    // initialization and CNG fail. A normal DACL that grants Everyone Modify
    // therefore also clears the WRITE_RESTRICTED pass-2 check. The Low label
    // still denies the write, because the kernel evaluates the integrity
    // policy inside the access check regardless of which right supplied the
    // authority.
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const target = join(worldWritableDir, `${mode}.txt`)
      const result = runRunner([
        '--workspace', writableDir, '--temp', isolatedTemp, '--mode', mode,
        '--', process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'written')", target,
      ])
      expect(result.status, `mode: ${mode}\nstderr: ${result.stderr}`).not.toBe(0)
      expect(existsSync(target), `mode: ${mode}`).toBe(false)
    }
  }, 30_000)

  it('partial boundary: a workspace hard link lets the grant reach an external file object', () => {
    // NTFS ACLs belong to the file object, not one pathname. Propagating the
    // workspace write-SID ACE through an existing hard-link alias therefore
    // grants the external alias too. pnpm workspaces commonly contain hard
    // links, so rejecting every multiply-linked file is not a viable profile.
    const hardlinkWorkspace = join(scratchRoot, 'hardlink-workspace')
    const hardlinkTemp = join(scratchRoot, 'hardlink-temp')
    const externalFile = join(scratchRoot, 'hardlink-target.txt')
    const workspaceLink = join(hardlinkWorkspace, 'hardlink-alias.txt')
    mkdirSync(hardlinkWorkspace)
    mkdirSync(hardlinkTemp)
    writeFileSync(externalFile, 'original')
    linkSync(externalFile, workspaceLink)
    const result = runRunner([
      // This workspace has not been granted before the alias exists: the first
      // recursive materialization reaches the shared file security descriptor.
      '--workspace', hardlinkWorkspace, '--temp', hardlinkTemp, '--mode', 'workspace-write',
      '--', process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'mutated')", workspaceLink,
    ])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(readFileSync(externalFile, 'utf8')).toBe('mutated')
  }, 30_000)

  it('runner-side failure: signature on stderr and exit 127, the command never runs', () => {
    const result = runRunner(['--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'workspace-write'])
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('windows-acl-run: ')
  }, 15_000)

  it('runner-side failure: seam-managed SID flags must be paired and match their owning paths', () => {
    const writeSid = workspaceWriteSid(writableDir)
    const tempSid = tempWriteSid(isolatedTemp)
    const cases = [
      ['--write-sid', writeSid],
      ['--write-sid', 'S-1-4-1-2', '--temp-write-sid', tempSid],
      ['--write-sid', writeSid, '--temp-write-sid', 'S-1-4-1-2-1'],
    ]
    for (const args of cases) {
      const result = runRunner([
        '--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'workspace-write',
        ...args,
        '--', process.execPath, '-e', 'process.exit(99)',
      ])
      expect(result.status, `args: ${args.join(' ')}\nstderr: ${result.stderr}`).toBe(127)
      expect(result.stderr).toContain('windows-acl-run: ')
    }
  }, 15_000)
})
