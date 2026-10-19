---
kind: upgrade-guide
description: "Generated Host scoped-context identities and client-to-Host stream messages reject undeclared fields."
---

# Rebuild strict context and stream admission

English | [中文](guide.zh.md)

## Change

Generated LIB descriptors now provide an optional `strictCodec` for scoped-context identities and client-to-Host stream uplinks. Host admission prefers this codec before resolving the scoped target or delivering the uplink message. Previously these paths used the ordinary codec, which could accept an object while stripping undeclared fields. Callers that send extra root or nested fields now receive validation failures.

Ordinary codecs and result decoding retain their existing behavior. SRC and manually registered descriptors without `strictCodec` retain ordinary-codec fallback. Updating the Host alone does not make older generated descriptors strict: the corresponding metadata must also be regenerated. See the [Typert contract](../../../subsystems/typert.md).

## Migration

1. Obtain a complete matched candidate release and verify its manifest and integrity. Keep all DSH package pins and the profile's runtime on the same candidate version; do not overwrite an existing version with rebuilt bytes. Install the matched Reader and Video packages where those integrations are used.
2. Regenerate Host and remote-client descriptors with the matched `@deepseek-ai/dsh-typert-generator`, then rebuild the packages and any bundles that embed their generated metadata. Include scoped-context methods and bidirectional streams; replacing only `@deepseek-ai/dsh-api-gateway` is insufficient.
3. Remove undeclared fields from caller request construction according to the declared identity or uplink type. Preserve legitimate indexed-object keys and intersection fields. Do not add a pre-validation stripping step or weaken the schema to make invalid messages succeed.
4. Inspect the generated context invocation and uplink descriptors for `strictCodec`. Test valid messages, unknown root and nested fields, invalid known-field types, and valid indexed intersections through the real packaged Host. Invalid context identities must not resolve the target; invalid uplinks must not reach the receiving stream.
5. Recheck ordinary result decoding and SRC/manual fallback separately. Complete strict consumer type checks, installed-package identity checks, and application profile tests before replacing the prior working installation.
