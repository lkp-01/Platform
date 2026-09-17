# Agent Note: Demo Agent 的共享资源

Status: implemented

[English](2026-09-17-shared-resources.md) | 中文

## Problem

业务 Agent 草稿选择实现层维护的工具名和模型路由。团队需要独立于任何 Agent、管理可复用配置及其版本的共享目录。

## Decision

AgentBuilder 包通过独立 SharedResources 存储类和 Remote 操作管理资源。资源中心维护 Model、Tool 和纯指令 Skill 的草稿、不可变发布版本、生命周期和引用查询。Agent 草稿中的精确引用成为第二版 Agent 快照内的资源清单。旧格式的 hash 和渲染保持兼容，发布资源不会修改 Agent 绑定。

模型路由复用已安装的 provider 和 Host 凭证，工具复用业务能力。Skill 作为字面系统指令预先加入，通过现有系统消息路径记录。组合后的提示遵守现有长度上限。部署及受管模型/工具执行检查资源可用性，不修改 Harness Loop。弃用资源保留已有引用可用，禁用和归档资源不能开始新工作，历史仍可读取。

## Alternatives considered

demo 尚无第二个消费者，独立包或服务会增加构建和部署接入。在 AgentBuilder 内保持独立存储即可保留生命周期边界。静态目录无法发布版本或说明引用关系，可变 Skill 目录无法保留 Agent 版本的指令。demo 范围明确排除认证和 RBAC，Owner 仅为展示元数据。

## Consequences

资源版本固定配置，不固定外部模型权重或服务实现。目录不能安装新 Adapter、管理 MCP Server 或 Knowledge Source、撤销已经发出的调用，也不能移除模型已经读取的指令。持久化基于单 Host 串行写入。旧可编辑配置经 Registry 保存时获得资源引用，不为历史执行伪造资源版本。

## Testing

[资源测试](../../../../packages/business/agent-builder/tests/shared-resources.spec.ts)覆盖重试身份、发布、重启、精确绑定及生命周期。[Web 测试](../../../../apps/web/tests/shared-resources.e2e.ts)使用实际 Loader 组合和无密钥模型，验证 Skill 注册发布、资源选择、发布 v2 后继续使用 v1、引用查询以及拒绝禁用依赖。模型可见工具名和固定 Skill 内容包含所属测试目录内的快照。
