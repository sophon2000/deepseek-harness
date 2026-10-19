---
kind: upgrade-guide
description: "Desktop 产品资源预检和必需 Host 服务使用产品 payload schema version 2。"
---

# 声明 Desktop 资源准备

[English](guide.md) | 中文

## 变更

声明 `preflight` 或 `requiredServices` 的 Desktop 产品 payload 使用 `desktop-product.json` schema version 2。旧 builder 拒绝 version 2。Version 1 的 service payload 继续受支持，但不能声明这两个新字段。

`preflight` 与 `service` 使用相同的入口、环境变量白名单和可选就绪期限。它必须发送一次 ready IPC 并成功退出，随后才启动 Host。后台 service 则在 ready 后继续运行；同时声明两种形式会被拒绝。取消会等待子进程及其标准流关闭。

`requiredServices` 列出 Profile 启动后、Desktop Host 就绪前必须存在的 Cordis 服务键。缺失服务导致启动失败；普通可选插件的警告不能满足要求。未声明此字段时不要求产品服务。

## 迁移

1. 对完成后退出的资源检查，设置 `schemaVersion: 2`，将 `service` 改成 `preflight`，保留精确环境变量白名单，并在 ready 发送完成且全部检查子进程关闭后断开 IPC。
2. 加入产品服务键，例如 `requiredServices: ["projectBff"]`。使用支持 schema 2 的配套 Desktop runtime；保留此前不可变制品。
3. 验证资源缺失、错误 ready 数据、ready 后非零退出和取消均阻止创建 Host。验证必需 Host 服务缺失时不发送 Desktop ready。后台 legacy 服务继续遵守已有关闭和更新检查。
