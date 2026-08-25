# Agent Note: Recognize installed Typert protocol metadata by package identity

Status: implemented

English | [中文](2026-08-25-installed-typert-protocol-identity.zh.md)

## Problem

The Typert generator can analyze a project outside the DeepSeek Harness workspace while that project imports `Remote` and `TypertRemoteService` from the published `@deepseek-ai/dsh-typert-protocol` package. Lexical discovery sees those names, but the identity check accepts only protocol declarations registered inside the current workspace or declarations nested in an ambient module with the protocol package name. Normal declarations installed under `node_modules` satisfy neither case, so valid Remote metadata is silently ignored and Remote artifact publication can later fail because the package appears to expose no Remote methods.

Consumer-side ambient declarations can bridge the missing identity, but they duplicate a subset of the protocol package and can drift whenever its exports change.

## Decision

Protocol metadata identity also accepts declarations whose source file resolves to the exact external package `@deepseek-ai/dsh-typert-protocol`. The analyzer uses the same external-module identity resolver that already understands ordinary and pnpm-style `node_modules` paths. This check does not register the dependency as a workspace package or expand its declarations into the workspace type graph.

Workspace registrations and the existing ambient-module form remain valid. A different dependency that exports declarations named `Remote`, `RemoteScope`, or `TypertRemoteService` does not pass the package identity check.

## Alternatives considered

**Accept metadata by exported name.** Rejected because unrelated libraries can export the same names and would then gain compiler-significant Typert behavior.

**Register protocol packages found anywhere under `node_modules`.** Rejected because workspace registration describes project ownership and compiler-face membership, while the installed protocol is only an external metadata authority. Expanding registration would blur that boundary and increase the analyzed surface.

**Require every tree-out consumer to provide an ambient declaration shim.** Rejected because the shim duplicates official declarations, can mask published-package compatibility defects, and must be updated when the protocol API changes.

## Verification

Generator tests create an installed protocol package without a TypeScript `paths` redirect or ambient module, import its metadata from a separate consumer project, and require Remote artifacts to be generated. A companion lookalike-package case proves that matching exported names without the official package identity remains insufficient.

## Consequences

Published consumers can generate Remote artifacts directly from the installed protocol package, including pnpm layouts, without a local identity shim. Protocol declarations remain external type references, and the generator's workspace ownership rules are unchanged. Consumers using a temporary ambient bridge can remove it only after they consume a generator containing this behavior and rebuild artifacts from a clean output directory.
