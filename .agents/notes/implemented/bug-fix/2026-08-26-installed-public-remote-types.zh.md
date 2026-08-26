# Agent Note: 通过公共子路径解析已安装的 Remote 类型

Status: implemented

[English](2026-08-26-installed-public-remote-types.md) | 中文

## Problem

DeepSeek Harness workspace 之外的项目可以在 Agent scope 的服务上声明 Remote 方法，同时从已安装的 Harness 包导入 `Agent` 及其 `SessionId` wire 类型。Typert 识别已安装的 protocol 元数据后，lookup 和 Context 分析仍会拒绝 `SessionId`，因为具名 Remote 边界类型只接受来自当前分析 workspace 中已登记包的类型。

如果把 `Agent` 参数替换为由调用方提供的字符串，就会移除负责解析实时 Agent 并进行授权的 lookup、Context 和 Agent Scope 语义。如果把 ID 类型复制到消费方，则同一个 wire 值会出现第二个声明身份。

## Decision

当物理 `node_modules` 路径与 manifest 名称一致，并且 `package.json#exports` 中具体的公共非根子路径暴露已解析符号时，已安装的 NPM 依赖可以提供具名 Remote 边界类型。根入口、包元数据、生成的 Typert 入口、Remote 入口和模式目标继续不可使用，与 workspace 包的规则一致。规范 `typeSymbol` 和生成的类型导入使用选定的包子路径与导出名称。

该依赖仍位于 workspace 登记之外，其声明不会展开到 workspace 类型图中。外部引用目标会保留解析后的 `SymbolId`，使 Remote 声明渲染器可以用生成的导入名称替换源码别名，并区分同名导入。

## Alternatives considered

**传递 ID 而不是 Agent。** 不采用，因为这种方式会把 lookup 和权限处理移入业务代码，并移除标准的 Agent scope 投影。

**接受包根入口作为规范类型入口。** 不采用，因为根入口可能携带 Host 运行时声明或 Cordis merge，无法提供 Remote 声明要求的纯类型消费入口。

**把已安装的依赖登记为 workspace 包。** 不采用，因为 workspace 登记表示项目所有权和编译器 face 成员身份；已安装的依赖只贡献外部公共符号。

**在消费方项目中复制 wire 类型或为其创建别名。** 不采用，因为第二个声明可能发生漂移，并会失去到包所拥有业务身份的导航。

## Verification

生成器测试会在 fixture workspace 之外安装 protocol、Agent 和身份包，并要求 Remote 模型与声明使用身份包的公共类型子路径。负向覆盖会拒绝只有根导出的类型；别名和相同导出名用例要求声明通过类型检查，并使用无冲突的生成名称。渲染器覆盖会验证外部符号引用消费生成的名称映射。

## Consequences

Typert 从另一个项目分析已发布插件时，插件可以保留官方 `Agent` 参数和 Agent Scope 设计。wire 类型必须具有具体的公共纯类型子路径；只从根入口导出 ID 的包必须新增该入口，否则生成会失败。独立于编译器的类型图会携带外部引用的不透明身份，但不会把这些声明视为 workspace 所有。
