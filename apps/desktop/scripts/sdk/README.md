# Desktop Runtime SDK export

English | [中文](README.zh.md)

The `dsh.desktop-sdk/2` archive supplies the fixed DSH runtime, private Desktop Host, prepared Electron and interpreters, executable preparation tools, patch metadata and verification fixtures. It excludes Electron shell bundles, renderers, product artwork and `runtime/cli`. The upstream shell remains in this fork; an independent distribution owns its own shell source, compiler configuration, CLI, signing and installers.

Run these producer commands from the DSH repository root with its pinned dependencies installed on an Apple Silicon Mac. Build after committing source changes so the runtime artifact record and exported source identity name the same clean revision:

```sh
pnpm run build:official
pnpm run release:pack --family dsh --out apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh --concurrency 6
pnpm run release:pack --family vendor --out apps/desktop/.desktop-build/targets/mac-arm64/packed/vendor --concurrency 6
pnpm --dir apps/desktop-host pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh"
pnpm --dir native/system/packages/entry pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/landlock"
pnpm --dir native/system/packages/darwin-arm64 pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/landlock"
DSH_DESKTOP_UNSIGNED=1 DSH_DESKTOP_TARGET_PLATFORM=darwin DSH_DESKTOP_TARGET_ARCH=arm64 pnpm --dir apps/desktop run prepare:runtime
node apps/desktop/scripts/export-desktop-sdk.mjs --output /absolute/new-sdk-directory --target mac-arm64
```

The output must not exist. A failed export leaves a partial directory without a completed `dsh-desktop-sdk.json`. Archive the directory without dereferencing symbolic links and pin its digest in the distributor. The manifest records the source commit/tree, dirty input digests, the artifact-verified runtime build record, Electron version and Host protocol version. Export refuses shell-owned output paths.

`shell-build/node_modules` contains the exact DSH packages required to compile a shell, including their declaration imports and the five upstream shell production dependencies. `shell-dependencies.json` records roots, packed-package paths, versions and digests. The distributor owns its pinned TypeScript, tsdown, Vite, React and Electron builder configuration; it must not infer that this SDK provides that compiler toolchain. The SDK retains its fixed Electron builder dependency closure for packaging consumers, and links the minimal app production dependencies inside the exported app directory.

The SDK-generated `@deepseek-ai/dsh-desktop-runtime-contract` package exports `./runtime-tree`, `./release`, `./host-protocol`, `./desktop-product`, `./core-package-set` and `./project-profile` as compiled JavaScript and declarations from the fork's existing implementation. Shell adapters import these APIs instead of duplicating descriptor validation. `@deepseek-ai/dsh-desktop-host/protocol` supplies shared Host events, control requests, validators and the protocol version. Theme CSS and licensed fonts use `@deepseek-ai/dsh-client-ui-theme/styles/*`; primitives use the package root exports.

Run `node <sdk>/prepare.mjs --product <payload-root> --output <new-build-directory> --app-id <application-id> [--runtime-lock <qualified-pnpm-lock.yaml>]`. This composes only the runtime and a minimal application manifest. It executes no core compilation or source packing. The distribution then writes its own shell to `apps/desktop`, prepares `runtime/cli`, and seals the complete build inputs before packaging. Shell versions can be assigned after runtime preparation; runtime verification continues to use the SDK's fixed DSH version.

An initial discovery run resolves third-party dependencies. A supplied runtime lock never falls back to resolution: core package and patch identities are checked before a frozen production install. Every run retains its validated lock at `<build-directory>/runtime-pnpm-lock.yaml` before installation; promote it only after preparation and verification succeed. The equivalent source-side variables are `DSH_DESKTOP_RUNTIME_LOCK` and `DSH_DESKTOP_RUNTIME_LOCK_OUTPUT`. Product resource links must resolve inside their tree without cycles and are materialized before integrity sealing.

`node <sdk>/verify.mjs --prepared <build-directory>` checks resources and runs real Host, native and Office smoke with isolated user data. Add `--app <application.app>` to inspect packaged resources and execute its declared binary. Builder hooks may import `apps/desktop/src/runtime-tree.js` and `apps/desktop/scripts/verify-packaged-runtime.mjs`; the SDK does not supply the product's builder configuration. This qualification does not cover graphical shell behavior, signing, notarization, update hosting or other platforms.

Run exporter checks with `node --test apps/desktop/tests/export-desktop-sdk.test.mjs` and Host protocol checks with `pnpm exec vitest run apps/desktop-host/tests/protocol.spec.ts`. The manifest’s `runtimeContract.profileModule` identifies the prepared-tree module that exports `createPluginProfile` for isolated CLI verification. The consumer must also compile its shell using only extracted SDK inputs and perform packaged-runtime checks.
