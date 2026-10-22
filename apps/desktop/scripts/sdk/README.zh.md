# Desktop SDK 导出

[English](README.md) | 中文

本参考说明独立桌面发行仓库消费的可执行输入。SDK 包含构建后的 Electron 壳、DSH 与 Host 包归档、目标 Electron 和主运行时、生产依赖闭包、编译后的准备工具、补丁元数据与验证夹具。它不依赖原 checkout；源码 checkout 继续负责壳的维护。

在 Apple Silicon Mac 的 DSH 仓库根目录执行生产命令，先安装仓库固定的依赖：

```sh
pnpm run build:official
pnpm run release:pack --family dsh --out apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh --concurrency 6
pnpm run release:pack --family vendor --out apps/desktop/.desktop-build/targets/mac-arm64/packed/vendor --concurrency 6
pnpm --dir apps/desktop-host pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/dsh"
pnpm --dir native/system/packages/entry pack --pack-destination "$PWD/apps/desktop/.desktop-build/targets/mac-arm64/packed/landlock"
DSH_DESKTOP_UNSIGNED=1 DSH_DESKTOP_TARGET_PLATFORM=darwin DSH_DESKTOP_TARGET_ARCH=arm64 pnpm --dir apps/desktop run prepare:runtime
node apps/desktop/scripts/export-desktop-sdk.mjs --output /absolute/new-sdk-directory --target mac-arm64
```

输出目录必须不存在。导出失败会留下部分目录，其中没有完成标志 `dsh-desktop-sdk.json`；重试前丢弃该目录。导出记录源码提交、树、已跟踪差异摘要、未跟踪文件摘要与导出器摘要。脏导出不会被标为干净状态。生产方必须先从所记录源码运行准备；导出器不会推定陈旧构建属于当前源码。归档完整目录时不得解引用符号链接，并将归档摘要记录到消费发行仓库的版本锁中。

消费方先验证固定的归档摘要与 SDK 身份，再执行 `node <sdk>/prepare.mjs --product <payload-root> --output <new-build-directory> --app-id <application-id>`。准备会把 SDK 复制到独立可写目录，在其中组合产品包与资源，不编译核心或打包源码。第三方生产依赖仍可能访问 npm。准备当前使用无正式签名的 macOS arm64 配置，失败时保留输出用于诊断；只有包安装、资源封存和运行时冒烟验证全部成功后才写入 `desktop-preparation.json`。产品资源链接必须在资源树内解析且不得形成目录环；准备会在完整性封存前将其物化成普通文件。

首次发现运行会解析第三方依赖。后续构建提供 `--runtime-lock <qualified-pnpm-lock.yaml>`：复制固定组合锁，不重新解析依赖，核验核心归档与补丁身份，然后执行冻结的生产安装。每次运行都在安装前把已验证锁保留至 `<build-directory>/runtime-pnpm-lock.yaml`。发行方仅在完整准备和验证成功后提升该锁。源码侧打包通过 `DSH_DESKTOP_RUNTIME_LOCK` 选择输入，通过 `DSH_DESKTOP_RUNTIME_LOCK_OUTPUT` 保留输出。SDK 清单将工具 checkout 身份与 `runtimeSource` 分开；后者的客户端产物记录经过摘要验证，并保留原编译提交。

准备后的 Electron builder 配置位于 `apps/desktop/scripts/electron-builder-config.mjs`；构建工具通过 SDK 根 `node_modules` 解析。发行方可以设置产品名、产物名、输出位置与发布配置，同时保留 SDK 资源布局及校验钩子。签名与发布归发行方负责。SDK 是固定构建输入，不是安装器或已签名产品发行版。

`node <sdk>/verify.mjs --prepared <build-directory>` 会验证准备后的资源，并使用隔离的临时用户数据执行真实 Host 与原生运行时冒烟。追加 `--app <application.app>` 会验证打包后的资源并使用该应用声明的可执行文件。准备成功不代表安装器、图形流程、签名、公证、更新托管、Windows 或 Intel macOS 已通过验收。

使用 `node --test apps/desktop/tests/export-desktop-sdk.test.mjs` 运行导出器检查。导出仍要求对目标平台执行已有的运行时与包后运行时检查。
