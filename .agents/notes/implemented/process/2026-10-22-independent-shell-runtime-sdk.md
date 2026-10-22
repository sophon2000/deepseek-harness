# Agent Note: Runtime SDK for independently maintained desktop shells

Status: implemented

English | [中文](2026-10-22-independent-shell-runtime-sdk.zh.md)

## Problem

The first artifact SDK fixed runtime inputs but also shipped the fork's compiled Electron shell. A product could package independently while still depending on the fork for every shell change. The shell compiler also read workspace-only UI source paths and shared the Host protocol through private local declarations.

## Decision

Runtime SDK version 2 retains prepared interpreters, Electron, packed DSH and Host packages, runtime composition and verification. It excludes shell bundles, renderer assets and the entire runtime CLI directory. Independent distributions own their shell compiler, artwork, CLI, packaging and release configuration. The upstream shell and its tests remain in the fork so upstream synchronization does not require repeatedly restoring deleted directories.

The SDK supplies fixed shell dependencies with complete declaration imports and a generated runtime-contract package compiled from the existing descriptor implementations. The Desktop Host owns its shared IPC messages and validators through its protocol export; the upstream and independent shells consume the same entry. Theme stylesheet and font exports refer to shipped library assets. Every SDK records source identity and verified runtime build identity; a changed Host or UI package requires rebuilding and repacking before export.

## Alternatives considered

**Keep shipping the compiled shell as the product input.** This leaves product shell changes owned by the fork and does not complete the ownership transfer.

**Delete the upstream shell from the fork.** This adds recurring upstream merge conflicts and breaks useful upstream integration tests. Product builds stop consuming that shell instead.

**Copy validators and IPC types into the new shell.** This creates competing interpretations of runtime metadata and Host messages. The SDK and Host package remain their owners.

## Consequences

The first [artifact SDK decision](2026-10-22-desktop-artifact-sdk.md) still governs fixed archive consumption and dependency locks; the version 2 ownership and output rules replace its compiled-shell export. Runtime preparation leaves a minimal application manifest for the distribution to replace after composition. The distribution must compile, assemble and seal its own shell before verifying a packaged application. The SDK's runtime smoke does not qualify graphical shell behavior.
