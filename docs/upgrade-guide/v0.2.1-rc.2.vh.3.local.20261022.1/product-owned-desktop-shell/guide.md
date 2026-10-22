---
kind: upgrade-guide
description: Packaged product runtimes require a product-owned desktop shell instead of DSH Desktop.
---

# Product-owned desktop shell

English | [中文](guide.zh.md)

## Change

DSH Desktop starts its shared Host directly and rejects packaged runtimes with a product descriptor. It no longer runs product preflight or background services, injects their environment, or checks product-required services. Video owns this lifecycle in `video-desktop`. Desktop SDK runtime preparation and product descriptors remain supported; development profile activation is unchanged.

## Migration

1. Package and launch Video through `video-desktop`, not the DSH Electron shell.
2. Keep product preflight, service startup, environment forwarding, required-service checks, and ordered shutdown in the product-owned shell. Continue using the Desktop SDK preparation scripts and runtime descriptors.
3. Verify the product application completes preflight before starting its Host, rejects missing required services, and stops its children before exiting. Verify ordinary DSH Desktop starts without a product descriptor.
