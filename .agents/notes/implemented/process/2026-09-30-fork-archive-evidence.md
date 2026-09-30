# Agent Note: Immutable fork archive evidence

Status: implemented

English | [中文](2026-09-30-fork-archive-evidence.zh.md)

## Problem

The fork integration captured 14 branch archive candidates and 33 remote references before publication. Release tags cannot replace these exact observed commit identities: the snapshot records proposed tags that were not created, an empty branch-deletion list, and the authentication limitations at capture time. The [maintained-reference policy](2026-09-12-maintained-repository-references.md) rejects these identifiers in ordinary maintained files.

## Decision

Preserve the original JSON bytes in [the dated historical snapshot](../../../../docs/history/2026-09-30-fork-archive-manifest.json). The [reference gate](../../../../scripts/verify-repository-references.ts) requires this exact path and its fixed SHA-256 seal before allowing its historical commit identifiers. The exception changes neither organization URL checking nor any other file's commit-reference policy; it grants no branch-deletion or tag-creation authority.

The seal covers every field, record, and byte, including historical status. Missing or changed evidence fails independently of available Git history. Do not update this snapshot or refresh its seal to describe current state. A later capture requires a separately reviewed policy change naming its exact path, original content seal, and integrity tests; a directory-wide exclusion is forbidden.

## Alternatives considered

**Use the frozen Agent Note tree.** Its archive accepts only existing implemented bilingual triplets, not raw JSON evidence. The snapshot stays separate from those artifacts and their immutable seals.

**Exclude an entire history directory.** Unrelated files could then retain prohibited references. Only the exact sealed snapshot permits commit identifiers.

**Check only record counts.** Replacement identities and altered capture status could preserve the counts. A fixed content digest detects every change while retaining the full original evidence.

## Consequences

The snapshot remains a historical observation, not current remote state or an instruction to clean branches. Tests check the 14 candidates and 33 references, reject deletion and alteration, and prove adjacent files and copied evidence remain subject to the maintained-reference policy. The general reference policy remains active and independently useful.
