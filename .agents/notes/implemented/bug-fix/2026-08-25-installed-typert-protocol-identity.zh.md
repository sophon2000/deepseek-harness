# Agent Note: 按包身份识别已安装的 Typert protocol 元数据

Status: implemented

[English](2026-08-25-installed-typert-protocol-identity.md) | 中文

## Problem

Typert 生成器可以分析 DeepSeek Harness workspace 之外的项目，而该项目会从已发布的 `@deepseek-ai/dsh-typert-protocol` 包导入 `Remote` 和 `TypertRemoteService`。词法发现能够看到这些名称，但身份检查只接受登记在当前 workspace 内的 protocol 声明，或嵌套在以 protocol 包名命名的 ambient module 中的声明。正常安装在 `node_modules` 下的声明不符合其中任何一种情况，因此有效的 Remote 元数据会被静默忽略；之后发布 Remote 产物时，包会因为看似没有 Remote 方法而失败。

消费方可以用 ambient 声明弥补缺失的身份，但它会重复 protocol 包的一部分，并可能在包导出变更时发生漂移。

## Decision

如果声明所在的源文件解析为精确的外部包 `@deepseek-ai/dsh-typert-protocol`，protocol 元数据身份检查也会接受该声明。分析器复用已有的外部模块身份解析器；它已经能够理解普通和 pnpm 风格的 `node_modules` 路径。这项检查不会把该依赖登记为 workspace 包，也不会把它的声明展开到 workspace 类型图中。

workspace 登记和现有 ambient module 形式继续有效。其他依赖即使导出名为 `Remote`、`RemoteScope` 或 `TypertRemoteService` 的声明，也不能通过包身份检查。

## Alternatives considered

**按导出名称接受元数据。** 不采用，因为无关库也可能导出同名声明，从而错误获得影响编译器行为的 Typert 语义。

**登记 `node_modules` 下任意位置找到的 protocol 包。** 不采用，因为 workspace 登记描述项目所有权和编译器 face 成员身份，而已安装的 protocol 只是外部元数据权威。扩大登记范围会模糊这条边界，并增加分析范围。

**要求每个树外消费方提供 ambient 声明 shim。** 不采用，因为 shim 会重复官方声明，可能掩盖已发布包的兼容性缺陷，并且必须随 protocol API 变化而更新。

## Verification

生成器测试会创建一个不使用 TypeScript `paths` 重定向或 ambient module 的已安装 protocol 包，从独立消费项目导入其中的元数据，并要求成功生成 Remote 产物。配套的仿冒包用例证明：只有同名导出、没有官方包身份，仍不足以通过检查。

## Consequences

已发布包的消费方可以直接根据安装的 protocol 包生成 Remote 产物，包括 pnpm 布局在内，无需本地身份 shim。protocol 声明仍是外部类型引用，生成器的 workspace 所有权规则保持不变。使用临时 ambient bridge 的消费方，只有在实际采用包含该行为的生成器并从空输出目录重建产物之后，才能移除 bridge。
