---
kind: upgrade-guide
description: "The local candidate tightens Host requests and tool dispatch and requires matched desktop and Video packages."
---

# Match plugins to the local runtime candidate

English | [中文](guide.zh.md)

## Change

Local candidate `0.2.1-rc.2.vh.1.local.20261018.1` is based on official `0.2.1-rc.2`; it is neither an official npm release nor permission to replace production.

Generated LIB Host JSON parameters and lookup keys prefer `strictCodec`, rejecting undeclared fields. Ordinary result codecs remain unchanged. SRC/manual descriptors without `strictCodec` retain ordinary-codec fallback; regenerate descriptors for strict requests. See [gateway](../../../../packages/api/gateway/src/index.ts) and [generator](../../../../packages/typert/generator/src/renderer.ts).

`ToolDefinition.validateArgs` checks snapshotted arguments before `tools/pre-execute`, including approval policy. Invalid input becomes `ToolArgsError` / `INVALID_ARGS`. Final guards await serially; allow cannot overwrite deny. Guard and body must pass the same execution object to `workingDirectory.ensureForExecution`; copies lose the shared directory observation. See [tools](../../../../packages/core/tools/src/index.ts) and [working-directory](../../../../packages/session/working-directory/src/index.ts).

Desktop packaging requires physical `resources/dsh`. Matched Video plugins supply default-local public workspace admission, nine local tool-image Factory registrations, and legacy prose-mention retirement. Installing upstream DSH alone does not supply these. Legacy workspace recovery retains its explicit compatibility adapter.

### Dynamically resolved tools

The follow-on candidate preserves unknown-name observation in `tools/pre-execute`, where policy may register a tool. Only `ask` triggers authoritative scoped resolution again before approval. Still-unknown names return `UNKNOWN_TOOL` without prompting. New/replaced definitions or replaced `validateArgs` callbacks are validated before prompting; invalid arguments return `INVALID_ARGS`. Unchanged validators are not called twice at this boundary.

Caller cancellation takes priority. Policy `deny`, `cancel`, and `allow` paths remain unchanged; dispatch resolves again after approval. Tools without validators gain no strict schema validation. Validator identity cannot detect changes inside unchanged callbacks; mutable authorization belongs in execution-time guards.

## Migration

1. Obtain the complete candidate and matched Video plugins. Verify manifest versions/integrity, pin consuming `package.json` DSH dependencies to `0.2.1-rc.2.vh.1.local.20261018.1`, and regenerate the lockfile. Do not mix old fork packages, floating versions, or another checkout's `node_modules`. Retain the previous installation for rollback.
2. Regenerate/rebuild Host descriptors with the matched generator. Remove undeclared caller fields without weakening schemas or pre-validation stripping. Verify malformed nested JSON/lookup keys fail before invocation and valid results decode normally.
3. Register validators on owned tools; retain execution-time checks, await guards, and share the execution object with the directory-consuming body. Verify invalid arguments never prompt, deny prevents dispatch, and Session directory changes cannot redirect admitted execution. Test unknown-name observation without prompting, valid policy-time registration with approval, invalid dynamic arguments without approval, and scoped removal before approval.
4. Test matched Video plugins in a disposable profile: default local works without `inspectSessionWorkspace`, cross-workspace access fails, images render, and legacy prose mentions stay inactive. Enable legacy recovery only with its adapter.
5. Verify packaged desktop `resources/dsh` and its launched profile. Require installed-package, Host/client, and desktop smoke results before switching real work; source tests alone do not qualify the installation.
