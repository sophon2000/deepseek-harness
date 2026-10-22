# Agent Note: 独立维护桌面壳所用的 Runtime SDK

Status: implemented

[English](2026-10-22-independent-shell-runtime-sdk.md) | 中文

## Problem

首版产物 SDK 固定了运行时输入，但也携带 fork 编译的 Electron 壳。产品虽可独立打包，每次壳改动仍依赖 fork。壳编译器还读取仅工作区存在的 UI 源路径，并通过私有本地声明共享 Host 协议。

## Decision

Runtime SDK 第 2 版保留已准备的解释器、Electron、DSH 与 Host 包归档、运行时组合和验证。它排除壳 bundle、renderer 资源以及整个运行时 CLI 目录。独立发行方拥有自身壳编译器、图像、CLI、打包和发行配置。上游壳及测试仍留在 fork，避免同步上游时反复恢复已删除目录。

SDK 提供固定的壳依赖及完整声明导入，并从现有描述符实现编译生成 runtime-contract 包。Desktop Host 通过协议导出拥有共享 IPC 消息和校验器；上游壳与独立壳消费同一入口。主题样式与字体导出指向已发布的库资源。每个 SDK 记录源码身份和已核验的运行时构建身份；Host 或 UI 包变化后，必须重新构建和打包再导出。

## Alternatives considered

**继续把已编译壳作为产品输入发行。** 产品壳改动仍由 fork 拥有，无法完成维护归属转移。

**从 fork 删除上游壳。** 这会持续增加上游合并冲突，并破坏有用的上游集成测试。因此改为让产品构建停止消费该壳。

**把校验器和 IPC 类型复制到新壳。** 这会产生运行时元数据与 Host 消息的多份解释；SDK 和 Host 包继续拥有它们。

## Consequences

首版[产物 SDK 决策](2026-10-22-desktop-artifact-sdk.zh.md)仍约束固定归档消费与依赖锁；第 2 版的维护归属与输出规则取代其已编译壳导出。运行时准备留下最小应用清单，由发行方在组合后替换。发行方必须编译、组装并封存自己的壳，才能验证已打包应用。SDK 的运行时冒烟不验收图形壳行为。
