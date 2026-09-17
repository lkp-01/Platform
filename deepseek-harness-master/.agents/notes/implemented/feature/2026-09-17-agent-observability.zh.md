# Agent Note: 基于共享执行事实的运行分析

Status: implemented

[English](2026-09-17-agent-observability.md) | 中文

## 问题

Run 时间线可以解释单次执行，却无法揭示共享依赖故障或版本层面的变化。直接累加通知会重复统计重试，任务成功也不能证明答案正确。

## 决策

AgentBuilder 从现有 Trace 投影和 Runtime 生命周期生成每个 Run 的紧凑分析记录。工具 journal 的尝试记录提供实际派发、结果和错误码；Session 结果不会重复计数。Runtime 保存人工操作归属和介入关联。Harness Agent Loop 保持不变。本功能扩展[Run Trace 决策](../architecture/2026-09-17-run-trace.zh.md)，后者继续负责源记录和时间线发布。

每条原子的 Storage Domain 记录包含一个 Run 的分析事实。持久化后替换已发布记录；查询消费不可变的已发布数据。启动时将历史 Run 加入队列，后台通知将变化记录加入队列，写入失败保留到后续重试。关闭时先停止 Runtime 生产者并保持存储可读，再排空观察者并关闭存储。在当前单 Host 规模下，这避免了多表 generation 的部分发布。

查询选择明确的 Run 样本或尝试时间窗口。成功率保留分子分母，取消和未知时间单列，分位数使用已知样本。模型 usage 保留缓存分项。版本化运维价格产生按币种区分的估算，缺价或缺 usage 不计入已定价覆盖。原始 usage 与路由不变时，重建保留已经应用的价格。

## 考虑过的替代方案

每次大盘查询扫描全部 Session 会让查询延迟受对话体积影响。独立遥测采集器会重复记录生命周期。在单 Host 工作负载尚无需求时引入分布式分析数据库会增加运维责任。紧凑读模型使普通查询独立于 Session 日志，并支持确定性重建。

## 影响

Agent 范围分析要求编辑权限，整个工作区分析要求管理员权限。每次查询及游标读取均检查当前成员资格。独立平台门户和可选 Host 客户端消费相同用例。不存在隐含全局管理员，也不根据 Owner 标签推断团队 ACL。

任务失败分类使用已记录的 code，不把邻近的最后一个工具错误猜作根因。Run 成功和线上版本比较不构成业务质量评估。旧数据可能缺少派发依据、缓存 usage、资源版本和人工归属；历史重建会反映这些缺口。回填幂等，进程重启后重新扫描；没有持久化扫描游标或多 Host 协调器。

## 验证

[投影测试](../../../../packages/business/agent-builder/tests/observability-projection.spec.ts)覆盖调用尝试、人工确认的未知结果和最小化分析记录。[统计测试](../../../../packages/business/agent-builder/tests/observability-metrics.spec.ts)覆盖分母、明确错误码与版本化成本。[组合测试](../../../../packages/bundle/business-agents/tests/composition.spec.ts)覆盖未读 Trace、存储故障与重载。[浏览器测试](../../../../apps/web/tests/agent-observability.e2e.ts)通过实际平台门户验证权限、版本比较、价格覆盖及 Trace 下钻。[容量测试](../../../../packages/business/agent-builder/tests/observability-performance.spec.ts)独立测量核心聚合，不混入 HTTP 和渲染开销。
