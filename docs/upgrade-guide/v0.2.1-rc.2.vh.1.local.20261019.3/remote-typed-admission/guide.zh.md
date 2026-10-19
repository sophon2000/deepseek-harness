---
kind: upgrade-guide
description: "要求类型化 Remote 定义的 Profile 会拒绝缺失、仅有源码标记或已替换的 Host 定义。"
---

# 要求当前有效的类型化 Remote 定义

[English](guide.md) | 中文

## 变更

Gateway 配置 `requireTypedDefinitions: true` 禁止业务 SRC 回退，包括 Host 导出从未成功注册的端点。它在 lookup 前拒绝缺失或仅有源码标记的定义，并在业务调用前拒绝异步 lookup 期间已移除或替换的捕获定义。默认值仍为 `false`，普通既有 Profile 保留 SRC 兼容。策略覆盖一元与流调用，并保留 Gateway 自有事件控制校验及已执行调用的生命周期。

## 迁移

1. 在 Profile 的 Gateway 行启用 `requireTypedDefinitions` 之前，用 Typert Loader 注册业务包有效的 `./typert` Host 导出，包括参数、结果、Context 与已声明上行的 strict codec。
2. 使用配套的新运行时。产品启动可要求 `ctx.typertGateway.requiresTypedDefinitions === true`；旧运行时可能忽略未知配置字段，无法提供该保证。修改 patch 文件不会升级既有不可变安装包。
3. 验证有效类型定义的一元与流调用，再保留 SRC 服务并撤回定义。调用必须返回 `gateway/definition-unavailable`，且不进入 lookup 或业务代码。已暂停在 lookup 的请求，在分发前定义被撤回或替换时也必须失败。
