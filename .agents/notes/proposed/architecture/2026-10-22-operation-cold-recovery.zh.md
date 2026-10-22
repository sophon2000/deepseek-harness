# Agent Note: 可恢复的本地 subprocess 操作

Status: proposed

[English](2026-10-22-operation-cold-recovery.md) | 中文

## 问题

消费者的资源预留可能比崩溃的 Host 和 runner 存活更久。现有 subprocess 服务通过 `SubprocessHandle.waitForExit()` 观察一个活跃进程范围，无法在重启后重新打开该范围。Windows 普通 subprocess 每次 spawn 使用一个由 runner 持有的匿名 Job。挂起创建、分配 Job、恢复线程的顺序还允许 runner 崩溃后留下未进入 Job 的挂起子进程。现有回执、直接进程退出、PID 不存在、经过时间或普通任务状态，都不能证明整个操作已经为空。

## 提案

在 subprocess Service Definition 中增加显式启用的操作能力，由 subprocess-local 实现。普通 spawn 和终端行为保持独立。消费者在任何关联的探测、编码、Python 进程或 runner 出现前创建一个操作，将其描述符持久保存到资源预留中，并通过该操作启动全部子进程。顺序启动之间的零活跃进程状态永远不代表开放操作完成。无法持久排除后续启动并观察原生范围的 provider 返回 `unsupported`；没有描述符的 legacy 回执返回 `unverifiable`，原因是 `legacy-no-scope`。

消费者拥有业务身份和资源预留状态转换；provider 拥有原生启动准入、持久封闭、范围终止和新取得的证明。新监管进程、消费者提供的 PID 列表或持久结果文件都不能建立静止证明。首个 Windows 实现支持普通当前令牌 subprocess；终端和受限令牌沙箱启动在宣告支持前，需要各自完成验证后的集成。

### 接口草案

以下概要对应 [operations.ts](../../../../packages/subprocess/subprocess/src/operations.ts) 中的导出契约。不透明标识使用仓库品牌类型；完整签名（包括 provider disposal）以源码声明为准。`OwnerKey` 由可信 Host 根据 home、project、domain 和 receipt 身份生成。客户端请求只携带回执 ID；Host 从持久存储中读取描述符和期望 owner。

```text
OperationDescriptor = {
  providerKind, providerVersion, locator: OpaqueLocator, ownerKey: OwnerKey
}
OperationScope = {
  descriptor: OperationDescriptor
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  seal(signal?: AbortSignal): Promise<RecoveryResult>
}
OperationProvider = {
  create(ownerKey: OwnerKey): Promise<Created | Unsupported>
  recover(descriptor, expectedOwnerKey, signal?): Promise<RecoveryResult>
  verify(proof: QuiescenceProof, descriptor, expectedOwnerKey): boolean
}
RecoveryResult =
  { kind: sealed-quiescent, proof: QuiescenceProof }
  | { kind: active, sealed: boolean, reason: busy | aborted | draining }
  | { kind: unverifiable, reason: LegacyOrIntegrityOrNativeFailure }
  | { kind: unsupported, providerKind, providerVersion }
```

`create` 仅在 provider 身份和启动状态持久保存后返回，此时尚无 runner 或目标进程。消费者在调用 `scope.spawn` 前持久保存描述符。资源预留写入失败后不得继续启动。dispose（资源释放）或显式恢复会封闭并终止操作；直接命令完成不会触发这两者。每个子进程保留正常的直接结果和流生命周期，只有操作本身报告操作静止。

`seal` 和 `recover` 都永久拒绝后续启动、终止现有成员并获取新的原生证明。中止信号只停止等待，永远不会重新开放准入，也不会把未知结果改成成功。`active` 表示创建者仍持有锁、持久封闭后等待原生进程排空，或观察被中止。身份读取、封闭提交、Job 打开或查询、限制验证失败时，返回带结构化原因的 `unverifiable`。未知 provider 版本永远不降级到 PID 检查。

`QuiescenceProof` 是由 provider 签发的进程内对象，带有私有签发者身份，并绑定描述符、期望 owner、机器身份、boot 身份和持久封闭代次。`verify` 只接受该 provider 实例在当前原生观察后签发的证明；JSON 副本、伪造对象、其他操作的证明或前一 provider 实例的证明都失败。永远不接受客户端传入或从磁盘重放的证明字节。provider 重启后恢复会取得新证明；消费者持久保存自己的协调进度，而不是原生证明的替代品。

### Windows 准入和观察

为整个操作使用一个密码学随机命名的 Job，并在全部顺序子进程之间保留 Host 句柄。启用 `KILL_ON_JOB_CLOSE`，禁用两种 breakaway 限制，确保目标永远不继承 Job 或准入锁句柄。每个 runner 只接收经过 provider 认证的操作指令，验证身份，并在 `CreateProcessW` 时使用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 和 `STARTUPINFOEXW`。可恢复启动不得使用创建后的 `AssignProcessToJobObject`，也不得将其作为回退。无法直接在 Job 内创建时，目标保持未启动，并以关闭方式失败。

