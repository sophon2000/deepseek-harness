# Agent Note: Tool arguments are validated before approval

Status: implemented

English | [中文](2026-09-05-tool-argument-validation-before-approval.zh.md)

## Problem

`defineTool` validated model arguments only inside `execute`, after `tools/pre-execute` and `ctx.approval`. A malformed write call could therefore consume an `allowed-once` decision, fail argument validation without executing, and leave a corrected retry waiting for another approval. The approval described a call that could never execute, and approval state no longer corresponded to a valid operation.

## Decision

`ToolDefinition` has an optional synchronous `validateArgs(args)` callback. `ToolRuntime` invokes it after lossless argument materialization and the initial cancellation check, but before `tools/pre-execute`, approval, guards, or dispatch. A thrown validation error becomes the normal final tool error and none of those policy stages observes the call.

`defineTool` supplies `validateArgs` from its compiled parameter schema and retains the same validation inside `execute` as defense in depth. Raw definitions may omit the callback when an external provider, such as an MCP server, owns validation during execution. A raw provider can opt in without adopting the `defineTool` schema DSL.

The executor test proves that invalid `defineTool` arguments produce `INVALID_ARGS` without invoking policy or approval. The authored `tool-invalid-args-before-approval` headless snapshot boots the shipped profile with a `PreToolUse` hook that would ask for approval, replays a malformed Bash call, and records `INVALID_ARGS` without any hook or approval event. Existing approval coverage proves that a valid call still requests one approval and executes after `allowed-once`.

## Alternatives considered

**Validate in permission plugins.** This duplicates every tool schema in a policy consumer, depends on listener order, and leaves alternate executor callers exposed.

**Refund an approval after execution rejects arguments.** The approval service cannot distinguish argument failures from other tool failures without coupling itself to tool implementation details, and the user still approves an invalid operation.

**Require every raw definition to validate before approval.** MCP and other external providers own their execution-time validation. Making the callback mandatory would add an adapter compatibility change without improving tools that do not request approval.

## Consequences

- Invalid first-party calls fail before policy and never consume one-shot approval.
- Valid calls retain the existing policy, approval, guard, dispatch, and result sequence.
- Tool providers that register raw definitions must add `validateArgs` when pre-approval validation matters; omission preserves execution-time provider validation.
- `execute` remains the final enforcement point, so direct body implementations do not rely exclusively on preflight validation.
