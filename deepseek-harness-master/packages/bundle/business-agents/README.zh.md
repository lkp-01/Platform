---
description: "在共享 Harness Web 核心上运行三个可配置的业务 Agent。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-business-agents

[English](README.md) | 中文

## 概述

在现有 Web 聊天中选择客服、数据分析或运营 Agent。每次选择都会创建拥有对应角色提示词和工具的独立 Session。三者使用 Host 默认模型和官方 Agent Loop。这个可选配置层提供本地演示数据和模拟写操作。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在仓库根目录执行 `pnpm install` 和 `pnpm run build` 后，将此配置层应用到 Web profile：

```sh
pnpm dsh --profile web --patch ./packages/bundle/business-agents/cordis.patch.yml --no-open
```

打开启动器打印的认证链接。选择工作目录后，使用输入框旁的 Agent 菜单。选择其他 Agent 会新建 Session；开始新对话按钮会为当前显示的 Agent 再建一个 Session。

通过本地进程环境或仓库 `.env` 提供 `DEEPSEEK_API_KEY`，不要提交密钥。模型调用需要有效密钥；演示工具不需要外部凭证。

| Agent | 工具 |
|---|---|
| Customer Service Agent | `knowledge_search`, `order_query`, `ticket_create` |
| Data Agent | `data_catalog`, `sql_query`, `dataset_read`, `data_analyze` |
| Operations Agent | `project_query`, `calendar_query`, `task_create`, `message_send` |

可以询问延迟订单 O-1002、2026 年 8 月收入下降最多的产品，或延期项目与跟进任务。演示业务日期固定为 2026-09-15，销售数据覆盖 7 月和 8 月。

新增第四个 Agent 时，在 `presets/` 下添加目录，并提供 `preset.yml` 和 `agent.cordis.yml`。目录名就是 id；元数据描述名称、简介和顺序；组合文件挂载角色与工具插件。复用现有工具，或为新能力实现插件，不需要修改 Loop。Session 模型选择继续使用官方 API。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

此[配置层](cordis.patch.yml)挂载记录投影并替换 Preset 发现目录。官方 [Agent Presets](../../preset/agent-presets/README.zh.md) 服务承担注册表与启动器职责。每份定义使用 [Persona](../../preset/persona/README.zh.md)、业务工具与官方上下文压缩插件。[业务工具](../../business/business-tools/README.zh.md)负责数据集与模拟操作。

[组合测试](tests/composition.spec.ts)通过 Loader 挂载真实 Preset 文件，并通过官方 Loop 执行多步工具调用。本包不发布独立运行时不变量检查：它只保存不可变资源路径，生命周期仍由现有注册表管理。

</details>

通过 Agent 选择器旁的 **Agent 工作台**，填写名称、Prompt、模型与工具创建 Agent，也可以使用现有 Agent 作为模板。定义保存在 Harness home 的 `business-agents/` 目录，无需重启即可出现。**开始对话**按保存的模型与所选工具初始化独立 Session。参见[自助创建 Agent](../../business/agent-builder/README.zh.md)。

<a id="model-experience"></a>
## 模型体验

### 业务角色和工具选择

#### 模型看到什么

每个 Session 接收选定的 `persona.prefix`，以及作用域内的业务工具 Schema。Host 模型配置对三个定义一致生效。工具结果进入原有对话历史。

#### Token 影响

一个角色提示词及三至四个工具 Schema 增加固定请求上下文。结果随任务变化，并遵循既有上下文压缩策略。

#### KV Cache 影响

相同定义的 Session 可以保持稳定提示词前缀；不同工具集会改变请求前缀。不保证提供商实际复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

此配置层用于本地第一阶段演示。

- SQLite 授权 API 需要 Node 24.12 或更高版本；本机验证版本为 Node 24.12。
- 本次启动中的业务定义替换官方与用户发现目录；不加载此配置层时仍可使用标准 Preset。
- 演示数据使用固定日期。模拟写入仅属于各自 Session；不包含 SaaS、完整 RAG、RBAC、任意代码执行或跨 Agent 工作流。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
