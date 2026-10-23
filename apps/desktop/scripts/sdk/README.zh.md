# Desktop Runtime SDK 导出

[English](README.md) | 中文

`dsh.desktop-sdk/2` 归档提供固定的 DSH 运行时、私有 Desktop Host、已准备的 Electron 与解释器、可执行准备工具、补丁元数据和验证夹具。它排除 Electron 壳 bundle、renderer、产品图像与 `runtime/cli`。上游壳仍保留在本 fork；独立发行方拥有自身壳源码、编译配置、CLI、签名和安装器。

在 Apple Silicon Mac 的 DSH 仓库根目录执行以下生产命令，先安装仓库固定依赖。提交源码后再构建，使运行时产物记录与导出源码身份指向同一干净提交：

```sh
pnpm run build:official
pnpm --dir native/system run build:native
pnpm run release:pack --family dsh --out apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh --concurrency 6
pnpm run release:pack --family vendor --out apps/desktop/.desktop-build/targets/mac-arm64/packed/vendor --concurrency 6
pnpm --dir apps/desktop-host pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh"
pnpm --dir packages/sdk/desktop-runtime-contract pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh"
pnpm --dir native/system/packages/entry pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/landlock"
npm pack ./native/system/packages/darwin-arm64 --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/landlock"
DSH_DESKTOP_UNSIGNED=1 DSH_DESKTOP_TARGET_PLATFORM=darwin DSH_DESKTOP_TARGET_ARCH=arm64 pnpm --dir apps/desktop run prepare:runtime
node apps/desktop/scripts/export-desktop-sdk.mjs --output /absolute/new-sdk-directory --target mac-arm64
```

使用 glibc 的 Linux x64 的目标目录和导出参数使用 `linux-x64`，准备环境使用 `linux`/`x64`，原生包使用 `native/system/packages/linux-x64`。锁定的 primary runtime 提供 Node、Python 与 pnpm；Electron 使用 `electron/electron`。Linux 运行时准备不提供上游壳 CLI，不启用发布或自动更新；发行方拥有自身 CLI。导出排除其他平台、架构或 libc 实现的可选原生工具。

Windows x64 使用 `win-x64` 和 `win32`/`x64` 准备环境。在 `packed/landlock` 中提供已发布的 `node-addon-system` 入口 tarball；该包没有 Windows 专属原生 tarball。Windows operation 支持由匹配的 DSH 依赖闭包提供。导出要求原生 Windows x64 生产机。准备目录验证执行 `electron/electron.exe`；成品验证使用 `--app <解包目录> --executable <产品.exe>` 及其 `resources` 目录。SDK 排除上游 Windows CLI，不签名或安装发行方应用。

使用 `node apps/desktop/scripts/archive-desktop-sdk.mjs --sdk <SDK目录> --output <新归档.tgz>` 归档已完成的导出。它保留相对链接，不跟随依赖环，输出 SHA-256 与字节数，并拒绝已有输出或位于 SDK 内的输出（包括目录别名）。Windows 消费方必须先校验归档链接图，再以明确的目录类型恢复目录符号链接；不指定类型的 Node `fs.symlink` 会创建指向目录但不可用的文件链接。

完整的 Linux 原生构建需要 `musl-gcc`；根目录的官方构建仅准备宿主 addon。原生源码未变时，生产者也可提供经 registry 完整性校验的已发布原始 tarball。保留其独立版本和原始来源记录，不将它们归属于 DSH family 构建。

输出目录必须不存在。写入输出前，导出器要求源码树干净、官方客户端构建来自当前提交，并且根包、Desktop 与客户端产物版本一致。`mac-arm64`、`linux-x64` 和 `win-x64` 均要求匹配的原生生产环境：导出器复制已安装的原生工具依赖，而非单独解析的目标平台安装。上述前置校验失败不会产生输出；后续失败会保留部分目录，且没有完成的 `dsh-desktop-sdk.json`。归档时保留符号链接，并由发行仓固定摘要。清单记录源码身份、通过产物摘要核验的运行时构建记录、Electron 版本与 Host 协议版本。导出器拒绝壳所有的输出路径。

`shell-build/node_modules` 包含编译壳所需的精确 DSH 包、其声明导入以及上游壳的五个生产依赖。`shell-dependencies.json` 记录根包、相对 SDK 归档的包路径、版本和摘要，不依赖生产者构建存储位置。发行方拥有固定的 TypeScript、tsdown、Vite、React 与 Electron builder 配置，不应假定本 SDK 提供这些编译工具链。SDK 为打包消费方保留固定 Electron builder 依赖闭包，并在导出的 app 目录中链接最小应用的生产依赖。

