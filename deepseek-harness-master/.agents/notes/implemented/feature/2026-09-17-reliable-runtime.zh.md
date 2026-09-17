# Agent Note：单 Host 可靠 Runtime

Status: implemented

[English](2026-09-17-reliable-runtime.md) | 中文

## 问题

Run 记录能够解释过去的执行，却不能保证已接受任务在进程丢失后继续。写操作结果丢失后直接重试可能重复外部副作用。

## 决定

AgentBuilder 负责持久化任务接受、有界进程内 Worker、捕获预算、协作取消和恢复。导出现有 JSONL 内核写锁，并复用于 Host 独占所有权。Harness 插件提供工具派发屏障、规范结果观察和步骤前持久化。原 Harness Agent Loop 保持不变。

工具日志在派发前记录意图，在继续执行前保存结果。恢复保留调用身份，并重新进入完整工具流水线。明确声明安全的操作可以使用持久化退避重试；不确定的写操作等待操作人员记录核实依据。Run 事件和工具尝试记录进入现有 Trace 投影。仅 checkpoint 心跳变化不会重建 Trace。

## 考虑过的替代方案

另建 Agent Loop 会重复 Harness 语义。仅靠 TTL 的所有权可能让暂停的写入者在另一 Worker 获取任务后恢复写入。当前单 Host 内核锁提供更小且可测试的所有权边界。将所有 pending 工具视为可安全重试会重复写入。重复调用中间件 next 会跳过已消耗的策略处理器，因此维护恢复重新进入 Tools。

## 影响

这是单机器、进程内 Worker 并发执行，不是分布式调度。取消无法撤回远程副作用。不确定的嵌套工具调用保持阻塞。存储与外部幂等契约决定持久化和副作用保证。旧任务不会被静默重放。长任务具有有界执行策略和定期 checkpoint；Trace 仍在相关执行事实变化时折叠完整历史，因此完整增量投影和保留清理仍延期。

## 测试

[Runtime 测试](../../../../packages/business/agent-builder/tests/runtime-recovery.spec.ts) 覆盖接受任务、Provider 就绪、取消、有界并发、重启、独占所有权、工具守卫与人工对账。[硬崩溃测试](../../../../apps/cli/tests/reliable-runtime.expected.e2e.ts) 在任务接受、模型、派发与终态边界杀死真实子进程，使用真实 Harness 执行和文件持久化；子进程驱动仅替代 API 组合。[Web 测试](../../../../apps/web/tests/agent-run.e2e.ts) 通过免密钥模型覆盖实际 Loader 组合和人工恢复页面。
