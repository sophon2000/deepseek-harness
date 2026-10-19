---
kind: upgrade-guide
description: "Desktop product preflight and required Host services use product payload schema version 2."
---

# Declare Desktop resource preparation

English | [中文](guide.zh.md)

## Change

Desktop product payloads with `preflight` or `requiredServices` use `desktop-product.json` schema version 2. Older builders reject version 2. Version 1 service payloads remain supported, but cannot declare either new field.

`preflight` uses the same entrypoint, environment allowlist and optional readiness deadline as `service`. It must report one ready IPC event and exit successfully before the Host starts. A background service remains running after ready; declaring both forms is rejected. Cancellation waits for child and stdio closure.

`requiredServices` lists Cordis service keys that must exist after profile boot and before Desktop Host readiness. Missing services fail startup; optional plugin warnings cannot satisfy the requirement. The default without this field requires no product service.

## Migration

1. For an exiting resource check, set `schemaVersion: 2`, replace `service` with `preflight`, retain its exact environment allowlist, and disconnect IPC after the ready event has been sent and all checking children have closed.
2. Add product service keys such as `requiredServices: ["projectBff"]`. Use a matching Desktop runtime built with schema 2 support; preserve immutable earlier artifacts.
3. Verify missing resources, malformed ready data, nonzero exit after ready and cancellation all prevent Host creation. Verify a missing required Host service prevents Desktop ready. Background legacy services retain their existing shutdown and update checks.
