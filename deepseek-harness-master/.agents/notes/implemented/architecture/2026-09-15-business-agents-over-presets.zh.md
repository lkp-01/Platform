# Agent Note: 基于官方 Preset 的业务 Agent

Status: implemented

[English](2026-09-15-business-agents-over-presets.md) | 中文

## Problem

业务团队需要不同角色提示词与工具，同时共享 Harness Loop、Session 生命周期和模型调用。

## Decision

复用 AgentPresets 服务作为注册表与启动器。Preset 目录就是 Agent Definition：目录 id、preset.yml 元数据，以及 agent.cordis.yml 角色与工具组合。可选业务 bundle 提供三个共享 Host 默认模型的定义，保留原有 Session 模型选择。

业务写入使用已提交的 tool/result 元数据与原有 Session 投影。SQLite 在有界只读子进程 中查询演示 CSV。浏览器菜单通过原有创建 API 新建独立 Session，并保留工作区归属。

本决策扩展[逐会话 Preset](2026-08-03-per-session-agent-presets.zh.md)，不替换其运行时职责。菜单选择使用创建路径；设置与 Creator 保留原有暂存选择路径。

## Alternatives considered

- 第二套 Registry/Factory 和 JSON Schema 会重复官方发现与组合能力。
- 独立可变模拟数据库容易在常驻 Preset 实例与 Session 间混用数据。
- 对固定演示数据执行任意 Python 或 Shell 会增加当前不需要的安全边界。

## Consequences

第四个 Agent 复用定义格式与插件；真正的新工具仍需实现插件。工具隔离覆盖既定部署，不承担企业租户授权。固定日期数据与模拟写入使演示可重复。真实提供商验收需要本地配置密钥。

## Testing

[组合测试](../../../../packages/bundle/business-agents/tests/composition.spec.ts)覆盖三类多步 Loop、工具拒绝与 Session 隔离。[Web 测试](../../../../apps/web/tests/business-agents.e2e.ts)验证名单、独立创建和可编辑输入框。[Worker 测试](../../../../packages/business/business-tools/tests/query.spec.ts)覆盖限制与取消。
