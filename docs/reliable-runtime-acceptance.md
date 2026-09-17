# Reliable Runtime 验收记录

日期：2026-09-17。

## 已交付

- Run 接受记录、原始输入、Agent 固定版本和 Runtime 策略先持久化，再由有界 Worker 池执行。重复提交 token 不会创建重复任务。
- 同一 Host 的同一 Run 只有一个执行槽；复用现有 JSONL 内核锁排除使用同一目录的第二个写入 Host。执行轮次写入 `runtime.attempt`，checkpoint 写入检查轮次。
- 步骤、工具派发和结果边界刷盘，并定期保存 checkpoint、心跳、期限和重试时间。重启后先对账已完成事实，再恢复同一 Run、Session、工作目录与固定版本。
- 工具体执行前持久化意图。安全工具的瞬时错误使用持久化指数退避与抖动，每次重新经过完整 Harness 工具守卫，保留原调用 ID。默认没有工具被声明为可安全重放。
- 不确定的外部写操作进入 BLOCKED，不自动重做。Web 支持记录“已完成”或“确认尚未执行”及核实依据，保存幂等恢复决定后继续。已完成结论作为人工依据交给模型，不伪造原工具返回。
- 取消意图先保存，再通知 Harness 停止；排队和退避中的任务取消后不会在重启时执行。运行中取消依赖适配器响应中止信号。
- 页面展示 RECOVERING、RETRY_WAIT、BLOCKED、执行轮次、checkpoint、下一次重试时间和期限。生命周期和工具尝试继续进入现有 Trace；仅心跳变化不重建 Trace。
- Host 整体关闭时先停止调度、取消并等待执行，再关闭记录和释放锁；避免已关闭 Storage Domain 导致清理中断。

DeepSeek Harness 仍拥有唯一的 Agent Loop。没有复制模型—工具循环；恢复使用既有 Session 恢复、维护执行和工具管线。核心改动仅导出现有 `SessionWriteLease` 供 Runtime 复用。

## 验证结果

在 Windows 本地执行，全部使用免密钥模型和隔离临时目录。

| 验证 | 结果 |
|---|---|
| AgentBuilder 与 checkpoint policy 相关测试 | 8 个文件、50 项通过 |
| 独立进程硬崩溃测试 | 5 项通过 |
| 实际 Loader + Web 页面测试 | 2 项通过 |
| Run、Trace、语言包客户端测试 | 3 个文件、10 项通过 |
| Host / Client TypeScript 项目检查 | 通过 |
| 完整构建及后续受影响 Host、Client、Web 构建 | 通过 |
| 修改范围 lint、依赖检查、`git diff --check` | 通过 |
| 文档同步检查 | 32 项通过，2 项受环境限制，见下文 |

硬崩溃测试通过杀死真实 Node 子进程，验证任务接受后未派发、模型执行中、工具派发前、外部副作用已发生但结果未知、最终答案已刷盘但 Run 终态未保存等边界。重启进程读取同一磁盘状态；断言模型调用次数、Run 状态和外部效果次数。该驱动仅替代 API 组合，使用真实 Harness Agent Loop、Tools、Session 和文件持久化；Web 测试另外覆盖实际产品组合。

其他重点验证包括：Provider 暂未就绪的退避、重复提交、并发上限、活动 Host 独占、原始输入不重复提交、工具重试经过全部守卫、人工核实决定幂等、退避中取消、周期 checkpoint 和期限结束。未进行真实操作系统重启、磁盘掉电或数小时负载压测。

文档检查的两个未通过项：

1. `verify-archived-agent-notes` 假设 Harness 位于 Git 根目录，读取 `HEAD:.agents/notes/archived/manifest.json` 失败；当前仓库实际路径带 `deepseek-harness-master/` 前缀。
2. 文档站测试创建文件符号链接时 Windows 返回 `EPERM`。该组其余 68 项通过；没有修改测试以绕过权限要求。

双语 README、实现记录、生成配置目录和 Cordis API 已同步。没有提交 Git commit，也没有改动仓库归档检查或系统权限设置。

## 当前边界与计划调整

- 交付的是单机器、单写入 Host、进程内 Worker 池；不包含独立 Worker 进程、跨机器抢占和 Kubernetes 调度。所有写入者必须使用同一规范目录，Windows 上还需同一操作系统登录会话。
- 复用内核锁而非 TTL 抢占；活着但卡住的 Host 保持所有权，心跳超时不会允许第二个写入者启动。
- 执行轮次直接保存在 Run，未新增独立 Attempt 表。工具尝试日志单独持久化，供恢复和 Trace 共用。
- 远端副作用不承诺 exactly-once。安全重试声明必须对应真实适配器的只读或外部幂等契约；不确定的嵌套工具调用需要调查、取消，不自动重建父调用。
- 旧格式任务不自动重放。终态保持不可变；可提交新任务，但设计中的 `retryOfRunId` 关联 API 尚未交付。
- 长任务具备周期 checkpoint、尝试次数、工具调用数、工具结果大小和期限预算。Session 与 Trace 的全历史保留仍沿用现有实现；完整增量 Trace 投影、历史清理和长期负载优化尚未交付。
- BLOCKED 可保持到人工决定或取消；已超过期限的任务不会因人工决定重新获得无限执行时间。

## 主要实现入口

- `deepseek-harness-master/packages/business/agent-builder/src/platform-runs.ts`：调度、恢复、checkpoint、取消和人工决定。
- `deepseek-harness-master/packages/business/agent-builder/src/runtime-tools.ts`：工具派发与结果日志、安全重试和恢复屏障。
- `deepseek-harness-master/packages/business/agent-builder/src/runtime-policy.ts`：持久化执行策略与预算。
- `deepseek-harness-master/packages/client/ui-agent-preset/src/client/RunDetails.tsx`：恢复状态和人工核实页面。
- `deepseek-harness-master/.agents/notes/implemented/feature/2026-09-17-reliable-runtime.md`：架构决定及取舍。

页面截图保存在 `docs/verification/reliable-runtime-blocked.png` 和 `docs/verification/reliable-runtime-recovered.png`。
