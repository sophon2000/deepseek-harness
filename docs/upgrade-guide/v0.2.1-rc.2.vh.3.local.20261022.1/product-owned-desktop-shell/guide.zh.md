---
kind: upgrade-guide
description: 打包的产品运行时必须使用产品自有桌面壳，不能再使用 DSH Desktop。
---

# 产品自有桌面壳

[English](guide.md) | 中文

## 变更

DSH Desktop 直接启动共享 Host，并拒绝带产品描述文件的打包运行时。它不再运行产品预检或后台服务、注入这些进程的环境，也不再检查产品必需服务。Video 在 `video-desktop` 中管理这些生命周期。Desktop SDK 运行时准备和产品描述文件仍受支持；开发模式的 profile 激活不变。

## 迁移

1. 通过 `video-desktop` 打包并启动 Video，不使用 DSH Electron 壳。
2. 在产品自有壳中保留产品预检、服务启动、环境转发、必需服务检查和有序关闭。继续使用 Desktop SDK 准备脚本和运行时描述文件。
3. 验证产品应用在启动 Host 前完成预检，拒绝缺少必需服务的情况，并在退出前停止其子进程。验证普通 DSH Desktop 能在没有产品描述文件的情况下启动。
