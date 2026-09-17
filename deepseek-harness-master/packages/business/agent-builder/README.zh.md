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

[Platform Run](src/platform-runs.ts) 在 Worker 创建独立 Harness Session 前，先保存任务接受记录、输入、固定版本和执行策略。状态为 PENDING、RUNNING、RETRY_WAIT、RECOVERING、BLOCKED、SUCCEEDED、FAILED 和 CANCELLED。提交 token 支持跨重启去重。格式三任务在启动后恢复；旧任务保留原中断行为，不自动重放。终态不可变。取消先保存意图，再请求 Harness 取消，并阻止后续 Worker 派发。存储读取失败仍作为错误报告。

版本 Preset 使用独立 `version-*` 目录，不参与旧资源导入。激活和启动前检查完整文件；依赖挂载成功后才能切换部署指针。已有 Session 恢复其记录的 Preset。外部文件编辑、插件代码变化、Host 系统提示词贡献和远程服务变化不属于冻结的业务配置；请求头和面向模型的消息记录实际执行内容。这是配置追溯，不保证确定性输出复现。

### 可靠执行

Runtime 负责有界的进程内 Worker 池和持久化调度。`root/.runtime-owner` 上的内核独占锁拒绝使用同一目录的第二个写入 Host。一个 Run 只分配给一个 Worker；递增的执行轮次用于识别 checkpoint 写入。心跳描述进度，不授权另一 Host 抢占所有权。所有写入者必须在同一机器使用同一规范目录；不支持共享网络文件系统或独立部署的 Worker。

Session 事件仍是执行事实来源。Worker 在步骤和工具边界刷盘，定期保存进度，并在发布终态前刷盘。重启时先核对持久化完成事实、补回已知但缺失的工具结果，再通过 Harness 恢复同一 Session 和固定版本。原始输入只提交一次；继续执行使用已记录的恢复消息。唯一的 Agent Loop 仍由 Harness 负责。尚未提交到边界的流式片段可能重新生成。

`platform_runtime_tools` Domain 在工具执行体之前记录派发意图，在下一步骤之前保存规范结果。结果丢失不代表写操作失败。不确定的写操作进入 BLOCKED；**记录核实结果**接受经外部核实的已完成或尚未执行结论、依据和幂等 token。完成结论以操作人员提供的依据传给模型，不伪造原始结果。未决嵌套工具调用需要调查并取消；本版本不能自动重建其父调用执行。

只有显式列入 `runtime.replaySafeTools` 的顶层工具，才允许对未知结果或配置的瞬时错误码自动重试。每次重试先持久化带抖动的指数退避时间，再使用原调用身份重新经过全部 Harness 工具守卫。默认列表为空。声明必须符合适配器的真实语义；具有副作用的 API 必须先建立外部幂等契约，才能声明安全。仅靠平台持久化无法保证远程副作用恰好一次。业务错误和授权失败不自动重试。取消是协作式的，无法撤销已派发的远程操作。

`runtime` Host 配置默认并发 4、每 1000 ms 轮询、每 5000 ms checkpoint、最多 5 次 Worker 执行、3 次工具尝试、24 小时期限、1000 ms 退避基数、10,000 次工具调用，以及每个持久化工具结果 1 MiB。任务接受时捕获策略；Worker 池并发和轮询仍使用 Host 设置。模型路由暂不可用时，在 Worker 尝试预算内等待。模型传输重试仍由 Harness 负责。任务预算耗尽后结束执行；不确定的工具恢复可能保持 BLOCKED，等待明确决定或取消。期限在执行边界及 checkpoint 检查，依赖适配器响应中止信号。

### 不可变执行适配器

[业务配置层](../../bundle/business-agents/README.zh.md)挂载创建服务，并把持久化目录加入 Preset 发现范围。打开 **Agent 工作台**，选择**创建 Agent**，填写四项内容并保存。**开始对话**会按该定义创建独立 Session。模型来自 Host 已配置的提供商，工具来自现有业务工具目录。不选择工具时创建纯对话 Agent。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 由 Host 管理、同时配置为 Preset 发现根目录的路径 |

名称与 Prompt 必填，分别限制为 100 和 32,000 个字符。浏览器不能提交插件路径、可执行配置或凭据。提交标识在单写入 Host 上跨重启去重相同重试；同一标识提交不同内容会失败。业务配置层把托管定义标记为系统所有，防止通用 Preset 删除和文件编辑操作使其身份失效。


### 共享资源

**资源中心**登记 Model、Tool 和纯指令 Skill 草稿，维护展示用的所属团队、发布不可变版本，并列出引用它们的 Agent 草稿和版本。资源目录在本包内使用独立 Storage Domain。资源状态包括正常、弃用、禁用和归档；弃用允许已有引用继续使用，禁用和归档阻止部署、启动及后续受管模型/工具调用。已发布记录保留。未设置 `governanceFile` 时，demo 使用现有 Host 共享访问；治理部署使用下述角色。