私有工作区包 [`@deepseek-ai/dsh-desktop-runtime-contract`](../../../../packages/sdk/desktop-runtime-contract/README.zh.md) 导出 `./runtime-tree`、`./release`、`./host-protocol`、`./desktop-product`、`./core-package-set` 和 `./project-profile`。导出过程复制该包已打包的 JavaScript 和声明，不再从壳源码编译另一套实现。壳适配器导入这些 API，不重复实现描述符校验。此包还负责通用准备辅助模块、打包运行时校验和产品进程验收 runner；官方构建路径、签名和 Host smoke 编排仍归 Desktop。`@deepseek-ai/dsh-desktop-host/protocol` 提供共享 Host 事件、控制请求、校验器和协议版本。主题 CSS 与许可字体使用 `@deepseek-ai/dsh-client-ui-theme/styles/*`，基础组件使用包根导出。

执行 `node <sdk>/prepare.mjs --product <payload-root> --output <new-build-directory> --app-id <application-id> [--runtime-lock <qualified-pnpm-lock.yaml>]`。它仅组合运行时与最小应用清单，不编译核心或打包源码。发行方随后把自己的壳写入 `apps/desktop`，准备 `runtime/cli`，并在打包前封存完整构建输入。可在运行时准备后指定壳版本；运行时验证仍使用 SDK 固定的 DSH 版本。

准备过程忽略生产者存储覆盖变量 `DSH_DESKTOP_BUILD_ROOT`、`DSH_DESKTOP_DOWNLOAD_CACHE` 和 `DSH_DESKTOP_PNPM_STORE_ROOT`。构建与下载路径保持在新的输出目录内，安装存储使用临时目录。

首次发现运行会解析第三方依赖。已提供运行时锁时绝不回退解析：冻结生产安装前先核验核心包和补丁身份。每次运行都在安装前将已验证锁保留为 `<build-directory>/runtime-pnpm-lock.yaml`，仅在准备与验证成功后提升它。源码侧对应变量是 `DSH_DESKTOP_RUNTIME_LOCK` 和 `DSH_DESKTOP_RUNTIME_LOCK_OUTPUT`。产品资源链接必须无环且指向资源树内，并在完整性封存前物化。

`node <sdk>/verify.mjs --prepared <build-directory>` 核验资源，并用隔离用户目录执行真实 Host、原生与 Office 冒烟。macOS 增加 `--app <application.app>` 可检查已打包资源并运行其声明的可执行程序。Linux 打包验证要求 `--app <unpacked-directory> --executable <filename>`，读取 `resources/dsh` 和 `resources/runtime`；验证要求宿主匹配。SDK 不提供产品 builder 配置。该验收不涵盖图形壳行为、签名、公证、更新托管或其他平台。

清单的 `sdkApi.version` 为 `dsh.desktop-sdk-api/1`，独立于归档 schema 2 和 Host 协议 4。其 `profile`、`runtime`、`packagedRuntime` 与 `tools` 字段分别指定 `sdk/v1/profile.mjs`、`sdk/v1/runtime.mjs`、`sdk/v1/packaged-runtime.mjs` 和 `sdk/v1/tools.mjs`。这些 ESM 入口依次导出 `createPluginProfile`、`verifyDesktopRuntime`、`verifyPackagedDesktopRuntime` 和异步 `loadAsar`。消费方在导入前校验 API 版本与精确路径；未知或不完整声明必须报错，不得回退到内部路径。`runtimeContract.profileModule` 等于 `sdkApi.profile`。没有 `sdkApi` 的旧 schema-2 归档仅保留明确识别的旧路径。准备过程内部实现仍属私有，只要 SDK 入口还依赖它们，就不能删除。

通过 `node --test apps/desktop/tests/export-desktop-sdk.test.mjs` 运行导出器检查，通过 `pnpm exec vitest run apps/desktop-host/tests/protocol.spec.ts` 检查 Host 协议。导出器检查会重定位公开 API 与产品进程验收 runner，包括通过声明导出的包自引用。清单的 `runtimeContract.profileModule` 指定 prepared 树中导出 `createPluginProfile` 的模块，供隔离 CLI 验证使用。消费方还必须仅使用解出的 SDK 输入编译自身壳，并执行打包运行时检查。
