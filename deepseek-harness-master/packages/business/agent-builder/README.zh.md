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

<a id="resource-registry"></a>
### 资源 Registry

侧栏 **Agents** 页面管理稳定资源，提供描述、组织归属、Harness 选择和可编辑草稿。[Registry](src/registry.ts) 在 `platform_agent_registry` Storage Domain 中保存当前配置，使用部署的后端（默认基础配置为 JSON，可路由到 SQLite）。更新要求提供加载时的修订号。归档/恢复保留身份和历史；归档资源不能编辑或新建旧式 Session。

Host 配置支持 `workspaceId` / `workspaceName`（默认 `shared` / `Shared workspace`）与 `ownerTeamId` / `ownerTeamName`（默认 `shared-team` / `Shared team`）。这些是明确的共享 Host 引用，不代表认证后的租户成员关系或文件系统 Workspace。Registry 数据只允许一个写入 Host。创建 token 支持跨重启重试去重，即使后续已编辑资源，改变原请求内容仍会被拒绝。

启动时幂等导入有效旧定义，无效条目显示在目录诊断中。原 Preset 保持不变，旧式创建也会登记资源。如果资源提交后 Preset 发布失败，可用原创建 token 重试恢复。内置定义保持为模板。草稿编辑不会重写已有 Preset。新资源保持草稿，直到开发者显式保存版本。

### 版本、部署与 Run

**保存为新版本**捕获已保存草稿修订号、Prompt 原文、模型路由、所选工具、已支持且解析完成的模型参数，以及格式一的组合设置。版本号在每个 Agent 内递增，版本记录不可编辑或删除。保存不会部署；**部署**为当前 Host 后续任务选择默认版本。**回滚**激活已保存旧版本，不改变草稿或正在执行的任务。依赖或持久化失败时保留原部署。

[Version](src/versions.ts) 与 [Deployment](src/deployments.ts) 使用独立 Storage Domain。每个 Agent 的版本序号与重试凭据在一条串行化记录中提交；部署指针、历史和凭据也共同提交。Registry 串行控制将这些操作与草稿编辑、归档排序。模型或工具下线后历史快照仍可读取。单 Agent 记录随保留历史增长，只支持一个写入 Host。

[Platform Run](src/platform-runs.ts) 先持久化任务接受记录与输入，再准备固定版本并创建独立 Harness Session。每个 Run 只有 PENDING、RUNNING、SUCCEEDED、FAILED、CANCELLED 五种状态。Harness 事件驱动保存开始/结束时间、有界最终答案摘要、输出引用与结构化错误；列表查询读取任务记录，不扫描对话明细。重复提交标识不会再次发送任务。取消会阻止待执行任务提交，或请求原 Harness 取消；执行停止前保持 RUNNING。进程中断归为 FAILED，附 EXECUTION_INTERRUPTED 和检测时间，不重发任务。终态不可变；启动时结合原 Session 事件对账旧记录与未结束任务。存储读取错误直接报告，不伪造执行失败。Session 和 Preset 授权钩子保持固定配置与普通 Session 行为。

版本 Preset 使用独立 `version-*` 目录，不参与旧资源导入。激活和启动前检查完整文件；依赖挂载成功后才能切换部署指针。已有 Session 恢复其记录的 Preset。外部文件编辑、插件代码变化、Host 系统提示词贡献和远程服务变化不属于冻结的业务配置；请求头和面向模型的消息记录实际执行内容。这是配置追溯，不保证确定性输出复现。

### 不可变执行适配器

[业务配置层](../../bundle/business-agents/README.zh.md)挂载创建服务，并把持久化目录加入 Preset 发现范围。打开 **Agent 工作台**，选择**创建 Agent**，填写四项内容并保存。**开始对话**会按该定义创建独立 Session。模型来自 Host 已配置的提供商，工具来自现有业务工具目录。不选择工具时创建纯对话 Agent。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 由 Host 管理、同时配置为 Preset 发现根目录的路径 |

名称与 Prompt 必填，分别限制为 100 和 32,000 个字符。浏览器不能提交插件路径、可执行配置或凭据。提交标识在单写入 Host 上跨重启去重相同重试；同一标识提交不同内容会失败。业务配置层把托管定义标记为系统所有，防止通用 Preset 删除和文件编辑操作使其身份失效。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[创建服务](src/index.ts)校验选项，通过同级暂存目录完整发布固定[配置](src/definition.ts)。Preset 发现仍是唯一运行注册表。[Prompt 插件](src/prompt.ts)通过变量值提供用户原文，保留字面模板语法，并拒绝未选工具的执行请求。Session Controller 在发布新 Agent 之前通过初始化模型钩子解析已保存模型；已有会话保留已记录的选择。不需要独立执行循环、会话存储或运行时不变量伴随模块：持久化只有一个不可变表示，注册效果负责清理。

</details>

本包不发布运行时不变量伴随模块，因为 Storage Domain 负责已提交记录，每次接受任务都在调用 Harness 前检查确切版本与执行产物。插件卸载会停止接受任务，排空启动与执行结束处理，再关闭其拥有的 Domain。生命周期事件与 Run 在同一记录中原子保存，通过现有 Storage Domain 变更通知发布；这不是持久化消息总线。

### Run Trace

[PlatformTraces](src/platform-traces.ts) 通过已有 Agent 流通知记录模型调用起点，从原始 Session 与 Run 记录投影模型结算、工具调用/结果、重试事实和最终答案。`platform_run_traces` Storage Domain 保存模型起点、每页最多 100 个事件的版本化页面及摘要。页面先落盘，再由摘要发布版本；写入失败可重放而不会重复计数。关闭时先结算 Run，再排空 Trace 写入。Trace 不驱动执行，也不改变 Run 结果。

`runTraceGet` 和 `runTraceEvents` 使用与 Run 查询相同的 workspace/Agent/Run 归属校验。游标绑定单个 Run 与版本；版本变化后需从首页读取。普通查询使用已保存页面。相关执行通知合并触发源日志对账；历史 Run 在首次访问时重建。目前对账折叠完整源日志，因此长时间运行的任务比增量检查点投影需要更多计算。无需远程遥测后端。

Host 选项 `tracePreviewChars` 默认 4000 个 Unicode 码点，范围为 64–16000。预览隐藏常见凭证字段并保留截断标记；这不保证任意文本完全不含敏感信息。原始 Session 内容沿用现有访问策略。缺失的模型起点、恢复生成的工具结果与缺失用量保持未知。模型耗时为观察到的开始至结算区间；工具耗时包含 Harness 调用链。缓存输入计入总输入，推理 Token 属于输出子集，统计不完整时明确标注。进程骤停可能丢失尚未 flush 的源事实。多 Host tracing、自动保留策略、分布式 span 和跨 Session 聚合不属于本包范围。

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
- 支持一个默认 Host 部署。分支、合并、差异比较、多部署环境、租户授权、自动重试和评测评分延期实现。旧 Session 不追溯补造平台版本或 Run 身份。
- 工具目录使用本地演示数据和模拟写入。新工具与模型提供商需要由部署负责人先行配置。
- 模型目录校验不证明远程凭据、配额或服务可用；运行错误仍通过现有 Session 流程展示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
