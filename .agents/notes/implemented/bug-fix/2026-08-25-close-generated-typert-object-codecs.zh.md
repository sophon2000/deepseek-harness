# Agent Note: 闭合 Typert 生成的对象 codec

Status: implemented

[English](2026-08-25-close-generated-typert-object-codecs.md) | 中文

## Problem

Typert 会把编译器生成的 Remote codec 标记为 `strict`，但固定属性的 TypeScript 对象此前使用 Zod 默认的 `z.object` 生成。该解析器会接受未知属性，再从结果中移除它们。因此，Client 编码器和 Host 解码器都会把 `{ title, projectId }` 之类的载荷转换成 `{ title }`，使未声明的身份或策略字段在业务代码或下游规范校验器拒绝它之前就消失。

同样的行为会递归影响嵌套 DTO 和生成的结果 schema。`Record<string, Value>` 和 JSON 索引签名等显式开放类型需要不同语义，因为它们的动态键本来就是声明类型的一部分。

## Decision

Typert Zod 生成器对每个包含固定 JSON 属性的对象声明或对象字面量使用 `z.strictObject`。未知属性会在 Client 和 Host codec 处失败，包括嵌套对象内部和生成结果中的未知属性，不再被规范化掉。

`Record`、显式 JSON 索引签名、`object`、`unknown`、`any` 关键字，以及仅含 unique symbol 的名义标记会保留原有的开放或擦除语义。固定属性对象与索引签名组合时，只对该索引 schema 接受的键保持开放。SRC 的 `src-json` codec 继续保持宽松，因为它没有编译器推导的属性信息。

## Alternatives considered

**在 Host Gateway 比较解析前后的值。** 不采用，因为 Client codec 仍可能在传输前移除属性，Gateway 会重复 schema 语义，而递归比较还需要复刻 Zod 变换与索引签名行为。

**生成 passthrough 对象。** 不采用，因为保留未声明属性虽然能避免静默删除，却会让 strict Remote 方法收到生成约定中不存在的字段。

**只闭合最外层 Remote 请求。** 不采用，因为嵌套 DTO 和生成的结果 schema 仍会丢弃未知属性，而且由同一类型图生成的 Typert 导出 schema 与 Remote schema 会出现不同行为。

## Verification

生成器测试会执行实际生成的 schema，并覆盖固定对象、嵌套对象、继承、交叉类型、空 DTO、`Record`、纯索引签名，以及固定属性与索引签名的组合。生成的 Remote 产物会拒绝外层 `projectId`、嵌套 `tenantId` 和未知结果属性。Client 运行时测试会证明含未知请求属性的调用不会触达载体；Gateway 运行时测试会通过 strict descriptor 发送外层和嵌套的伪造字段，并证明业务实现没有记录任何调用。构建后 LIB 集成测试还会让生成的 Client 与 Host bundle 跨越真实 HTTP 路由，分别拒绝 Client 侧 `projectId` 和直接伪造到 Host 侧的 `tenantId`，并确认 goal 状态与 session event 均未改变。

## Consequences

向生成的 strict 对象添加未声明属性会触发校验错误，不再作为可向前兼容的无操作处理。Remote DTO 演进必须先把属性加入公开 TypeScript 类型，并重新构建两端生成产物，调用方才能发送该属性。确实需要任意键的作者必须通过索引签名、`Record` 或其他显式开放类型表达这一意图。
