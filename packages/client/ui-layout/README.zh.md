---
description: "Web GUI 的外壳布局：三栏 AppFrame、拖动手柄与让步行为、面板几何服务与主题呈现；供窗口外观的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

## 概述

本包提供带可缩放侧栏与详情面板的三栏 Web 框架。插件可以在原生 Tool 详情旁追加 Session 作用域的工作视图，不替换会话。宽窗口预留详情栏；窄窗口在会话与详情之间切换，并向待处理交互让出空间。本包也负责呈现主题。几何和视图选择都是瞬时状态，重新加载即重置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 root slot 挂载本插件；它围绕侧栏、会话和详情的占用方渲染框架。用户通过命中条带缩放侧栏，通过浮动胶囊缩放详情栏。关闭的侧栏保留 56px 控制栏。详情无法与会话并排时，框架展示带返回控件的全宽详情视图；Escape 返回时不重新挂载会话，也不替换草稿。

### 追加工作视图

通过 `ctx.slots.inject` 和 `ctx.slots.register` 向 `shell.details.view` 贡献新的 id 与本地化 label。注入 `detailViews` 并把动作投影到组件 props：`open(sessionId, id)` 选择并聚焦已注册视图；`close(sessionId)` 返回会话。两者对非当前 Session 都返回 `false`，open 也拒绝已移除的 id。应在根节点挂载后调用；过早调用会抛错。重复打开会再次聚焦，布局卸载后保留的句柄返回 `false`。原生 `ctx.layout.openDetails()` 选择原生 Tool 详情，不选择插件视图。

框架拥有导航，不拥有业务对象、授权、请求或编辑状态。视图接收标准 Session props，自行管理数据访问。关闭或切换会卸载插件视图。移除所选注册项会返回原生详情；重新安装不会抢走其他视图的选择。紧凑布局出现待处理交互时会返回原生会话，不回答或关闭该交互。

### 主题呈现

呈现器消费解析后的主题快照，并投影到 document：`html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，把主题的别名 token 与 `--dsh-content-font-size` 设为 body 上的内联变量，并持有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新。释放呈现器时，它会连同其他全局写入一起移除自己的元数据节点。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

一次 `register()` 调用把 `AppFrame` 贡献进 `'root'`，声明五个 child（`sidebar`、`conversation`、`details`、`shell.details.view`、`shell.overlay`），并安放布局 store。`ctx.layout` 和 `ctx.detailViews` 修改该 store；Slot 注册表仍拥有注册权威。稳定的可观测源投影存活视图的 label，包括 locale 变化。会话保持其树位置，strict 视图经 `SessionProvider` 渲染。所选 Session 标题与产品标题或本地化回退值组合。独立主题 effect 先应用调色板、字号与 token，再测量渲染背景。布局状态不读写 `localStorage`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当布局面不够用时阅读以下页面。它们从框架进入它所渲染的栏与它所呈现的主题。

- [ui-sidebar](../ui-sidebar/README.zh.md)——占据 `sidebar` 栏及其座位。
- [ui-conversation](../ui-conversation/README.zh.md)——占据 `conversation` 栏，拥有原生输入。
- [ui-chat](../ui-chat/README.zh.md)——拥有原生 `details` 及 Tool 详情 child。
- [ui-theme](../ui-theme/README.zh.md)——呈现器消费其解析快照的主题 seam。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册槽位。

-----

<a id="model-experience"></a>
## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前布局行为。它们是当前包约束，不是通用窗口管理器对比或任务积压。

- **选择是瞬时状态**——重新加载和 Session 切换（包括 blank 或未选中状态）会关闭详情，忘记所选视图与拖动后的宽度。
- **一次只有一个辅助视图**——不提供停靠管理器、对象 Tab、画布、时间线或持久打开对象列表。插件拥有各自视图内的领域导航。
- **原生关闭详情的结构**——原生详情以零宽度保持挂载，包括其无障碍投影。插件视图及切换控件在关闭时卸载；本扩展不包含完整的原生无障碍审计。
- **存储宽度不是渲染宽度**——让步求解器可能收窄它；紧凑模式占满框架。待处理交互会关闭紧凑详情，之后不会自动重新打开。
- **挤压重排期间无滚动锚定**——布局变化可能移动读者的视口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
