# Agent Note: 工具参数在审批前完成校验

Status: implemented

[English](2026-09-05-tool-argument-validation-before-approval.md) | 中文

## 问题

`defineTool` 只在 `execute` 内校验模型参数，该位置晚于 `tools/pre-execute` 与 `ctx.approval`。因此，格式错误的写调用可能先消耗一次 `allowed-once` 决策，再因参数校验失败而不执行，并让修正后的重试等待第二次审批。该审批描述了一个不可能执行的调用，审批状态也不再对应有效操作。

## 决策

`ToolDefinition` 提供可选的同步 `validateArgs(args)` 回调。`ToolRuntime` 在参数无损物化与首次取消检查后调用它，但调用时机早于 `tools/pre-execute`、审批、guard 或分发。校验抛出的错误会成为普通的最终工具错误，以上策略阶段都不会观察该调用。

`defineTool` 根据编译后的参数 schema 自动提供 `validateArgs`，同时保留 `execute` 内的相同校验以实现纵深防御。若 MCP server 等外部 provider 在执行期间负责校验，原始定义可以省略该回调。原始 provider 也可以直接选择接入，而无需采用 `defineTool` schema DSL。

执行器测试证明，无效的 `defineTool` 参数会产生 `INVALID_ARGS`，且不会调用策略或审批。自编排的 `tool-invalid-args-before-approval` headless 快照会启动已交付 Profile，并配置一个本应请求审批的 `PreToolUse` Hook；它重放缺参的 Bash 调用，记录 `INVALID_ARGS`，同时不产生任何 Hook 或审批事件。已有审批覆盖证明，有效调用仍只请求一次审批，并在 `allowed-once` 后执行。

## 备选方案

**在权限插件中校验。** 该方案会在策略消费方重复每个工具 schema、依赖监听器顺序，并让其他执行器调用方仍可绕过校验。

**执行因参数错误失败后退还审批。** 审批服务若不耦合工具实现细节，就无法区分参数错误与其他工具失败，而且用户仍会先批准一个无效操作。

**要求每个原始定义都在审批前校验。** MCP 等外部 provider 持有执行期校验。强制回调会引入适配器兼容性改动，却不能改善不请求审批的工具。

## 后果

- 无效的第一方调用会在策略前失败，且不会消耗一次性审批。
- 有效调用保留既有策略、审批、guard、分发与结果顺序。
- 注册原始定义的工具 provider 在前置审批校验很重要时必须添加 `validateArgs`；省略时保留 provider 执行期校验。
- `execute` 仍是最终强制执行点，因此工具主体实现不会只依赖前置校验。
