# Agent Note: Scoped Memory execution facts and governance

Status: implemented

English | [中文](2026-09-17-memory-platform.md)

## Problem

Memory Item 已持久化且按 namespace 隔离，但运营人员不能通过 Platform API 治理它们。Run 结束后的提取也没有供现有 Trace 投影使用的持久事实，因此任务时间线无法显示这类后续工作。

## Decision

[PlatformMemory](../../../../packages/business/agent-builder/src/memory-store.ts) 仍是 Memory Item 的唯一所有者。[MemoryWriteback](../../../../packages/business/agent-builder/src/memory-writeback.ts) 将读取、提取和写入事实持久化到 `platform_memory_facts`；[PlatformTraces](../../../../packages/business/agent-builder/src/platform-traces.ts) 把这些事实投影到已有 Run 时间线。Trace 事实记录 store、scope、数量、状态和错误码，不记录 Memory 正文或 namespace subject。

Platform API 从认证 principal、归属 conversation 或已存在的 Agent 推导 user、session 和 agent subject。它提供作用域内 Item 的列表/读取、手工创建/删除、显式 legacy value 导入，以及 writeback 状态/重试。旧本地 KV 不会进入 scoped retrieval；管理员必须选择源 key 和目标 scope。`/platform` 编辑器显示 binding scope 与提取设置，MemoryStore 页面显示带来源的条目和 legacy 导入。

## Alternatives considered

**单独的 Memory Trace 产品**会重复记录 Run 执行事实，并使 Run 结束后的工作脱离现有 observability 路径。

**允许调用方传入任意 namespace subject**会让已知 user 或 conversation ID 绕过 scope 隔离。因此 API 会在访问 Item 前推导 subject。

**自动转换旧 KV 数据**会臆造 scope 和来源元数据。显式迁移保留 legacy 数据与新 scoped Item 的区别。

## Consequences

Memory writeback 不会把成功 Run 改成失败 Run。embedding 或 extractor 仍由 Host 提供；未配置时，读取或写回保持 unavailable/degraded。local provider 是有界精确 cosine retrieval，不是 ANN 服务，且此功能仍是单 Host。

## Verification

[Memory writeback tests](../../../../packages/business/agent-builder/tests/memory-writeback.spec.ts) 覆盖候选、幂等 Item 写入、失败重试与事实输出。[Memory isolation tests](../../../../packages/business/agent-builder/tests/memory-store.spec.ts) 和 [retrieval tests](../../../../packages/business/agent-builder/tests/memory-retrieval.spec.ts) 覆盖 namespace 隔离和向量过滤。验收记录见 [memory-platform-acceptance.md](../../../../../docs/memory-platform-acceptance.md)。
