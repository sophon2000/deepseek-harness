# Agent Note: 通用工具图片结果画廊

Status: implemented

[English](2026-09-12-generic-tool-image-result-gallery.md) | 中文

## Problem

原生图片画廊只能从 `read_image` keyed toolview 到达。第三方工具即使返回同样规范的已完成 `[text, image]` 内容块，Generic fallback 仍会把附件引用显示为 JSON，而不是图片预览。另注册 keyed toolview 也无法复用 `tool.call.images`，因为一个 child slot 只能有一个 owning entry。

## Decision

`ToolCallTree` 在 `tool.call.toolview` 旁统一拥有一次 `tool.call.images`，并向每个原子视图提供闭包了 Session 鉴权 loader 的 `renderImages` 能力。内置和第三方视图都不导入附件 UI，也不持有鉴权 URL。

Generic fallback 会为完全由有效标准 text 与 image block 组成的成功结果派生图片卡。它校验每个附件引用，通过既有画廊和灯箱渲染持久引用，并保留 text block 作为可读 envelope。引用畸形、失败、运行中调用，以及包含未渲染扩展 block 的结果，继续使用既有扁平 fallback。

`read_image` keyed view 保留路径感知模型与打开文件行为，但改为消费父层提供的图片 renderer，不再拥有 child slot。

## Alternatives considered

**只注册一个 Video Harness 专用 toolview。** 这只能解决一个工具；后续每个图片型插件仍会重现同一问题，还会让业务插件依赖 DSH 的附件展示实现。

**让每个 keyed toolview 都声明 `tool.call.images`。** Slot ownership 会主动拒绝重复 child 声明，因此独立插件无法组合。

**在 Generic 卡片内直接渲染 base64 或 URL。** 这会重复实现已经由 `ui-attachment` 负责的鉴权、加载、画廊与灯箱行为。

## Consequences

标准 image result block 现在成为跨工具可移植的展示约定。Session 日志和模型可见内容不变；未组合 `ui-attachment` 的部署仍保留可读文本。Generic 图片卡会拒绝混有扩展 block 的结果，避免静默隐藏内容。
