# Desktop SDK export

English | [中文](README.zh.md)

This reference describes the executable inputs consumed by an external desktop distribution repository. The SDK contains the built Electron shell, packed DSH and Host packages, target Electron and primary runtime, production dependency closures, compiled preparation tools, patch metadata and verification fixtures. It contains no dependency on the original checkout. The source checkout remains the shell's maintenance owner.

Run the producer commands from the DSH repository root with its pinned dependencies installed, on an Apple Silicon Mac:

```sh
pnpm run build:official
pnpm run release:pack --family dsh --out apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh --concurrency 6
pnpm run release:pack --family vendor --out apps/desktop/.desktop-build/targets/mac-arm64/packed/vendor --concurrency 6
pnpm --dir apps/desktop-host pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh"
pnpm --dir native/system/packages/entry pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/landlock"
DSH_DESKTOP_UNSIGNED=1 DSH_DESKTOP_TARGET_PLATFORM=darwin DSH_DESKTOP_TARGET_ARCH=arm64 pnpm --dir apps/desktop run prepare:runtime
node apps/desktop/scripts/export-desktop-sdk.mjs --output /absolute/new-sdk-directory --target mac-arm64
```

The output must not exist. A failed export leaves a partial directory without a completed `dsh-desktop-sdk.json`; discard that directory before retrying. Export records the source commit, tree, tracked-diff digest, untracked-file digests and exporter digest. A dirty export is never labelled clean. The producer must run preparation from the recorded source before export; export does not infer that stale build output belongs to the current source. Archive the completed directory without dereferencing symbolic links and record the archive digest in the consuming distribution's release lock.

The consumer verifies its locked archive digest and SDK identity before executing `node <sdk>/prepare.mjs --product <payload-root> --output <new-build-directory> --app-id <application-id>`. Preparation copies the SDK into a separate mutable directory and composes the product packages and resources there. It executes no core compilation or source packing. Third-party production dependencies can still require npm access. Preparation currently uses unsigned macOS arm64 settings. It retains failed output for diagnostics and writes `desktop-preparation.json` only after package installation, resource sealing and runtime smoke verification succeed. Product resource links must resolve inside the resource tree without directory cycles; preparation materializes them as physical files before integrity sealing.

An initial discovery run resolves third-party dependencies. Supply `--runtime-lock <qualified-pnpm-lock.yaml>` for subsequent builds; this copies the fixed composition lock without running dependency resolution, validates core tarball and patch identities, and uses a frozen production install. Every run retains the validated lock at `<build-directory>/runtime-pnpm-lock.yaml` before installation. The distribution promotes that lock only after complete preparation and verification succeed. Source-side packaging exposes the same selection through `DSH_DESKTOP_RUNTIME_LOCK` and preservation through `DSH_DESKTOP_RUNTIME_LOCK_OUTPUT`. The SDK manifest separates the tooling checkout identity from `runtimeSource`, whose client artifact record is digest-verified and retains the original compiled commit.

The prepared Electron builder configuration is `apps/desktop/scripts/electron-builder-config.mjs`; builder tools resolve through the SDK root `node_modules`. A distribution can set its product name, artifact name, output location and publication settings while retaining the SDK's resource layout and verification hooks. Signing and publication belong to the distribution owner. An SDK is a locked build input, not an installer or a signed product release.

`node <sdk>/verify.mjs --prepared <build-directory>` verifies the prepared resources and executes the real Host and native runtime smoke with isolated temporary user data. Adding `--app <application.app>` verifies the packaged resources and uses that application's declared executable. Successful preparation does not qualify an installer, graphical workflows, signing, notarization, update hosting, Windows or Intel macOS.

Run exporter checks with `node --test apps/desktop/tests/export-desktop-sdk.test.mjs`. The export requires the existing focused runtime and packaged-runtime checks for its selected platform.
