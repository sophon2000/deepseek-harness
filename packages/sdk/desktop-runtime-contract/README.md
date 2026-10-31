---
description: "Validate Desktop runtime resources and compose distributor profiles through shared APIs."
kind: "package-library"
---

# @deepseek-ai/dsh-desktop-runtime-contract

English | [中文](README.zh.md)

## Summary

Shell adapters and Desktop distributors use this private package to validate releases, runtime inventories and product descriptors, and to compose plugin profiles. Import the named subpaths from the package rather than copying validation into a product shell. The package registers no plugins and is not installed into the default DSH runtime.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The [export map](package.json) preserves the runtime-tree, release, host-protocol, desktop-product, core-package-set and project-profile subpaths consumed by independent shells. Runtime and declaration files come from the same workspace build. The [Desktop Runtime SDK exporter](../../../apps/desktop/scripts/sdk/README.md) includes the private package's packed outputs and its dependency closure; it does not synthesize another implementation from shell sources.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [runtime APIs](src/index.ts) own integrity inventory, release compatibility, generic product declarations and profile composition. Desktop's former source locations forward to these APIs. The [tooling directory](tooling) owns resource materialization, runtime lock retention, patch selection and application, manifest normalization, packaged-runtime checks and versioned distributor entry generation. Its source is recursively compiled or copied into source-free archives, not installed as a DSH plugin.

The [product-process runner](testing/product-process.ts) belongs to distributor acceptance tests. Prepared-runtime smoke uses it to verify declared service or preflight readiness and teardown; the official shell does not launch it. This owner retains the existing IPC validation, environment filtering, deadlines and process shutdown behavior.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop Runtime SDK](../../../apps/desktop/scripts/sdk/README.md) — archive preparation and qualification.
- [Desktop application](../../../apps/desktop/README.md) — official shell lifecycle.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Official preparation orchestration remains in Desktop.** Its package selection, build paths, signing, Host adapter and aggregate smoke still depend on the official application and repository release helpers. Moving these requires explicit producer inputs; this package does not claim to replace that orchestration.
- **Private distribution only.** This package is packed explicitly for Desktop Runtime SDK exports, not published by the npm release family. The archive schema, distributor API version and Host protocol remain independently versioned.

<a id="dev-note"></a>
### Dev Note

None.
