# Agent Note: Desktop artifact SDK for independent distribution

Status: implemented

English | [中文](2026-10-22-desktop-artifact-sdk.zh.md)

## Problem

Desktop packaging compiled the whole Harness checkout and read workspace manifests, source imports and patches while composing a product payload. An independently maintained product distributor could not consume a fixed Harness release without retaining a source checkout and its build environment.

## Decision

The producer exports a target-specific SDK containing the compiled shell, packed runtime packages, prepared interpreters, Electron and executable packaging tools. Tooling keeps its resource-relative layout and resolves copied package dependencies entirely inside the SDK. The exporter verifies the client artifact record and records its runtime commit separately from the tooling checkout identity; uncommitted tooling inputs retain their digests and are never described as clean.

The distributor verifies and locks the SDK archive and product payload, composes them in a fresh directory, and supplies a qualified production dependency lock for release builds. Discovery can resolve that lock, but a supplied lock never falls back to resolution. Existing core tarball, patch, runtime-integrity and Host smoke checks remain in the composed path. Product resource links are validated against the resource root and materialized before sealing; the runtime inventory continues to reject links. The smoke profile uses a canonical temporary home so macOS temporary-directory aliases do not violate a product's canonical storage requirement.

## Alternatives considered

**Copy the complete source checkout.** This retains source builds and workspace resolution in the distributor and does not establish fixed artifact consumption.

**Move the entire Electron shell immediately.** Shell, Host lifecycle and core APIs still evolve together. Keeping their source owner while exporting executable tools avoids a second implementation during the first distribution split.

**Resolve npm ranges on every release build.** Identical first-party inputs could select different third-party dependencies. A separately qualified composition lock fixes that input as well.

## Consequences

The product distributor owns branding, installers and release policy without compiling Harness. SDK exports remain target-specific and depend on successful producer preparation; they are not signed installer releases. Changes to the shell or Host still require a new qualified SDK. macOS arm64 is the initial supported export target. Signing, notarization, graphical workflow acceptance and other platforms retain their own qualification requirements. Operational commands and failure guarantees are documented in the [SDK reference](../../../../apps/desktop/scripts/sdk/README.md).