每个创建者和恢复尝试都对现有的 provider 所有准入文件获取同一个 OS 独占锁，打开时不共享删除权限。创建者持锁验证不可变身份、检查封闭状态、取得 Job 句柄、将子进程原子创建到 Job，并完成初始恢复线程或清理。获取锁前暂停的 runner，在取得锁后重新检查。持锁 runner 被杀时，内核通过句柄清理释放锁；已经创建的子进程必然处于操作 Job 内。竞争者不能在现有准入文件缺失时创建替代文件。

恢复先取得该锁，验证可信描述符和期望 owner，持久提交不可逆封闭，然后才观察 Job。使用独占创建并检查 flush 的专用单向封闭记录，永远不原地覆盖开放状态为封闭状态，以免写入撕裂。重试前必须严格验证现有封闭字节，并重新成功执行持久性检查。身份记录撕裂、缺失、不可访问或不匹配时不得签发证明。永久保留封闭记录，防止迟到旧 runner 重新创建过期 scope；后续垃圾回收需要单独设计安全保留规则。

恢复在封闭持久化前持续持锁，验证 Job 限制，请求终止整个 Job，并查询 `JobObjectBasicAccountingInformation` 直到活跃进程为零。保留的命名 Job 句柄和永久封闭，使零结果不受后续 provider 启动影响。每个 `OpenJobObjectW` 失败（包括精确的对象不存在）都不能取得证明。Windows 可以在临时对象的 handle count 归零时移除名称，而 pointer 引用仍保留对象；终止也可能等待未完成 I/O。因此名称不存在不能证明静止。恢复绝不能为了查询空对象而创建替代 Job。provider 跨 active 和幂等恢复尝试保留经认证的 Job 句柄，直到 disposal。Host/runner 死亡后若丢失全部 Job 句柄，资源预留仍不可验证，即使测试另行等待了已知进程退出。

描述符将 provider 安装身份、boot 身份、owner key、操作随机数、Job 名称、命名空间和会话身份、schema 版本保存到经认证的 provider 所有记录中。locator 是在已配置可信本地根目录下解析的不透明值，永远不能指定任意文件系统路径。复制记录、其他机器、boot 不匹配、命名空间不匹配或未知版本都不能取得证明。实现通过 `NtQuerySystemInformation` class 90 读取内核 boot 标识，并拒绝不支持的状态、返回长度或全零标识。这项原生 ABI 依赖仍需平台资格验证；PID 不存在、进程年龄、估算的启动时间和新 provider run ID 都不能替代。boot 改变在单独验证的策略实现前一直返回 `unverifiable`。

可信存储必须拒绝重解析点替换，并有明确的 Windows DACL。威胁模型不涵盖已经具有可信 Host 全部文件系统和句柄权限的任意代码；Job 不是防御这种代码的安全沙箱。受支持进程范围包括普通 `CreateProcess` 后代，以及禁用 breakaway 时的 detached 子进程。WMI 创建进程等进程外 broker 不属于 Job 继承；使用这些 broker 的消费者，在没有额外经过验证的 provider 时，不能宣称相同操作保证。

### 基线能力核查

| 归属 | 已有能力 | 缺失要求 |
|---|---|---|
| `subprocess/src/types.ts` | 每次 spawn 的规范、直接结果、受管理范围等待 | 操作身份、多次启动、封闭、冷查找、证明 |
| `subprocess-local/src/windows-job.ts` | 私有 IPC 和 runner 所有范围；拒绝意外 runner 退出 | 持久操作注册、保留操作 Job、恢复 API |
| `subprocess-local/src/spawn-runner.ts` | 区分直接退出和 Job 活跃成员为零 | 共享操作准入；关闭子进程的 Job 不能封闭整个操作 |
| `win32-process/src/process.ts` | Kill-on-close、挂起创建、创建后分配、记账查询 | 原子 job-list 创建、命名重新打开、互斥、身份、持久封闭 |
| `win32-process/src/ffi.ts` | 共享 Koffi Win32 进程和 Job 绑定 | attribute-list API、扩展启动结构、命名 Job、可信文件和身份 API |

本地 provider 已记录的回退和每次 spawn 的 Job 生命周期继续适用于现有调用者。本提案不会提升其证明能力，也不会恢复历史匿名 Job。活跃 Agent Note 替代性检查未发现已有文档拥有操作冷恢复决策；现有每次 spawn 的约束决策仍然适用。

### Host 协调

