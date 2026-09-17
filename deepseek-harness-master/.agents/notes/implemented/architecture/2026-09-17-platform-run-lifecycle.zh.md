# Agent Note：Harness 外的平台 Run 生命周期

Status: implemented

[English](2026-09-17-platform-run-lifecycle.md) | 中文

## 问题

仅有版本归因无法回答任务何时开始、取消是否完成，以及 Host 重启后保留什么输出。每次从完整 Session 推导列表行，还会让任务查询依赖对话记录可用性。

## 决策

[PlatformRuns](../../../../packages/business/agent-builder/src/platform-runs.ts) 管理单 Host 任务接受与持久化五态生命周期。它先写入 PENDING 和固定版本，再异步准备并调用 Session Controller。原 Harness Loop 仍是唯一执行驱动。Session 开始/结束观察先 flush 原始事件，再更新 Run 摘要；源事件序号保证投影幂等。Run 记录将有界生命周期事件与状态原子保存，原始模型/工具消息仍保留在 Session。

取消先记录意图，再调用 Harness。待执行任务取消后不可提交；运行任务保持 RUNNING，直到结束事实确认取消。迟到取消不能覆盖终态。Runtime 销毁先排空任务接受与启动操作，再关闭存储。冷读取对账旧接受记录，不重发任务；中断记为 FAILED，附明确原因与检测时间。存储失败保持可见，不伪造成功完成。

## 考虑过的替代方案

**只读 Session 投影**避免额外摘要，但不能直接表达任务接受或准备失败，且列表需要扫描对话记录。**独立执行服务与队列**在平台需要之前引入分布式与所有权协议。现有插件、Storage Domain 和共享执行身份已满足当前范围。

## 影响

结束后的 Run 查询不依赖完整对话读取。平台保存一份输入与有界最终输出引用，不复制对话明细。服务支持单写入 Host 和 shared-host 身份；自动重试、恢复、检查点、worker 调度和可靠跨进程事件投递不在范围内。取消不能撤销已完成的外部副作用，也不能强制不协作工具停止。检测到的结束时间不是精确执行耗时。

## 测试

[生命周期测试](../../../../packages/business/agent-builder/tests/run-lifecycle.spec.ts)覆盖五态转换与原因映射。[真实 Loader 测试](../../../../packages/bundle/business-agents/tests/composition.spec.ts)验证持久化任务接受、取消竞争、写入失败、旧记录与版本冻结。[Web 测试](../../../../apps/web/tests/agent-run.e2e.ts)使用无密钥模型验证直达详情、结果、失败和取消确认。
