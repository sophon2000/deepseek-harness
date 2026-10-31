---
description: "通过共享 API 校验 Desktop 运行时资源并组合发行方配置档。"
kind: "package-library"
---

# @deepseek-ai/dsh-desktop-runtime-contract

[English](README.md) | 中文

## 概述

壳适配器和 Desktop 发行方使用这个私有包校验发行版本、运行时清单和产品描述符，并组合插件配置档。请导入包的具名子路径，不要把校验实现复制到产品壳中。此包不注册插件，也不安装到默认 DSH 运行时中。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

[导出映射](package.json) 保留独立壳消费的 runtime-tree、release、host-protocol、desktop-product、core-package-set 和 project-profile 子路径。运行时文件和声明文件来自同一次工作区构建。[Desktop Runtime SDK 导出器](../../../apps/desktop/scripts/sdk/README.zh.md) 纳入该私有包的打包产物及其依赖闭包，不再从壳源码合成另一套实现。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[运行时 API](src/index.ts) 负责完整性清单、发行兼容性、通用产品声明和配置档组合。Desktop 原有源码位置转发到这些 API。[工具目录](tooling) 负责资源物化、运行时锁保留、补丁选择与应用、清单规范化、打包运行时检查和版本化发行方入口生成。其源码递归编译或复制到无源码归档中，不作为 DSH 插件安装。

[产品进程 runner](testing/product-process.ts) 属于发行方验收测试。prepared-runtime smoke 使用它验证声明的 service 或 preflight 的就绪与退出；官方壳不启动它。此维护单元保留既有 IPC 校验、环境过滤、截止时间和进程关闭行为。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Desktop Runtime SDK](../../../apps/desktop/scripts/sdk/README.zh.md) — 归档准备与验收。
- [Desktop 应用](../../../apps/desktop/README.zh.md) — 官方壳生命周期。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **官方准备编排仍归 Desktop。** 包选择、构建路径、签名、Host 适配器和聚合 smoke 仍依赖官方应用及仓库发行辅助模块。迁移这些部分需要明确生产者输入；此包不替代这些编排。
- **仅供私有发行。** 此包为 Desktop Runtime SDK 导出显式打包，不由 npm 发行族发布。归档 schema、发行方 API 版本和 Host 协议仍分别管理版本。

<a id="dev-note"></a>
### 开发备注

无。
