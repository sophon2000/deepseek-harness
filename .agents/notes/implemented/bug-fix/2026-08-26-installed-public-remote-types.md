# Agent Note: Resolve installed Remote types through public subpaths

Status: implemented

English | [中文](2026-08-26-installed-public-remote-types.zh.md)

## Problem

A project outside the DeepSeek Harness workspace can declare a Remote method on an Agent-scoped Service while importing `Agent` and its `SessionId` wire type from installed Harness packages. Once Typert recognizes the installed protocol metadata, lookup and Context analysis still rejects `SessionId` because named Remote boundary types are accepted only from packages registered in the analyzed workspace.

Replacing the `Agent` parameter with a caller-supplied string would remove the lookup, Context, and Agent Scope semantics that resolve and authorize the live Agent. Copying the ID type into the consumer would give the same wire value a second declaration identity.

## Decision

An installed NPM dependency may provide a named Remote boundary type when its physical `node_modules` path and manifest name agree and a concrete public non-root `package.json#exports` subpath exposes the resolved symbol. Root entries, package metadata, generated Typert entries, Remote entries, and pattern targets remain ineligible, matching the workspace package rule. The canonical `typeSymbol` and generated type import use the selected package subpath and exported name.

The dependency remains external to workspace registration and its declarations are not expanded into the workspace type graph. External reference targets retain the resolved `SymbolId`, allowing the Remote declaration renderer to replace authored aliases with the generated import name and to keep same-named imports distinct.

## Alternatives considered

**Pass an ID instead of an Agent.** Rejected because it moves lookup and authority into business code and removes the standard Agent-scoped projection.

**Accept the package root as the canonical type entry.** Rejected because roots may carry Host runtime declarations or Cordis merges and do not provide the type-only consumer entry required by Remote declarations.

**Register installed dependencies as workspace packages.** Rejected because workspace registration represents project ownership and compiler-face membership; an installed dependency contributes only an external public symbol.

**Copy or alias the wire type in the consumer project.** Rejected because a second declaration can drift and loses navigation to the package-owned business identity.

## Verification

Generator tests install protocol, Agent, and identity packages outside the fixture workspace and require the Remote model and declaration to use the identity package's public type subpath. Negative coverage rejects a root-only type; alias and same-export-name cases require the declaration to typecheck with collision-free generated names. Renderer coverage verifies that external symbol references consume the generated name map.

## Consequences

Published plugins can retain the official `Agent` parameter and Agent Scope design when Typert analyzes them from another project. Their wire types need a concrete public type-only subpath; packages exposing an ID only from the root must add such an entry or generation fails. The compiler-independent type graph carries opaque identity for external references without treating those declarations as workspace-owned.
