---
kind: upgrade-guide
description: "本地插件退役候选版收紧生成的 Host 请求与工具分发，并要求配套的桌面运行时和 Video 插件。"
---

# 为本地运行时候选版配套插件

[English](guide.md) | 中文

## 变更

本指南适用于基于官方 `0.2.1-rc.2` 的本地候选版 `0.2.1-rc.2.vh.1.local.20261018.1`；它不是官方 npm 发布版，也不代表可以直接替换生产安装。

生成的 LIB Host JSON 参数与 lookup 键优先使用 `strictCodec`，拒绝未声明的请求字段，不再静默投影掉这些字段。普通结果 codec 保持不变。没有 `strictCodec` 的 SRC 与手工注册描述符继续回退到普通 codec；必须重新构建生成描述符才能获得严格请求校验。参见 [gateway](../../../../packages/api/gateway/src/index.ts) 与[生成器](../../../../packages/typert/generator/src/renderer.ts)。

`ToolDefinition.validateArgs` 对参数快照进行校验，早于包括审批策略在内的 `tools/pre-execute`。无效输入统一归为 `ToolArgsError` / `INVALID_ARGS`。最终守卫按顺序等待完成；拒绝不能被允许决定覆盖。守卫和工具执行体调用 `workingDirectory.ensureForExecution` 时必须传入同一个执行对象；复制对象会丢失共享的目录观察。参见 [tools](../../../../packages/core/tools/src/index.ts) 与 [working-directory](../../../../packages/session/working-directory/src/index.ts)。

桌面候选版要求物理存在的 `resources/dsh` 运行时目录树。配套 Video 插件负责默认 local 模式的公开工作区准入、九个本地工具图片 Factory 注册，以及旧版 prose mentions 的退役；仅安装上游 DSH 不会提供这些变更。旧版工作区恢复仍需要显式的兼容适配器。

### 动态解析工具的审批

后续本地候选版保留官方策略窗口：未知名称仍进入 `tools/pre-execute`，策略可在其中注册合法工具。仅在决定为 `ask` 时，才会在审批前再次按作用域权威解析。工具仍不存在时返回 `UNKNOWN_TOOL`，不弹审批；对于新注册或替换的定义，或被替换的 `validateArgs` 回调，先校验再审批，无效输入返回 `INVALID_ARGS`。未变化的校验器不会在此边界重复调用。调用方取消优先；策略 `deny`、`cancel`、`allow` 保持原路径，审批后的分发仍再次解析工具。这不会为没有校验器的工具增加严格 schema 校验，也不会阻止策略观察未知名称。

验证未知名称被策略观察但审批请求为零、策略内合法注册正常审批、动态非法参数不请求审批，以及审批前作用域移除。保留执行时检查：校验器身份检查无法检测同一回调内部状态的变化；可变授权应放在守卫中。

## 迁移

1. 向集成负责人取得完整本地候选包集和配套 Video 插件。按随附 manifest（元数据清单）核对版本和包完整性。在使用方 `package.json` 中将 DSH 包依赖固定为 `0.2.1-rc.2.vh.1.local.20261018.1`，并从该包集重新生成锁文件。不要混用旧 fork 包、浮动版本或另一 checkout 的 `node_modules`；保留上一套完整安装以便回滚。
2. 用配套 Typert 生成器重新生成并构建 Host 描述符。移除调用方 JSON 请求中未声明的字段；不要放宽 schema，也不要在校验前剥离意外字段。验证嵌套 JSON 与 lookup 键畸形时会在目标方法执行前失败，而合法结果仍可正常解码。
3. 为本地自有工具注册参数校验器。保留执行时校验，等待异步守卫完成，并在守卫和使用目录的执行体中将实际执行对象传给 `ensureForExecution`。验证无效参数不会进入审批、拒绝会阻止分发，且后续 Session 目录变化不会改向已准入的执行。
4. 先在一次性 profile 中安装配套 Video 插件。确认默认 local 模式无需 `inspectSessionWorkspace` 即可工作、跨工作区请求被拒绝、工具图片正常渲染，且旧版 prose mentions 不再激活。没有所需适配器时，不要启用旧版恢复。
5. 验证打包桌面的物理 `resources/dsh` 目录树与启动的 profile。在切换真实工作前，要求集成负责人提供已安装包、Host/client 及桌面冒烟测试结果；仅通过源码测试并不足够。
