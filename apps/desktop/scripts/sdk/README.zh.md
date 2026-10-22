# Desktop Runtime SDK 导出

[English](README.md) | 中文

`dsh.desktop-sdk/2` 归档提供固定的 DSH 运行时、私有 Desktop Host、已准备的 Electron 与解释器、可执行准备工具、补丁元数据和验证夹具。它排除 Electron 壳 bundle、renderer、产品图像与 `runtime/cli`。上游壳仍保留在本 fork；独立发行方拥有自身壳源码、编译配置、CLI、签名和安装器。

在 Apple Silicon Mac 的 DSH 仓库根目录执行以下生产命令，先安装仓库固定依赖。提交源码后再构建，使运行时产物记录与导出源码身份指向同一干净提交：

```sh
pnpm run build:official
pnpm run release:pack --family dsh --out apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh --concurrency 6
pnpm run release:pack --family vendor --out apps/desktop/.desktop-build/targets/mac-arm64/packed/vendor --concurrency 6
pnpm --dir apps/desktop-host pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh"
pnpm --dir native/system/packages/entry pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/landlock"
DSH_DESKTOP_UNSIGNED=1 DSH_DESKTOP_TARGET_PLATFORM=darwin DSH_DESKTOP_TARGET_ARCH=arm64 pnpm --dir apps/desktop run prepare:runtime
node apps/desktop/scripts/export-desktop-sdk.mjs --output /absolute/new-sdk-directory --target mac-arm64
```

输出目录必须不存在。导出失败会留下部分目录，且没有完成的 `dsh-desktop-sdk.json`。归档时保留符号链接，并由发行仓固定摘要。清单记录源码提交与树、脏输入摘要、通过产物摘要核验的运行时构建记录、Electron 版本与 Host 协议版本。导出器拒绝壳所有的输出路径。

`shell-build/node_modules` 包含编译壳所需的精确 DSH 包、其声明导入以及上游壳的五个生产依赖。`shell-dependencies.json` 记录根包、包归档路径、版本和摘要。发行方拥有固定的 TypeScript、tsdown、Vite、React 与 Electron builder 配置，不应假定本 SDK 提供这些编译工具链。SDK 为打包消费方保留固定 Electron builder 依赖闭包，并在导出的 app 目录中链接最小应用的生产依赖。

SDK 生成的 `@deepseek-ai/dsh-desktop-runtime-contract` 包将 fork 现有实现编译为 JavaScript 与声明，导出 `./runtime-tree`、`./release`、`./host-protocol`、`./desktop-product`、`./core-package-set` 和 `./project-profile`。壳适配器导入这些 API，不重复实现描述符校验。`@deepseek-ai/dsh-desktop-host/protocol` 提供共享 Host 事件、控制请求、校验器和协议版本。主题 CSS 与许可字体使用 `@deepseek-ai/dsh-client-ui-theme/styles/*`，基础组件使用包根导出。

执行 `node <sdk>/prepare.mjs --product <payload-root> --output <new-build-directory> --app-id <application-id> [--runtime-lock <qualified-pnpm-lock.yaml>]`。它仅组合运行时与最小应用清单，不编译核心或打包源码。发行方随后把自己的壳写入 `apps/desktop`，准备 `runtime/cli`，并在打包前封存完整构建输入。可在运行时准备后指定壳版本；运行时验证仍使用 SDK 固定的 DSH 版本。

首次发现运行会解析第三方依赖。已提供运行时锁时绝不回退解析：冻结生产安装前先核验核心包和补丁身份。每次运行都在安装前将已验证锁保留为 `<build-directory>/runtime-pnpm-lock.yaml`，仅在准备与验证成功后提升它。源码侧对应变量是 `DSH_DESKTOP_RUNTIME_LOCK` 和 `DSH_DESKTOP_RUNTIME_LOCK_OUTPUT`。产品资源链接必须无环且指向资源树内，并在完整性封存前物化。

`node <sdk>/verify.mjs --prepared <build-directory>` 核验资源，并用隔离用户目录执行真实 Host、原生与 Office 冒烟。增加 `--app <application.app>` 可检查已打包资源并运行其声明的可执行程序。Builder hook 可导入 `apps/desktop/src/runtime-tree.js` 和 `apps/desktop/scripts/verify-packaged-runtime.mjs`；SDK 不提供产品 builder 配置。该验收不涵盖图形壳行为、签名、公证、更新托管或其他平台。

通过 `node --test apps/desktop/tests/export-desktop-sdk.test.mjs` 运行导出器检查，通过 `pnpm exec vitest run apps/desktop-host/tests/protocol.spec.ts` 检查 Host 协议。清单的 `runtimeContract.profileModule` 指定 prepared 树中导出 `createPluginProfile` 的模块，供隔离 CLI 验证使用。消费方还必须仅使用解出的 SDK 输入编译自身壳，并执行打包运行时检查。
