# Agent Note: Resolve installed Typert Remote types

Status: implemented

English | [中文](2026-08-31-installed-typert-remote-types.zh.md)

## Problem

Out-of-tree plugins consume installed DSH declarations rather than workspace source. Restricting Remote protocol identity and named lookup wire types to workspace registrations prevents those plugins from generating scoped Remote declarations even when their dependencies publish the required types.

## Decision

The analyzer recognizes protocol declarations owned by the installed `@deepseek-ai/dsh-typert-protocol` package. Package identity requires the resolved node_modules path and package manifest name to agree. Other package names do not acquire protocol semantics through matching declaration names.

Installed named wire types use concrete public non-root exports resolved inside their owning package. The exported module must already be part of the compiler program, and its exported symbol must resolve to the original declaration. Generated type imports select deterministically among eligible exports. Root-only named wire types fail generation; wildcard export discovery is not added.

## Alternatives considered

**Require DSH workspace sources.** Rejected because independently installed plugins must generate artifacts without a DSH source checkout.

**Use package roots or private declaration paths.** Rejected because generated clients would depend on host-oriented entry points or unpublished file layout instead of the package's explicit type exports.

## Consequences

Installed lookup and context wire types retain public declaration identity without changing runtime authorization or codec openness. Package publishers must expose reachable concrete type subpaths. The generator tests cover installed lookup/context metadata, canonical generated imports, root-only rejection, and differently named protocol packages; this change does not establish a new package release or runtime compatibility qualification.
