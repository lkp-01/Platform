---
description: "通过 Prompt、已配置模型和所选工具创建可复用的业务 Agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-builder

[English](README.md) | 中文

## 概述

通过名称、角色 Prompt、模型和工具选择创建 Agent。保存一次，之后按需开启独立对话。可以使用内置业务 Agent 作为模板，也可以从空白表单开始。保存时不会调用模型或执行业务工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

[业务配置层](../../bundle/business-agents/README.zh.md)挂载创建服务，并把持久化目录加入 Preset 发现范围。打开 **Agent 工作台**，选择**创建 Agent**，填写四项内容并保存。**开始对话**会按该定义创建独立 Session。模型来自 Host 已配置的提供商，工具来自现有业务工具目录。不选择工具时创建纯对话 Agent。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 由 Host 管理、同时配置为 Preset 发现根目录的路径 |

名称与 Prompt 必填，分别限制为 100 和 32,000 个字符。浏览器不能提交插件路径、可执行配置或凭据。提交标识跨进程和重启去重相同重试；同一标识提交不同内容会失败。业务配置层把托管定义标记为系统所有，防止通用 Preset 删除和文件编辑操作使其身份失效。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[创建服务](src/index.ts)校验选项，通过同级暂存目录完整发布固定[配置](src/definition.ts)。Preset 发现仍是唯一运行注册表。[Prompt 插件](src/prompt.ts)通过变量值提供用户原文，保留字面模板语法，并拒绝未选工具的执行请求。Session Controller 在发布新 Agent 之前通过初始化模型钩子解析已保存模型；已有会话保留已记录的选择。不需要独立执行循环、会话存储或运行时不变量伴随模块：持久化只有一个不可变表示，注册效果负责清理。

</details>

本包不发布运行时不变量伴随模块，因为定义只有一个不可变表示，且 Cordis effect 负责注册清理。

<a id="model-experience"></a>
## 模型体验

### 用户角色与所选能力

#### 模型看到什么

用户 Prompt 作为原文角色说明进入正常系统提示词，包括 `{{customer}}` 这样的文本。模型接收所选业务工具 Schema 和普通工具结果。保存的 provider/model 路由初始化新对话，不改变 Host 默认模型。

#### Token 影响

Prompt 长度和所选 Schema 数量决定新增输入 Token。创建定义不消耗模型 Token。现有上下文管理处理对话历史。

#### KV Cache 影响

不可变定义保持角色与工具前缀稳定。不同 Prompt 或工具选择会改变前缀；不保证提供商复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

本包面向当前单 Host 业务部署。

- Agent 在现有 Host 访问范围内共享，不提供用户所有权、记忆设置或权限编辑。
- UI 中的定义不可变。需要调整时通过模板创建新定义；外部直接编辑文件不属于支持流程。
- 工具目录使用本地演示数据和模拟写入。新工具与模型提供商需要由部署负责人先行配置。
- 模型目录校验不证明远程凭据、配额或服务可用；运行错误仍通过现有 Session 流程展示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
