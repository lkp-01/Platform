# Agent Note: 自助创建业务 Agent

Status: implemented

[English](2026-09-16-self-service-agent-authoring.md) | 中文

## Problem

业务用户需要创建可复用 Agent，无需编辑可执行 Cordis 配置或修改共享执行循环。所选模型必须在首次请求之前生效，且不能改变其他 Agent 的默认值。

## Decision

[创建服务](../../../../packages/business/agent-builder/README.zh.md)只接收业务字段，发布不可变 Preset 目录。UUID 提交标识派生目录身份；完整目录发布使重试和并发请求收敛到同一结果。现有 Preset 注册表发现并挂载结果。托管定义属于系统，通用文件编辑和删除操作不会破坏保存身份。

作用域 Prompt 插件通过不递归的变量替换提供用户原文。业务工具插件只注册配置子集，省略配置时保留原有完整默认集合。执行守卫拒绝未选工具，包括直接调用。

Session Controller 仅在新建 Session 路径提供初始化模型 waterfall。平台监听器解析 Preset 保存的模型；Controller 校验并在 setup 期间写入已有 model/selection 事件。所有创建入口共享此行为。恢复和复用保留已记录状态，初始化不写入全局默认值。

## Alternatives considered

- 数据库加生成 Preset 会在多实例部署需要之前引入两份配置表示。
- 启动时调用已有切换模型命令会写入 Host 默认值，使不同 Agent 互相影响。
- 只在新表单中初始化模型会遗漏已有选择器和默认创建路径。

## Consequences

创建 Agent 保存可复用定义，不调用模型；开始对话创建普通 Harness Session。定义编辑、删除、记忆配置和租户权限不在此 UI 范围内。模型必须已出现在配置目录中。基于模板复制支持迭代，历史记录保留原 Preset 身份。

## Testing

[创建测试](../../../../packages/business/agent-builder/tests/authoring.spec.ts)覆盖原子重试和无效配置。[组合测试](../../../../packages/bundle/business-agents/tests/composition.spec.ts)通过官方 Loop 验证生成 Preset 和不同模型路由。[浏览器测试](../../../../apps/web/tests/agent-builder.e2e.ts)覆盖表单、刷新与按配置创建 Session。
