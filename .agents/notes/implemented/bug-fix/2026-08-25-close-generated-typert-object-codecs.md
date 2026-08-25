# Agent Note: Close generated Typert object codecs

Status: implemented

English | [中文](2026-08-25-close-generated-typert-object-codecs.zh.md)

## Problem

Typert labels compiler-generated Remote codecs as `strict`, but fixed-property TypeScript objects were emitted with Zod's default `z.object`. That parser accepts unknown properties and removes them from its result. Both the Client encoder and Host decoder therefore converted a payload such as `{ title, projectId }` into `{ title }`, allowing an undeclared identity or policy field to disappear before business code or a downstream canonical validator could reject it.

The same behavior applied recursively to nested DTOs and to generated result schemas. Explicitly open types such as `Record<string, Value>` and JSON index signatures require different behavior because their dynamic keys are part of the declared type.

## Decision

The Typert Zod emitter uses `z.strictObject` for every object declaration or object literal with fixed JSON properties. Unknown properties fail at the Client and Host codecs, including inside nested objects and generated results, instead of being normalized away.

`Record`, explicit JSON index signatures, the `object`, `unknown`, and `any` keywords, and unique-symbol-only nominal markers retain their existing open or erased semantics. A fixed-property object combined with an index signature remains open only to keys accepted by that index schema. SRC `src-json` codecs remain permissive because they do not have compiler-derived property information.

## Alternatives considered

**Compare parsed and original values in the Host Gateway.** Rejected because the Client codec could still remove properties before transport, the Gateway would duplicate schema semantics, and recursive comparison would need to reproduce Zod transformations and index-signature behavior.

**Emit passthrough objects.** Rejected because preserving undeclared properties would avoid silent deletion but would let strict Remote methods receive fields absent from their generated contract.

**Close only the top-level Remote request.** Rejected because nested DTOs and generated result schemas would still discard unknown properties, and exported Typert schemas would behave differently from Remote schemas built from the same type graph.

## Verification

Generator tests execute emitted schemas and cover fixed objects, nested objects, inheritance, intersections, empty DTOs, `Record`, pure index signatures, and fixed properties combined with an index signature. A generated Remote artifact rejects outer `projectId`, nested `tenantId`, and an unknown result property. Client runtime coverage proves that an unknown request property reaches no carrier call; Gateway runtime coverage sends the outer and nested forged fields through a strict descriptor and proves that the business implementation records no call. The built-LIB integration test additionally crosses the real HTTP route with generated Client and Host bundles, rejects both a Client-side `projectId` and a raw forged Host-side `tenantId`, and leaves goal state and session events unchanged.

## Consequences

Adding an undeclared property to a generated strict object is a validation error rather than a forward-compatible no-op. Remote DTO evolution must therefore add the property to the public TypeScript type and rebuild both generated artifacts before callers send it. Authors who intend arbitrary keys must state that intent with an index signature, `Record`, or another explicitly open type.
