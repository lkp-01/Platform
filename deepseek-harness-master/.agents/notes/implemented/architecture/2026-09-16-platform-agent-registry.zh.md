# Agent Note: 平台 Agent 资源归属

Status: implemented

[English](2026-09-16-platform-agent-registry.md) | 中文

## Problem

不可变执行 Preset 无法表达长期存在的资源，其归属、描述和草稿需要独立于历史 Session 修改。

## Decision

[Registry](../../../../packages/business/agent-builder/README.zh.md#resource-registry) 通过 Storage Domain 管理资源身份、元数据、当前草稿与归档状态。现有创建包提供传输和目录，独立 UI 页面提供资源导航。单写入创建队列和 Domain 更新实现重试去重及乐观编辑锁。

[Preset 创建决策](2026-09-16-self-service-agent-authoring.zh.md)继续约束执行适配器。资源草稿不会重写执行 Preset。旧定义导入保留身份和初始创建指纹。新草稿没有已发布版本或部署；这些事实由 Version、Runtime 和 Deployment 管理。

## Alternatives considered

**可变 Preset**会使资源编辑影响历史 Session 恢复。独立草稿保留执行配置。

**独立 Registry 与 API 包**在缺少第二个使用方时会重复已有目录和传输装配。创建包内的独立模块分离职责，同时减少构建改动。

**强制 SQLite**没有必要，因为已有 Domain 支持 JSON 和 SQLite。部署继续决定后端路由。

## Consequences

共享 Host 配置提供组织空间与团队引用，不代表认证后的租户成员关系。多个写入 Host 尚不支持。Registry CRUD 不调用模型或工具。归档保留历史，并通过 Session Controller 钩子阻止新建旧式 Session；可信进程内直接组合 Harness 不属于平台授权范围。

## Testing

[Registry 测试](../../../../packages/business/agent-builder/tests/registry.spec.ts)覆盖持久化、重试、编辑冲突、空间边界与归档。[Web 测试](../../../../apps/web/tests/agent-registry.e2e.ts)覆盖真实组合、传输、草稿冲突和深链接恢复。
