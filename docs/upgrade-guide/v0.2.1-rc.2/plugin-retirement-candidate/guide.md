---
kind: upgrade-guide
description: "The local plugin-retirement candidate tightens generated Host requests and tool dispatch, and requires a matched desktop runtime and Video plugin set."
---

# Match plugins to the local runtime candidate

English | [中文](guide.zh.md)

## Change

This guide applies to the local candidate `0.2.1-rc.2.vh.1.local.20261018.1`, based on official `0.2.1-rc.2`; it is not an official npm release or permission to replace a production installation.

Generated LIB Host JSON parameters and lookup keys prefer `strictCodec`, rejecting undeclared request fields instead of silently projecting them away. Ordinary result codecs are unchanged. SRC and manually registered descriptors without `strictCodec` retain their ordinary-codec fallback; rebuilding generated descriptors is required to obtain strict request validation. See the [gateway](../../../../packages/api/gateway/src/index.ts) and [generator](../../../../packages/typert/generator/src/renderer.ts).

`ToolDefinition.validateArgs` runs on snapshotted arguments before `tools/pre-execute`, including approval policy. Invalid input is normalized to `ToolArgsError` / `INVALID_ARGS`. Final guards are awaited serially; a denial cannot be overwritten by an allow decision. Guards and the body must share the same execution object when calling `workingDirectory.ensureForExecution`; copying it loses the shared directory observation. See [tools](../../../../packages/core/tools/src/index.ts) and [working-directory](../../../../packages/session/working-directory/src/index.ts).

The desktop candidate requires a physical `resources/dsh` runtime tree. The matched Video plugin owns default-local public workspace admission, the nine local tool-image Factory registrations, and retirement of legacy prose mentions; these changes are not supplied by installing upstream DSH alone. Legacy workspace recovery still requires its explicit compatibility adapter.

### Approval for dynamically resolved tools

The follow-on local candidate retains the official policy window: unknown names still reach `tools/pre-execute`, where a policy may register a legitimate tool. Only an `ask` decision triggers authoritative scoped resolution again before approval. A still-unknown tool returns `UNKNOWN_TOOL` without prompting; a newly registered or replaced definition, or a replaced `validateArgs` callback, is validated before prompting and invalid input returns `INVALID_ARGS`. An unchanged validator is not called twice at this boundary. Caller cancellation takes priority; policy `deny`, `cancel`, and `allow` retain their existing paths, and dispatch still resolves the tool again after approval. This does not add strict schema validation to tools without a validator, or prevent policies from observing unknown names.

Verify unknown-name policy observation with zero approval requests, valid policy-time registration with normal approval, invalid dynamic arguments with zero approval requests, and scoped removal before approval. Preserve execution-time checks: validator identity checks do not detect state changes inside an unchanged callback; mutable authorization belongs in a guard.

## Migration

1. Obtain the complete local candidate package set and its matched Video plugin from the integration owner. Verify versions and package integrity against the supplied manifest. Pin DSH package dependencies to `0.2.1-rc.2.vh.1.local.20261018.1` in the consuming `package.json` and regenerate its lockfile from that set. Do not mix old fork packages, floating versions, or another checkout's `node_modules`; retain the previous complete installation for rollback.
2. Regenerate and rebuild Host descriptors with the matched Typert generator. Remove undeclared JSON request fields in callers; do not weaken schemas or strip unexpected fields before validation. Verify malformed nested JSON and lookup keys fail before the target method, while valid results still decode normally.
3. Register argument validators on locally owned tools. Keep execution-time enforcement, await asynchronous guards, and pass the actual execution object to `ensureForExecution` in both the guard and directory-consuming body. Verify invalid arguments never reach approval, denial prevents dispatch, and a later Session directory change does not redirect an admitted execution.
4. Install the matched Video plugin in a disposable profile first. Confirm default local mode works without `inspectSessionWorkspace`, cross-workspace requests fail, tool images render, and legacy prose mentions no longer activate. Do not enable legacy recovery without its required adapter.
5. Validate the packaged desktop's physical `resources/dsh` tree and launched profile. Require the integration owner's installed-package, Host/client, and desktop smoke results before switching real work; passing source tests alone is insufficient.