Agent 草稿选择明确的资源版本。第二版 Agent 快照保存已发布内容及摘要，发布资源不会自动升级 Agent。Skill 作为字面系统指令预先组合，通过现有系统消息记录，不从可变用户目录加载。原始 Prompt 与 Skill 内容合计遵守现有 32,000 字符组合上限。旧格式的 hash 和渲染保持不变；编辑旧草稿时把可用的已接入能力转换为资源引用。模型路由使用已有 Host 凭证，目录不接受或保存密钥字段。

Tool 资源选择现有业务能力，Model 资源选择已安装路由；目录不会安装 Adapter 或固定外部服务实现。按版本禁用、MCP 管理、Knowledge Source Adapter、Skill 脚本和附件暂不提供。资源生命周期检查不能撤销已发出的远端调用或模型已读取的指令。

### Workspace 治理

设置 `governanceFile` 后启用 `/platform` 认证入口。JSON 文件配置用户 ID、显示名称、各自随机凭证的 SHA-256 摘要、初始工作区和 `sessionHours`（默认 8）。可选的 `publicOrigin` 指定精确 HTTPS 来源；未配置时仅接受当前监听端口的 localhost 和 127.0.0.1 来源。本模式不提供密码注册、企业 IAM 或跨工作区共享。

WebServer 必须设置 `requireAccessPolicy: true`，在治理服务就绪前和策略卸载后拒绝请求。治理监听器仅开放平台页面与白名单 API；原生 Harness RPC、Session、附件、文件、全局事件和 WebSocket 路径不可访问。HTTP Cookie 使用 HttpOnly 和 SameSite=Strict，HTTPS 下增加 Secure。写请求要求匹配的 Origin 和 JSON。登录替换该用户已有的浏览器会话；退出、过期、用户停用或凭证轮换撤销访问。运维配置变更在重新加载后生效。

管理员管理成员、工作区可用性和资源。开发者协作编辑本工作区全部 Agent，保存版本、部署并查看工作区全部 Run。普通用户调用已部署 Agent，只能查看自己的输入、状态和最终结果；完整 Agent 配置、Trace 和其他用户的 Run 被拒绝。创建者和更新者 ID 用于审计，不代表个人独占修改权。成员修改保护最后一个有效管理员，并在移除后重新加入的情况下继续拒绝过期修订。

所有资源查询和绑定使用明确的工作区。幂等请求按用户和工作区隔离。工具仅在已绑定到接受任务的 Agent 版本、且在该工作区仍可用时执行。队列派发、模型步骤、工具派发和恢复检查当前执行权限；历史 `shared-host` 任务不会获得真实用户身份。权限撤销不会收回已经发出的外部调用。Runtime 继续使用 Harness 及其现有执行事实。

启动时校验持久化归属和引用，不改写历史 ID、版本 hash 或部署。运维配置必须包含既有工作区 ID；未知或冲突的引用导致启动失败。成员初始化只创建缺失的工作区，不恢复已移除成员。启用治理前备份存储并停止旧写入进程；回滚时整体恢复备份及对应配置。治理记录成功的成员和控制面变更，与执行 Trace 分开。控制面审计追加发生在业务提交之后；审计写入失败会报告失败，但业务变更可能已经持久化，因此重试应沿用同一个请求 token。

在仓库根目录执行 `pnpm exec tsx scripts/provision-platform-governance.ts --out ../.business-runtime/governance`，生成新的私有配置目录、覆盖配置和独立凭证文件，不打印秘密。目标目录已存在时拒绝覆盖。在现有 `dsh` profile 中将生成的覆盖配置放在 business-agents 覆盖配置之后，私下分发各用户凭证，再由工作区管理员通过成员页面添加已配置用户。平台的**导入已安装资源**操作仅为所选工作区注册已安装适配器。[治理决策](../../../.agents/notes/implemented/feature/2026-09-17-workspace-governance.zh.md)说明运输层的取舍。

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

## Agent 运行分析

Agent 分析可比较运行成功率、取消、耗时、Token 和版本。工作区管理员可检查依赖健康状况，并打开匹配 Run 的 Trace。工具尝试与逻辑调用最终结果采用不同分母；缺失的 usage 和价格保持未知。这些指标描述执行表现，不代表答案正确率。

分析复用 Trace 与 Runtime 事实，每个 Run 替换一条紧凑的持久化记录。后台对账包含从未查看过的历史 Run。页面展示数据覆盖和待处理投影；分析存储失败不决定任务结果。运维人员可设置 `observabilityRefreshMs`，以及包含版本化模型费率的 `observabilityPricesFile`；费率单位为每百万 Token 的整数微货币单位。未配置费率时成本保持未知。成本保留币种和实际应用的费率版本。

[Observability 决策](../../../.agents/notes/implemented/feature/2026-09-17-agent-observability.zh.md)说明统计与恢复机制。跨工作区管理员权限、业务质量评估和分布式分析不在本单 Host 功能范围内。

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
