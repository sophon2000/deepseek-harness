---
kind: upgrade-guide
description: "本地候选收紧 Host 请求与工具分派，并要求配套桌面运行时和 Video 包。"
---

# 使用与本地运行时候选配套的插件

[English](guide.md) | 中文

## 变更

本地候选 `0.2.1-rc.2.vh.1.local.20261018.1` 基于官方 `0.2.1-rc.2`；它不是官方 npm 发行，也不代表允许替换生产安装。

生成的 LIB Host JSON 参数与查找键优先使用 `strictCodec`，拒绝未声明字段。普通结果编解码器不变。没有 `strictCodec` 的 SRC/手动描述符保留普通编解码器回退；严格请求需要重新生成描述符。参见 [gateway](../../../../packages/api/gateway/src/index.ts) 与 [generator](../../../../packages/typert/generator/src/renderer.ts)。

`ToolDefinition.validateArgs` 在 `tools/pre-execute`（包括审批策略）之前检查参数快照。无效输入转为 `ToolArgsError` / `INVALID_ARGS`。最终守卫串行等待；allow 不能覆盖 deny。守卫与工具体必须向 `workingDirectory.ensureForExecution` 传入同一执行对象；复制会丢失共享目录观察。参见 [tools](../../../../packages/core/tools/src/index.ts) 与 [working-directory](../../../../packages/session/working-directory/src/index.ts)。

桌面打包要求物理 `resources/dsh`。配套 Video 插件提供默认 local 公开工作区准入、九项本地工具图片 Factory 注册和旧散文 mentions 退役。只安装上游 DSH 不会提供这些能力。旧工作区恢复仍保留显式兼容适配器。

### 动态解析工具

后续候选保留 `tools/pre-execute` 对未知名称的观察，策略可在此注册工具。只有 `ask` 会在审批之前再次执行权威作用域解析。仍未知的名称返回 `UNKNOWN_TOOL`，不弹审批。新建或替换的定义以及替换的 `validateArgs` 回调会在提示前校验；无效参数返回 `INVALID_ARGS`。未变更的校验器在此边界不会重复调用。

调用方取消优先。策略 `deny`、`cancel`、`allow` 路径不变；审批后分派仍再次解析工具。没有校验器的工具不会获得严格模式校验。校验器身份无法发现未替换回调内部的变化；可变授权应由执行时守卫处理。

## 迁移

1. 获取完整候选和配套 Video 插件。核验清单版本与完整性，将消费方 `package.json` 中 DSH 依赖固定为 `0.2.1-rc.2.vh.1.local.20261018.1` 并重新生成锁文件。不要混用旧 fork 包、浮动版本或其他工作树的 `node_modules`。保留此前安装以便回滚。
2. 使用配套生成器重新生成并构建 Host 描述符。从调用方删除未声明字段，不放宽模式或在校验前剥离字段。验证无效嵌套 JSON/查找键在调用前失败，合法结果仍正常解码。
3. 为自有工具注册校验器；保留执行时检查、等待守卫，并与消费目录的工具体共享执行对象。验证无效参数不会触发审批、deny 阻止分派、Session 目录变化不能重定向已准入执行。测试未知名称被观察但不弹审批、策略期间合法注册后正常审批、无效动态参数不审批以及审批前作用域移除。
4. 在一次性配置档测试配套 Video 插件：默认 local 无需 `inspectSessionWorkspace`、跨工作区访问失败、图片正常渲染、旧散文 mentions 不激活。仅在具备适配器时启用旧模式恢复。
5. 检查打包桌面的 `resources/dsh` 及启动配置档。切换真实工作前，必须取得已安装包、Host/client 和桌面冒烟结果；仅源码测试不能证明安装合格。