Host 提议的端口可以保留 `sealed-quiescent | active | unverifiable | unsupported`。在恢复方法中增加 `expectedOwnerKey`，并要求释放资源预留前由 provider 验证进程内证明。先解析并认证 provider 记录，再将其 owner 与独立派生的期望 owner 比较，完成后才能打开或终止其 Job；两个回执交换有效 locator 必须失败。owner 派生包含可信持久 home 随机数；缺少该身份的现有 home marker 需要单独版本化的 Host 迁移，绝不能为 legacy 回执推断绑定。Host 持久标记 `reconciling`，执行幂等 domain 清理和终态处理，最后释放 journal 资源预留。Host 崩溃后重试会重新打开同一描述符，并取得新的 provider 证明。DSH 不拥有媒体清理、任务终态处理、容量记账或消费者的依赖 pin。

正常成功和取消在释放容量前同样要求永久封闭操作并验证整个操作静止。Host 锁序是先 project 生命周期 writer，再 capacity；清理不能在持有 capacity 时反向获取 project writer。DSH 只拥有自己的准入锁，持锁时绝不调用 domain 清理或获取消费者锁。消费者 adapter 除 fake-provider 协调测试外，还需要真实并发屏障测试。

### Microsoft 参考资料

job-list 创建属性从 Windows 10 和 Windows Server 2016 起可用；其原生值存储必须比 attribute list 存活更久。参见 [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)。

Job 后代、breakaway 标志、嵌套记账和 Job 销毁语义见 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。命名对象查找使用 [OpenJobObjectW](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-openjobobjectw)，整个 Job 的终止使用 [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)。持久封闭写入检查使用 [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)。

[Life Cycle of an Object](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/life-cycle-of-an-object) 区分名称空间生命周期和 pointer 引用。[TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess) 说明异步终止和未完成 I/O。这些规则要求命名 Job 缺失时保持不可验证；这里不声称已原生复现残留进程。

## 已考虑的替代方案

**持久保存 PID 和 runner 状态。** 不采用，因为 PID 复用、未知孙进程和 runner 崩溃无法建立操作的原生范围，也无法阻止迟到启动。

**给现有每次 spawn 的 Job 命名并查询零。** 不采用，因为后续 runner 可以在观察后创建工作，且一个操作可以包含多个顺序子进程。

**保留挂起创建后分配 Job。** 可恢复启动不采用，因为两个调用之间杀死 runner 会留下未受管理的挂起子进程。

**增加监管 daemon。** 不采用，因为这项能力必须通过持久 provider 状态和内核所有权完成恢复，不能引入新的长期进程。daemon 也需要自己的崩溃恢复证明。

**信任持久完成结果。** 不采用，因为文件可能过期或由客户端提供，不能建立当前原生静止或启动互斥。

## 验收标准

真实 Windows 测试必须覆盖 runner 启动前已有资源预留、持久封闭阻止迟到 runner、原子创建完成但恢复线程前立即强杀 runner、直接子进程退出后孙进程仍活着、detached 后代、拒绝 breakaway、Host 和 runner 同时死亡、原生查询失败、身份不匹配，以及两次顺序子进程之间出现零成员间隔。反向测试必须在 PID 复用或 PID 不存在、legacy 记录、不支持的 provider、伪造证明、描述符替换、身份或封闭记录撕裂、写入或 flush 失败、重复恢复时保留资源预留。

恢复被进程死亡打断时，必须在每个持久写入和原生查询检查点重试。恢复期间真实 OS 重启需要明确协调的手动 Windows 运行；测试工具不得重启用户电脑。模拟 boot 不匹配是独立反向测试，不能代替重启验证。平台失败保留为失败；减弱断言或降级回退都不能取得能力标志。

隔离分支已实现显式启用的 provider 和 Node/Koffi Job-list 路径。原生测试覆盖持久准入、多次启动、后代约束、签发者验证、写入和查询失败、真实 Host/runner 崩溃，以及恢复进程在 seal 创建、写入、flush、Job 打开、限制查询、终止和计数查询前后死亡。在同一已认证 Job 仍可重新打开时，重试重新验证完整 seal 并取得新的原生证据；中断留下的空 seal 永久阻止签发证明。释放过程在等待已持有 Job 排空前关闭恢复准入，拒绝关闭期间及释放后的调用。Cordis Loader 组合测试经过公开工厂。[产物 smoke](../../../../packages/subprocess/subprocess-local/verify/operation-artifact.mjs) 在并发独立消费者中验证普通包导出和构建后的 runner。这些检查不构成发布 artifact 的资格：真实 OS 重启、断电持久性、消费者集成，以及仓库构建和打包安装检查仍是独立验收要求。`active.sealed = false` 表示未确认 seal 状态，永不授权重新开放准入。

## 风险

断电持久性、对象命名空间身份、重解析点、DACL 和 boot 身份需要明确的原生验证。持锁者崩溃可能在排队工作仍存在时释放 OS 锁，因此每个 runner 必须在原生创建前立即持锁验证。拒绝 breakaway 可能使需要其他 Job 的程序无法启动；静默减弱约束会使恢复失效。永久保留封闭记录会占用磁盘空间。阻塞文件锁必须采用有界异步准入，以免忙碌创建者冻结 Host 事件循环。现有 legacy 资源预留仍不可验证，需要独立的操作员策略。
