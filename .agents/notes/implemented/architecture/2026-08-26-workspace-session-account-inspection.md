# Agent Note: Inspect durable Workspace Session accounts

Status: implemented

English | [中文](2026-08-26-workspace-session-account-inspection.zh.md)

## Problem

`Workspace.sessionIds` is intentionally a validated membership projection: a Session appears only when its id is in the durable candidate account and its indexed canonical header cwd equals the Workspace path. A missing header, unavailable cwd, or cwd mismatch must stay out of GUI grouping and Workspace inheritance. The [Workspace UI product-flow decision](../feature/2026-07-25-workspace-ui-product-flow.md) remains the owner of that membership and grouping contract.

That projection also hid the durable account itself. A host-side consumer could not distinguish a Session that had never been accounted from one whose account remained durable but whose cwd no longer validated after restart. Resolving from the current cwd could not recover the original Workspace when that cwd was missing or resolved elsewhere, and reading the storage domain directly would bypass the registry that owns its invariants.

## Decision

`WorkspaceRegistry.inspectSessionWorkspace(sessionId)` synchronously inspects the durable candidate accounts in registry order. It returns `undefined` when no account contains the Session id. An accounted id returns its existing `Workspace` entity and one coarse validation value: `valid` when the indexed canonical cwd equals the Workspace path, `cwd-unavailable` when the header or canonical cwd is unavailable, and `cwd-mismatch` when an indexed canonical cwd identifies another path.

Inspection uses the registry's startup/live header index and performs no persistence read, filesystem check, durable write, candidate pruning, or notification. It does not expose the raw header, failed cwd, validation reason, or complete candidate account. Current directory availability remains the uncached `Workspace.status()` operation.

`Workspace.sessionIds` retains its validated membership semantics. The storage schema, Session header, and Session event log remain unchanged. The Workspace package contributes no Tool, prompt text, or request field; because inspection is a public Cordis Service API, its signature and result type appear in the generated catalog discoverable through the deliberately opt-in `dsh-tool-cordis` composition.

## External Host integration

Built-in DSH flows continue to consume validated `Workspace.sessionIds`; this decision does not change Session-fork inheritance. External Host plugins use inspection when they need to diagnose or gate a durable binding without reading private storage or turning an invalid account into membership. Each consumer owns the follow-on policy for the three validation values and must test that composition at its own boundary.

## Alternatives considered

**Return every durable candidate through `Workspace.sessionIds`.** Rejected because GUI grouping and fork inheritance rely on that property meaning validated membership. Widening it would turn stale accounts into active membership.

**Resolve the Session header cwd with `resolveByPath()`.** Rejected because a missing path rejects and a retargeted symlink resolves to the new Workspace path, losing the durable account that the caller needs to inspect.

**Expose raw candidate ids or the Workspace storage table.** Rejected because callers could recreate membership policy, leak invalid cwd details, or mutate around the registry's uniqueness and ordering checks. The coarse result is sufficient for Host consumers that need this distinction.

**Refresh persistence and the filesystem on every inspection.** Rejected because an async call would imply freshness that this registry does not otherwise provide. Header-index refresh remains tied to startup and uncached persisted-session attachment; live directory status has its own operation.

## Verification

Workspace tests cover valid, mismatched, missing-header, cwd-less, missing-directory, non-directory, and unaccounted Sessions; they verify that inspection neither prunes the stored account nor emits a domain change. Cold-start tests retain the durable account when its directory disappears and report a symlink retarget as `cwd-mismatch`. A defensive test rejects externally diverged table/entity state, and focused coverage holds the changed Workspace source at 100% statements, branches, functions, and lines. A Tool-Cordis regression test proves an exact `workspaceRegistry` catalog query returns `WorkspaceSessionInspection`; the runtime-catalog generator preserves the regular expression's escaped word boundaries so referenced type closure is not silently empty.

## Consequences

Host plugins can distinguish no durable account from an account whose cwd validation failed without changing grouping semantics or reading private storage. They must still combine the inspection with `Workspace.status()` when current directory availability matters, and they observe cross-process cwd damage only after the existing header index refresh or restart. The new public method and result type become a maintained package contract in exchange for keeping storage ownership and membership policy in one registry.
