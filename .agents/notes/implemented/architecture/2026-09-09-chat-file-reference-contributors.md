# Agent Note: Chat file-reference contributors

Status: implemented

English | [中文](2026-09-09-chat-file-reference-contributors.zh.md)

## Problem

Deliverables owned the only closing-prose file resolver. A domain plugin could show a verified resource in a tool card but could not make that resource's name in the reply open the same preview without replacing the native resolver.

## Decision

Chat owns `chatFileMentions`. Plugins register effect-owned contributors with unique IDs. Each contributor reads the closing turn's projected facts and returns exact names, optional aliases, accessible labels, and preview callbacks. Chat resolves exact names before aliases and declines every ambiguous match.

The registry exposes a revision snapshot. Registration and disposal update that snapshot, re-render closing prose, and invalidate callbacks captured before the roster changed. Plugins remain responsible for checking the origin session, resource identity, and read authority when opening a reference.

Deliverables contributes successful mutation and presented paths from the same turn. Its prose callback uses the existing in-app file preview. Native application and file-manager actions remain explicit choices on the presented file card. Chat does not infer resources from filenames or issue playback grants itself.

## Alternatives considered

**Replacing the native resolver in each domain plugin** prevents composition and makes plugin order decide which resources remain clickable.

**Scanning all prose and looking up filenames** guesses identity, introduces reads during rendering, and loses the producing turn's resource version.

**Requiring present for every read** conflates inspecting an existing resource with declaring a delivered file. Read-only domain references do not require it.

## Consequences

Domain resources can reuse the native inline-code link appearance and their own existing preview without adding a player or a new model tool. Old replies can recover references from replayed tool facts; a filename alone is not authority. Two contributors naming the same resource remain ambiguous unless they publish one unambiguous spelling. This is intentionally conservative.

## Testing

Registry tests cover exact and alias matching, conflicts, duplicate provider IDs, revision notifications, and stale callbacks. Deliverables tests verify that prose opens in-app while explicit native actions retain their grant checks.
