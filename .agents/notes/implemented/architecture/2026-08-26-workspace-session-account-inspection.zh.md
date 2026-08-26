# Agent Note: 检查持久 Workspace 会话记账

Status: implemented

[English](2026-08-26-workspace-session-account-inspection.md) | 中文

## 问题

`Workspace.sessionIds` 有意作为已校验的成员投影：只有当会话 id 位于持久候选记账中，并且其索引中的规范 header cwd 等于 Workspace 路径时，该会话才会出现。缺失 header、cwd 不可用或 cwd 不匹配的会话必须留在 GUI 分组与 Workspace 继承之外。[Workspace UI 产品流程决策](../feature/2026-07-25-workspace-ui-product-flow.zh.md)继续拥有这项成员资格与分组约定。

该投影也隐藏了持久记账本身。宿主侧消费方无法区分从未记账的会话与记账仍然持久、但 cwd 在重启后不再通过校验的会话。根据当前 cwd 解析无法在 cwd 缺失或解析到其他位置时找回原 Workspace；直接读取存储领域则会绕过拥有这些不变量的注册表。

## 决策

`WorkspaceRegistry.inspectSessionWorkspace(sessionId)` 按注册表顺序同步检查持久候选记账。没有记账包含该会话 id 时返回 `undefined`。已记账的 id 返回既有 `Workspace` 实体和一个粗粒度校验值：索引中的规范 cwd 等于 Workspace 路径时为 `valid`，header 或规范 cwd 不可用时为 `cwd-unavailable`，索引中的规范 cwd 指向另一条路径时为 `cwd-mismatch`。

检查使用注册表的启动时／实时 header 索引，不读取持久化、不检查文件系统、不执行持久写入、候选剪枝或通知。它不暴露原始 header、失败 cwd、校验原因或完整候选记账。当前目录可用性仍由未缓存的 `Workspace.status()` 操作负责。

`Workspace.sessionIds` 保持已校验成员语义。存储 schema、会话 header 与会话事件日志均不改变。Workspace 包不贡献 Tool、提示词文本或请求字段；由于检查是公共 Cordis Service API，其签名与结果类型会进入生成目录，并可通过需要显式选择启用的 `dsh-tool-cordis` 组合发现。

## 外部 Host 集成

DSH 内置流程继续消费已校验的 `Workspace.sessionIds`；本决策不改变 Session fork 的继承。外部 Host 插件需要在不读取私有存储、不把无效记账变成成员资格的前提下诊断或约束持久绑定时，使用这项检查。每个消费方拥有三种校验值的后续策略，并且必须在自己的边界测试该组合。

## 考虑过的替代方案

**通过 `Workspace.sessionIds` 返回所有持久候选。** 否决，因为 GUI 分组与 fork 继承依赖该属性表达已校验成员。放宽它会把陈旧记账变成活跃成员。

**用 `resolveByPath()` 解析会话 header cwd。** 否决，因为缺失路径会拒绝，改指的符号链接会解析到新的 Workspace 路径，从而丢失调用方需要检查的持久记账。

**暴露原始候选 id 或 Workspace 存储表。** 否决，因为调用方可能重复实现成员策略、泄露无效 cwd 细节，或绕过注册表的唯一性与排序检查执行变更。粗粒度结果已足够满足需要这项区分的 Host 消费方。

**每次检查都刷新持久化与文件系统。** 否决，因为异步调用会暗示本注册表并不提供的新鲜度。header 索引仍只在启动和 attach 未缓存的持久会话时刷新；实时目录状态有独立操作。

## 验证

Workspace 测试覆盖有效、不匹配、缺失 header、无 cwd、目录缺失、非目录与未记账的会话，并验证检查既不剪枝已存记账，也不发出领域变更。冷启动测试在目录消失后保留持久记账，并把符号链接改指报告为 `cwd-mismatch`。一项防御测试会拒绝外部造成的 table/entity 状态分叉，定向 coverage 保持变更后的 Workspace 源码在语句、分支、函数和行四项均为 100%。一项 Tool-Cordis 回归测试证明精确查询 `workspaceRegistry` 目录会返回 `WorkspaceSessionInspection`；运行时目录生成器保留正则表达式中经过转义的词边界，避免引用类型闭包悄悄变空。

## 后果

宿主插件可以区分无持久记账与 cwd 校验失败的记账，而不改变分组语义或读取私有存储。当前目录可用性相关时，它们仍须把检查结果与 `Workspace.status()` 结合；另一进程造成的 cwd 损坏只有在既有 header 索引刷新或重启后才会被观察到。新增的公开方法与结果类型成为需要维护的包约定，换来让一个注册表继续统一拥有存储与成员策略。
