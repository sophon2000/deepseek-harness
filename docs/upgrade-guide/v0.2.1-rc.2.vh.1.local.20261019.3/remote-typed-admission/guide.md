---
kind: upgrade-guide
description: "Profiles that require typed Remote definitions refuse missing, source-only or replaced Host definitions."
---

# Require current typed Remote definitions

English | [中文](guide.zh.md)

## Change

Gateway config `requireTypedDefinitions: true` disables business SRC fallback, including endpoints whose Host export never registered successfully. It refuses missing or source-only definitions before lookup and refuses a captured definition replaced or removed during asynchronous lookup before business invocation. The default remains `false`; existing ordinary Profiles keep SRC compatibility. The policy covers unary and stream calls and preserves Gateway-owned event-control validation and already executing calls.

## Migration

1. Register the business package's working `./typert` Host export with Typert Loader, including strict parameter, result, Context and declared uplink codecs, before enabling `requireTypedDefinitions` on the Profile's Gateway row.
2. Use a matching new runtime. Product startup can require `ctx.typertGateway.requiresTypedDefinitions === true`; an older runtime may ignore an unknown config field and does not provide this enforcement. Existing immutable packages are not upgraded by editing a patch file.
3. Verify valid typed unary and stream calls, then withdraw the definitions while leaving the SRC service active. Calls must return `gateway/definition-unavailable` without entering lookup or business code. A request already paused in lookup must fail if its definition is withdrawn or replaced before dispatch.
