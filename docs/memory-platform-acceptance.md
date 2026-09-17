# Memory Platform 验收记录

日期：2026-09-17。范围：单 Host 的 Scoped MemoryStore、Harness Context 注入、可恢复写回、治理与 Trace 投影。

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 精确 namespace 隔离、TTL 与 tombstone | PASS | `memory-store.spec.ts` |
| local-vector 检索不跨 user namespace | PASS | `memory-retrieval.spec.ts` |
| 候选持久化、幂等写入、失败重试 | PASS | `memory-writeback.spec.ts` |
| 写回的 extract/write 执行事实进入 Trace 投影 | PASS | `memory-writeback.spec.ts`；`platform_memory_facts` 触发 Trace 刷新 |
| Manual CRUD、显式 legacy 导入、写回状态/重试 | PASS | 平台 RPC 与 `/platform` 管理页 |
| 旧 KV 自动出现在 scoped retrieval | PASS（拒绝此行为） | Scoped provider 仅枚举 `platform_memory`；legacy 只能由管理员显式导入 |
| 真实 embedding 与 extractor 服务 | SKIPPED | 当前 Host 未配置 `memoryEmbedder` 或 `memoryExtractor`；运行时保持降级，不把 fake embedding 当作真实演示 |
| 多 Host、Team scope、全系统隐私擦除 | SKIPPED | 不在本期单 Host Memory Platform 范围 |

## 验证命令

在 `D:/developer/Platform/deepseek-harness-master/` 执行：

```powershell
pnpm exec vitest run packages/business/agent-builder/tests/memory-writeback.spec.ts packages/business/agent-builder/tests/memory-store.spec.ts packages/business/agent-builder/tests/memory-retrieval.spec.ts packages/business/agent-builder/tests/runtime-memory.spec.ts packages/business/agent-builder/tests/runtime-memory-context.spec.ts packages/business/agent-builder/tests/trace-projection.spec.ts
pnpm exec tsc -p packages/business/agent-builder/tsconfig.json --noEmit
```

本次结果：6 个定向测试文件、16 项通过；`platform-workspace.e2e.ts` 的 2 项 Web 回放通过；Agent Builder TypeScript 编译通过。

## 已知限制

local-vector 对一个已授权 namespace 做精确 cosine 排序，单次最多检查 100 项、返回最多 10 项；它没有 ANN 索引。只有 Host 明确注入 embedding/extractor 服务时，Runtime 才执行语义检索或写回。配置、凭据与真实服务路由不写入测试 fixture 或此文档。
