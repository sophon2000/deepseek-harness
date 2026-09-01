# Agent Note: 追加式 Session 详情视图

Status: implemented

[English](2026-08-31-additive-session-details-views.md) | 中文

## 问题

原生 `details` slot 已有 owner。用插件工作区替换它会移除原生 Tool 详情；overlay 又不为会话预留空间。Session 作用域的插件需要展示对象的位置，但不应拥有聊天运行时或读取其私有状态。

## 决策

`ui-layout` 声明追加式 `shell.details.view` 列表并提供 `ctx.detailViews`。注册项使用插件自有 id 和本地化 label。导航接收发起动作的 Session id，拒绝非当前或已移除的目标。根 store 拥有所选视图与焦点 revision；Slot 注册表拥有注册生命周期。原生 `details` slot 保持不变，`layout.openDetails()` 选择原生详情。

桌面布局预留现有可缩放栏。空间不足时详情占满框架，会话隐藏但不卸载。Escape 和返回动作恢复可达焦点。待处理交互让紧凑详情返回会话，不回答该交互。切换 Session（包括 blank 或未选中状态）以及重新加载都会重置选择。移除所选视图会返回原生详情；移除布局会撤销保留的导航句柄。

Host 没有新增领域 API、授权、持久格式或模型可见 Tool。插件仍负责对象身份、精确 revision、数据访问和取消。本 fork 源码不改变已安装的 `vh.1` 产物；发布与消费方冷安装资格仍是独立的发行工作。

## 考虑过的替代方案

**扩展原生 Tool 详情 owner。** 其内容和选择属于聊天。布局拥有宽度和可见性，因此在布局追加通用视图，避免把业务工作区耦合到 Tool 选择。

**Overlay 或替换 root。** Overlay 不预留空间；替换 root 则重复原生输入、审批和导航职责。两者都不满足共存要求。

**只用会话 Tab。** 这适合单个全页视图，但不满足桌面会话与工作区同时可见的要求。

## 影响

一次只渲染一个辅助视图。不提供停靠管理器、持久对象 Tab 模型、画布或时间线。切走会卸载插件视图；持久编辑不能只保存在组件状态。根挂载前调用会抛错；陈旧 Session、已移除注册项和已释放服务句柄返回 `false`，不导航。布局读取待处理交互状态，但不接管交互结算。

## 验证

`ui-layout/tests` 覆盖导航守卫、注册表卸载与重装、焦点、紧凑布局、Session 重置和待处理交互。`apps/web/tests/auxiliary-detail-views.e2e.ts` 通过真实 Loader 与浏览器产物图加载仅测试使用的私有 profile；覆盖两个独立插件 fiber、原生草稿保留、紧凑几何、重新加载及基于无密钥模型记录回放的真实原生审批。现有 GUI 和 Web 测试通道覆盖不含测试插件的 profile。默认采用前，消费方安装资格仍须对新的不可变 fork 产物族执行验证。
