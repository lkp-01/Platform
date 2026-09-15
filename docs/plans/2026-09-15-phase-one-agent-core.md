# 第一阶段统一 Agent Core 执行与验收计划

**Goal:** 让 Customer Service、Data、Operations 三个业务 Agent 通过不同配置，共享现有 DeepSeek Harness 执行核心。

**Architecture:** 直接将业务 Agent Definition 映射到官方 Preset 目录，复用 AgentPresets、Persona、Tool Plugin、Session Controller 与 Agent Factory。新增业务工具与轻量 Web 选择流程，不新建 Agent Loop、Session 存储或通用 Platform Runtime。

**Tech Stack:** 当前仓库的 TypeScript ESM、Cordis、React、Typert Remote、pnpm、Vitest、Playwright；数据示例采用 CSV 与只读 SQLite。

**状态：** 待执行的计划；源码阅读结论不等于运行验证。本次仅新增本文档，没有修改 Harness 实现、安装依赖、调用模型或执行测试。

## 1. 范围与关键决策

本阶段解决业务团队重复搭建 Harness 的问题。业务差异由配置和工具插件表达，执行流程、上下文、模型调用和工具调用仍由官方组件负责。

| 产品抽象 | 第一阶段实现 | 是否新建机制 |
|---|---|---|
| Agent Registry | 官方 `ctx.agentPresets` 的发现、列表、解析和挂载 | 否 |
| Agent Definition | 一个 Preset 目录：目录名 + `preset.yml` + `agent.cordis.yml` | 否，定义统一编写约定 |
| Agent Factory / Launcher | Session Controller → `ctx.agents.create()` → 官方 AgentFactory | 否 |
| Agent Selector | 复用 `ui-agent-preset`，补齐明确选择、创建和等待状态 | 小幅扩展 |
| 业务工具 | 三个 Cordis 工具插件包 | 是 |
| 模型配置 | 三个 Agent 共同引用 `agent-default-model`；保留官方 Session 模型选择 | 复用 |
| 工具权限 | Preset 作用域、工具注册集合、必要的继承过滤 | 复用，无 RBAC |

方案比较：

1. **推荐：官方 Preset 即业务定义。** 最少新增概念，原生支持发现、隔离、历史身份与选择 UI。
2. 新建 `agents.yaml`，转换为 Preset。能获得单文件格式，但增加解析、转换与两份配置一致性问题，当前没有必要。
3. 新建独立 Agent Registry、Factory 和运行服务。与官方现有能力重叠，增加生命周期风险，本阶段不采用。

模型范围按用户“当前阶段不考虑 model 配置的不同”执行：三个定义都引用同一 Host 默认模型，不新增按 Preset 路由模型的功能。现有 Session 级模型选择仍可用。**按业务定义自动选择不同模型不是本阶段交付承诺**；不能在 `preset.yml` 中写一个当前解析器不读取的 `model` 字段，然后声称已经实现。

不开发多租户、RBAC、Memory 平台、完整 RAG、Durable Runtime、长任务恢复、Evaluation/Observability 平台、成本统计、Marketplace、多 Agent 协作、真实 SaaS/OAuth。官方已有持久化、上下文处理及其他基础服务继续复用；“不开发”不意味着删除官方已有实现。

## 2. 七项源码调查结论

以下链接相对本文档指向已下载的源码。后续文件列表中的路径均相对源码根目录 `D:/developer/Platform/deepseek-harness-master`。

| 调查项 | 当前代码与结论 | 计划影响 |
|---|---|---|
| Agent 在哪里创建 | [Session Controller](../../deepseek-harness-master/packages/api/session-controller/src/agent.ts) 的 `composeAgent/createOrAdopt`，调用 `ctx.agents.create`；[Agent Loop](../../deepseek-harness-master/packages/core/agent-loop/src/index.ts) 的 `createAgent/setupAndPublish` 承接创建、setup、发布 | 复用官方创建窗口，不直接实例化另一套 Agent |
| Preset 如何工作 | [AgentPresets](../../deepseek-harness-master/packages/preset/agent-presets/src/index.ts) 扫描根目录、resolve、mount；[Preset 类型](../../deepseek-harness-master/packages/preset/agent-presets/src/preset.ts) 描述身份 | 已经满足 Registry；每个 Preset 在进程内有共享挂载作用域 |
| Prompt 如何加载 | [Persona](../../deepseek-harness-master/packages/preset/persona/src/index.ts) 通过 `systemPrompt.section()` 注册 prefix/suffix，支持模板和 complete 模式 | 在 Preset 挂载官方 Persona，不另建 prompt engine |
| Tool 如何注册 | [Tools](../../deepseek-harness-master/packages/core/tools/src/index.ts) 提供 `defineTool/register/schemas/get/execute/restrict/guard`；注册通过 Cordis effect 管理 | 业务插件只提供 schema 与执行逻辑，Loop 原样复用 |
| Model 如何指定 | [默认模型服务](../../deepseek-harness-master/packages/core/agent-default-model/src/index.ts) 提供 `currentSelection()`；[Session 命令](../../deepseek-harness-master/packages/api/session-controller/src/commands.ts) 有 `selectModel` | Host 共享默认模型；模型不是现有 Preset 元数据字段 |
| 前端如何创建 Session | [Workspace navigation](../../deepseek-harness-master/packages/client/ui-workspace/src/client/navigation.ts) 的 `connectWorkspace()` 可能复用空 Session，否则 `sessions.create({workspaceId})`；[SessionCreateRequest](../../deepseek-harness-master/packages/api/session-controller/src/types.ts) 已支持 `agentPreset` | 需要让选择值进入现有创建参数，并避免跨 Agent 复用空 Session |
| 前后端数据流 | [Preset seat](../../deepseek-harness-master/packages/client/ui-agent-preset/src/client/seat-store.ts) 暂存选择，随后调用 `remote.agentPresets.select`；[Session transport](../../deepseek-harness-master/packages/api/session-controller/src/client/transport.ts) 接收官方 Remote journal/control streams | 继续使用 Typert 和现有流式聊天，不引入新的 REST/WS 协议 |

补充事实：

- [preset.yml 解析器](../../deepseek-harness-master/packages/preset/agent-presets/src/metadata.ts) 只读取 name、description、order；id 来自目录名。显示元数据解析失败可能退回 id，因此业务配置的验收应额外检查名称和描述完整。
- [Web bundle](../../deepseek-harness-master/packages/bundle/web-app/cordis.patch.yml) 已禁用 base 层多种全局工具，由 Preset 挂载具体工具。不能只阅读 base 层就断言所有 Agent 都有 Shell。
- 官方只允许空 Session 切换 Preset；已有消息或工具调用后，Session 的组合锁定。该行为符合本项目，不应绕过。
- 同一个 Preset 的插件实例会由多个 Session 共享。新增工具若使用模块级可变数组保存工单/任务，就可能串会话；业务状态必须按 Session 隔离。
- [standard Preset](../../deepseek-harness-master/packages/preset/agent-presets/presets/standard/agent.cordis.yml) 有大量编码、Shell 和委派工具；[minimal Preset](../../deepseek-harness-master/packages/preset/agent-presets/presets/minimal/agent.cordis.yml) 也包含持久 Shell。两者都不适合直接作为客服安全工具集。

## 3. 目标调用链

```text
用户选择业务 Agent
  → 官方 AgentPresets 列表及元数据
  → 现有 Session create({ workspaceId, agentPreset })
  → 后端 resolve(presetId)，从受信配置根目录读取定义
  → ctx.agents.create({ meta: { agentPreset }, setup })
  → setup 内 mount 对应 Preset；模型采用共同的 agent-default-model
  → 官方 Agent Loop：LLM → Tools → LLM → Final
  → 现有 Session 事件与 Remote 流
  → 原有聊天界面展示消息与工具结果
```

前端只传 Agent/Preset id 和现有 Session 创建字段；Prompt、工具插件、文件路径与实际模型路由由后端解析，不接收浏览器上传的任意插件配置。

## 4. Agent Definition 与配置布局

建议把业务组合封装在独立 bundle 中，保持官方自带 Preset 原样：

```text
packages/bundle/business-agents/
  package.json                  # 按仓库 dsh.bundle 约定声明 patch 与依赖
  cordis.patch.yml               # 部署组合：preset root、默认 Agent、共享模型引用
  src/index.ts                  # 仅按 bundle 模板需要的入口，不承担执行循环
  presets/
    customer-service/
      preset.yml
      agent.cordis.yml
    data/
      preset.yml
      agent.cordis.yml
    operations/
      preset.yml
      agent.cordis.yml
  tests/
    definitions.spec.ts
    composition.spec.ts
    isolation.spec.ts
    scenarios.spec.ts
packages/business/
  tool-customer-service/
  tool-data-analysis/
  tool-operations/
```

每个工具包包含 `src/`、`tests/`、所需 fixtures、package.json、tsconfig 和 README，遵守 `packages/<group>/<package>` 结构与仓库命名/依赖规则。实际新增包时用官方 package cookbook 补齐构建、exports 和生成目录配置；不要手写生成产物。

### 4.1 定义字段映射

| 业务定义字段 | 唯一配置来源 |
|---|---|
| id | `presets/<id>/` 目录名 |
| name / description | `preset.yml` |
| system prompt / persona | `agent.cordis.yml` 中 `@deepseek-ai/dsh-persona` 的 prefix/suffix |
| model | 本阶段为明确约定的 `host-default` 引用，实际配置由 `agent-default-model` 管理 |
| tools | `agent.cordis.yml` 中启用的业务 Tool Plugin 行；不重复维护另一份可执行工具名单 |
| preset 引用 | 即本目录的 `agent.cordis.yml` |

这是一个统一的复合定义，不要求压成单文件。第一阶段 Prompt 直接用 YAML 多行文本；以后确有编辑需求再加 prompt 文件引用，不假设现有 Persona 支持 `promptPath`。

示例 `customer-service/preset.yml`：

```yaml
name: Customer Service Agent
description: 基于示例产品知识回答问题、查询订单并创建客服工单。
order: 10
```

示例组合意图（业务插件与文件目前尚未实现）：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |-
      你是企业客服助手。先查询知识和订单，再给出有依据的回复。
      产品政策必须注明知识来源；不编造订单或工单状态。
      知识不足时说明限制，需要处理时调用工单工具。
    includeRuntimeContext: false

- id: customer-tools
  name: '@deepseek-ai/dsh-tool-customer-service'
  config:
    fixtureSet: demo
```

最终组合还应选取官方所需的上下文压缩/工具结果裁剪行，保持其 `isolate` 关系；不复制 standard 的整套工具。默认不启用 `complete: true`，以免无意屏蔽官方其他必要 Prompt section；通过实际请求快照确认没有遗留 coding persona 与无关工作目录指令。

### 4.2 启动与配置约束

- 使用原 `web` profile 加业务 bundle/patch，不另建 Node 服务入口。业务部署 roster 设置 `includeShippedRoot: false`、`includeUserRoot: false`，配置业务 presets root 与默认 `customer-service`。
- 按已有 bundle 的路径解析和 package resolver 方式实现源码/构建后均能找到的 presets 路径；所有裸包名插件在负责解析的 manifest 中声明依赖。
- `--patch` 会替换目标 row 的完整 config，必须写全所需字段。用 `--dump-config` 核对最终组合，不能只核对某一层 YAML。
- 使用独立测试 `DSH_HOME` 和 workspace，避免个人 settings 的默认 Preset 或隐藏选择器偏好影响演示。
- 启动命令预期为 `pnpm dsh --profile web --patch ./packages/bundle/business-agents/cordis.patch.yml`，须在实现时验证路径解析与构建安装形态后写入运行指南。
- 已开始的 Session 保持原 Agent。新建第四个 Agent 主要增加 Preset 配置；若它需要全新能力，仍需新增对应工具实现，这是配置化的正常范围。

## 5. 三个业务 Agent 的工具与数据

### 5.1 Customer Service Agent

| 工具名（计划） | 功能与输出 | 权限 |
|---|---|---|
| `knowledge_search` | 搜索本地 FAQ/产品文档；返回 docId、标题、片段与来源 | 只读固定知识集 |
| `order_query` | 通过 orderId 查询订单、配送、退款状态 | 只读 mock orders |
| `ticket_create` | 创建普通或升级工单，关联订单和问题，返回 ticketId/status | 仅写入当前 Session 的模拟工单 |

知识搜索使用简单关键词匹配和可预测排序；查不到返回空结果。工具接口不依赖检索算法，后续替换真实 RAG 时保留调用字段和引用语义。不给 Shell、任意文件写、SQL、工具动态安装或其他 Agent 工具。

演示：“订单 O-1002 已超过预计发货日期，帮我查延期政策并创建升级工单。”应完成知识查询、订单查询、工单创建，最终回答有政策来源与真实工具返回的工单号。

### 5.2 Data Agent

| 工具名（计划） | 功能与输出 | 权限 |
|---|---|---|
| `data_catalog` | 列出示例表、列、时间范围、金额/退款口径 | 只读数据目录 |
| `sql_query` | 对示例 SQLite 运行只读查询，返回列、行数、结果与截断标记 | 无数据库写入 |
| `dataset_read` | 根据 datasetId 读取固定 CSV 的有限行，返回列及预览 | 不接收任意本机路径 |
| `data_analyze` | 对有上限的输入结果执行分组、求和、比例、期间比较等结构化统计 | 无 eval、Shell 或任意 Python/JS |

这实现 Database Tool + Data Analysis + 多次 Tool Calling；本阶段选用用户列出的 Data Analysis 分支，不另建任意代码执行沙箱。CSV 与 SQLite 由同一 fixtures 生成，防止两套数据得出不同答案。业务数据不使用 Harness 的 Session 查询数据库。

SQL 不能只靠“以 SELECT 开头”的字符串检查：使用只读连接与数据库只读约束，限制单语句，拒绝 ATTACH/写入及管理语句、扩展加载和文件访问入口；如果所选驱动不能可靠限制，改为受限查询参数，不能开放不安全接口并只靠 Prompt 约束。连接/API 选型在准备任务中验证当前 Node 支持范围。查询在可中断的执行单元中运行，设置结果上限与截止时间，避免同步复杂查询阻塞 Host。

固定数据示例（金额为同一币种的已支付订单收入，退款另列，不混用净收入）：

| 产品 | 2026-07 收入 | 2026-08 收入 | 变化 | 变化率 |
|---|---:|---:|---:|---:|
| A | 100000 | 60000 | -40000 | -40% |
| B | 80000 | 72000 | -8000 | -10% |
| C | 50000 | 60000 | +10000 | +20% |

退款率定义为“当期已支付订单中发生退款的订单数 / 当期已支付订单数”；示例两期为 20/1000=2%、50/1000=5%，上涨 3 个百分点。配置退款原因和产品维度数据，要求 Agent 区分数据支持的贡献因素与尚未验证的因果解释。

测试冻结业务日期为 2026-09-15、时区 Asia/Singapore，使“上个月”映射 2026-08。fixtures 与口径是独立验收基准，不从模型回答反推期望值。

### 5.3 Operations Agent

| 工具名（计划） | 功能与输出 | 权限 |
|---|---|---|
| `project_query` | 查询项目、负责人、截止日、进度、待处理客户事项 | 只读 mock projects |
| `task_create` | 为项目负责人创建任务，返回 taskId、ownerId、dueDate | 仅当前 Session 的模拟任务 |
| `calendar_query` | 查询演示日期范围内的安排 | 只读 mock calendar |
| `message_send` | 向指定模拟接收人登记消息，返回 mock 状态与引用 id | 仅写入本地模拟 outbox，不发送网络请求 |

演示：“找出今天延期的项目，为负责人创建跟进任务，检查明天是否有时间，并汇总通知内容。”至少包含读→写→后续组合步骤；同一结果中显示项目、任务和通知间的对应关系。

写工具均声明非 parallel-safe；同一次测试出现工具重试/重复业务请求时，用明确的 requestKey 返回同一模拟记录，防止重复创建。此处只提供 Session 内演示幂等性，不宣称具备跨系统事务或真实 SaaS exactly-once。

### 5.4 状态、错误与展示

- 只读 fixtures 可共享；模拟写入按 Session 分区，可优先从现有成功 tool result 的 metadata 与 Session 投影恢复，不新增独立数据库/执行日志。
- 工具结果标记 `mock: true`，记录稳定业务 id；UI 明确显示“模拟工单/任务/消息”。
- 工具参数用官方 schema 验证，覆盖不存在 id、空结果、截断和超时；失败返回官方工具错误通道，Loop 能继续解释或修正调用。
- 优先使用现有通用工具卡片呈现参数和结构化结果，只有无法读懂时才加专用 renderer。不要为本阶段做业务管理后台。
- 本阶段 Session 隔离是对话/模拟状态与工具作用域隔离，不是不同企业用户之间的授权隔离。

## 6. 前端最小改造

1. 在现有新建会话界面使用 Preset 组件展示三种业务 Agent 的名称和描述，选择后进入原聊天页；用下拉或卡片均可，默认沿用现有样式。
2. 复用同一 roster 数据，不在 UI 写死三个 Agent id。用当前 Session 的 Preset projection 显示聊天标题/徽标，刷新后不依据浏览器暂存值猜测身份。
3. 接入 `SessionCreateRequest.agentPreset`，创建成功后才开放发送。对于官方先建立空 Session 的入口，等待 `agentPresets.select` 完成才允许第一条消息；失败保留原因与重试入口。
4. Workspace 原有空 Session 复用必须考虑 agentPreset。业务“开始聊天”要求创建新 Session；至少禁止为两个不同 Agent 复用同一个空 Session，也不能只把正在使用的会话换个标题。
5. 校验快速重复点击与同时打开多个 Agent 的情况，避免重复创建、旧异步响应覆盖新选择、第一条消息发往默认 Agent。
6. 展示所选 Agent 的业务能力说明；实际工具调用卡片来自运行事件。若增加工具清单，须从该 Session 的真实 `tools.schemas(scope)` 获取，通过既有 Remote 扩展暴露只读查询，不能使用全局 plugin inventory 代替会话工具权限。
7. 通用 UI 文案进入已有 locale 字典；Agent 名称/描述由 Preset 元数据提供。坏 Preset 可见但不能开始聊天。

预计涉及现有文件：`packages/client/ui-agent-preset/src/client/AgentPresetSeat.tsx`、`seat-store.ts`、`index.ts`、`locales.ts`，以及 `packages/client/ui-workspace/src/client/navigation.ts` 与相关接口/测试。尽量只扩展既有创建参数和组件行为，保持普通 Web profile 的既有流程。

## 7. 可分批执行的任务

每批先补重要行为测试，再实现最小代码，运行对应检查，最后整理文档。无需为了每个小步骤新增通用抽象。以下时间仅是单人专注开发估计，总体约 7–10 个工作日；依赖安装、构建和 Windows 环境问题可能增加耗时。

### T0：建立运行与回归基线（0.5–1 天）

**文件：** 无产品实现修改；准备后续运行记录。

- 核对 Node/pnpm、安装依赖，检查现有 Web profile 能构建启动。
- 运行 Preset、Persona、Session preset/model 的现有单测，及现有选择器浏览器场景。
- 保存原 Web profile 的有效配置与启动记录；失败区分基线问题和新改动。
- 验证只读 SQLite 驱动在当前 Node/Windows 的可用性、取消策略及数据集路径解析。

**完成条件：** 基线命令与结果明确；能够打开现有聊天页。当前已观察到源码版本 `0.1.5-rc.2`、Node `v24.12.0`、pnpm `11.7.0`；尚无 node_modules，也没有 `.git`，因此不能给出 commit hash、Git diff 或测试通过结论。实施前保留下载包基线/建立版本控制，便于核验改动范围。

### T1：业务 bundle、三个定义与隔离骨架（1 天）

**新增：** `packages/bundle/business-agents/`；工具包骨架；所属 package 清单、依赖、构建及必要生成配置。

**测试：** `definitions.spec.ts`、`composition.spec.ts`、`isolation.spec.ts`。

- 先测试发现恰好三个业务定义、元数据完整、Persona 可解析、未知 id/缺失插件失败。
- 按官方 package/bundle 约定实现注册与路径解析，配置 exclusive business roster。
- 三个 Preset 先用最少工具测试挂载，检查 scope，不修改 core。
- 如需要防止继承将来新增的全局工具，增加一个很小的 scoped policy plugin，调用 `ctx.tools.restrict({ allow: [] })`；业务工具仍在 Preset 自己的作用域注册。该 API 不是任意 scoped tool 的统一白名单，不能把它误用为整个权限系统。

**完成条件：** 三个 Session 均成功创建；客服范围不存在 Shell 或其他 Agent 工具，官方 Web profile 不受业务 patch 影响。

### T2：Customer Service 工具和事实引用（1 天）

**新增：** `packages/business/tool-customer-service/src/index.ts`、工具实现与 fixtures；`tests/tools.spec.ts`、`tests/scenario.spec.ts`。

- 先写知识检索、订单不存在、普通/升级工单、Session 隔离与重复请求测试。
- 用 `defineTool` 与 `ctx.effect(() => ctx.tools.register(...))` 挂载工具。
- 接入客服 Preset，编写有来源要求的 Persona，验证通用工具卡片可读。

**完成条件：** fixture 场景完成三个工具调用，有政策引用与可核验工单号；假订单不生成伪成功回复。

### T3：Data 数据集、查询与分析（1.5–2 天）

**新增：** `packages/business/tool-data-analysis/src/`、CSV fixtures 和数据库生成器；`tests/query.spec.ts`、`analysis.spec.ts`、`scenario.spec.ts`。

- 先固定收入/退款口径、时间与预期数值，写只读与边界测试。
- 实现数据目录、只读 SQL、固定 datasetId CSV 读取与结构化分析。
- 验证 SQL 写入、ATTACH、扩展访问、越界文件读取、超大结果及超时被拒绝/限制。
- 接入 Data Preset，跑“查 schema→查数据→统计→结论”的多步调用。

**完成条件：** 得出 A 收入下降 40000/40%，退款率 2%→5%/+3 个百分点；没有修改源数据或越权访问本机文件。

### T4：Operations 多步骤模拟工作流（1 天）

**新增：** `packages/business/tool-operations/src/`、fixtures；`tests/tools.spec.ts`、`scenario.spec.ts`。

- 固定日期、项目、人员与日历，明确延期定义为未完成且截止日早于业务当天。
- 实现 project/task/calendar/message 四工具，写操作返回 mock 状态与关联 id。
- 验证先查询事实再创建任务/通知，模拟写入按 Session 分区，重复请求不重复创建。

**完成条件：** 场景读写相连、任务负责人正确、消息只进入 mock outbox、网络请求数为零。

### T5：业务选择器与 Session 创建串联（1–1.5 天）

**修改：** 第 6 节前端文件及必要的现有 client interface；优先不改 Session Controller 公共协议。

**新增/扩展测试：** `packages/client/ui-agent-preset/tests/`、`packages/client/ui-workspace/tests/`；`apps/web/tests/business-agent-selection.e2e.ts`。

- 先复现并约束空 Session 复用、立即发送、重复点击与旧响应覆盖的行为。
- 让选中 id 进入创建链路，并显示等待/失败/运行后锁定状态。
- 业务流程显式新建独立 Session，保持原聊天、历史和流式工具展示。
- 验证从三个 Agent 来回切换后，标题、实际 Prompt、工具集合及 Session id 一致。

**完成条件：** 选择后第一条请求就属于正确 Agent；已开始会话无法切换定义；刷新/重新打开不会串身份。

### T6：组合验收、回归与交付（1–1.5 天）

**新增：** `apps/web/tests/business-agents.snapshot.ts`；按仓库 snapshot 规范增加业务场景记录；bundle README/运行指南/验收报告。

- 使用仓库 agent-loop testkit 与可脚本化模型测试运行真实 Loop，断言 assembled Prompt、工具 schema、调用参数、结果和下一步请求。
- 为三个场景记录并提交可无 key 回放的 Session 快照，不新增 Evaluation 平台。
- 运行定向单测、浏览器测试、相关原有回归、类型/构建/文档检查。
- 三个真实模型场景各用新 Session 连续通过三次，记录实际结果与错误；密钥缺失则明确此项未验收，不能用 mock pass 替代。
- 临时增加第四个配置使用已有工具，确认不改 Loop、不改 UI 硬编码即可出现并运行；验收结束移除临时配置，使交付仍展示三个 Agent。

**完成条件：** 第 8 节所有强制项有证据；未通过项有定位，不能只以“页面能打开”交付。

## 8. 验收矩阵

| 编号 | 验收操作 | 必须得到的结果 | 证据 |
|---|---|---|---|
| A01 | 按运行指南启动业务 Web | 列出三个正确名称和描述，可进入聊天 | UI 自动化、启动记录 |
| A02 | 分别创建三种 Agent | Session id 不同，Preset projection 正确，同一 Core driver | Host 集成测试、Session 日志 |
| A03 | 各发送第一条消息 | 模型实际收到对应 Persona；三个都走共同默认模型 | 请求捕获/快照 |
| A04 | 读取三种 Session 的工具 schema | 客服 3、Data 4、运营 4 个计划业务工具，无意外额外工具 | scope schema 精确集合断言 |
| A05 | 让客服请求 SQL、Shell 或运营工具 | 工具不暴露；通过真实 dispatch 强制调用也失败，执行体无副作用 | 负向工具执行测试 |
| A06 | 客服完整场景 | 知识引用、正确订单、升级工单 id 三者一致 | 场景回放、真实模型演示 |
| A07 | Data 收入/退款问题 | 精确数值、期间与口径正确，至少两轮有依赖的 Tool Calling | fixtures 独立计算、请求/结果快照 |
| A08 | Data 越权输入 | SQL 写、ATTACH、路径越界、扩展加载拒绝；超时/截断可见 | 负向/资源边界测试 |
| A09 | Operations 场景 | 延期项目正确，任务负责人正确，模拟通知关联任务，零真实发送 | 工具结果/模拟 outbox |
| A10 | 同一 Agent 两个 Session + 跨 Agent 交错执行 | 对话、模拟写入、工具集合不串；取消一个会话不破坏另一个 | 并发集成测试 |
| A11 | 选中后立即发送、重复点击、复用空 Session | 不以默认 Agent 抢跑；不跨 Agent 复用；最终 UI 与后端一致 | 浏览器及 controller 测试 |
| A12 | 已开始 Session 切换 Agent；刷新重开 | 切换拒绝；原身份和历史工具结果仍可读 | 官方行为回归 |
| A13 | 无效配置、缺插件、工具参数错误、空查询 | 创建或调用给出可理解错误，不偷偷退回其他 Agent，不半初始化运行 | 单元/集成测试 |
| A14 | 重复提交同一个模拟创建请求 | 当前 Session 不产生重复工单/任务/消息 | 幂等与恢复读取测试 |
| A15 | 添加第四个配置并复用现有工具 | 自动发现并运行，无 Loop/Selector 特殊分支 | 配置演练与 diff |
| A16 | 启动原 Web profile、运行已有相关测试 | 原 Preset、Session 模型选择和聊天行为不回归 | 定向回归结果 |

A04 的目标数值依据本计划工具表；若实现中有必要保留官方辅助工具，必须逐个说明用途并更新验收名单，不能放宽为“至少包含业务工具”。PTC 不在本阶段使用，避免 `run_code` 折叠后的 schema 与业务工具计数混淆。

### 8.1 验收分两层

**工程行为层：** 无 key、可重复、全自动。固定模型响应经过真实 Loop 和工具执行；精确检查配置、权限、数据结果、会话生命周期。文本结论可用语义/关键事实断言，不要求所有自然语言逐字相同。

**真实模型层：** 通过 Web 使用实际共同模型完成三个业务任务，每个连续三次新 Session 成功。检查“确实调用工具后完成任务”，不是模型碰巧说出答案。三次是第一阶段演示的交付阈值，不代表生产可靠性统计。

### 8.2 测试命令草案

以下均在源码根目录运行。命令来自已读到的现有脚本/测试入口；新增路径需要实现后存在。这些命令本次没有执行，不代表当前基线已经通过。

```powershell
pnpm install

# 已有行为基线
pnpm exec vitest run packages/preset/agent-presets/tests packages/preset/persona/tests packages/api/session-controller/tests/session-presets.host.spec.ts packages/api/session-controller/tests/session-models.host.spec.ts

# 新增业务插件和组合
pnpm exec vitest run packages/business packages/bundle/business-agents/tests

# 受影响客户端行为
pnpm exec vitest run packages/client/ui-agent-preset/tests packages/client/ui-workspace/tests

# 构建后验证浏览器路径
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/agent-preset-selection.e2e.ts apps/web/tests/business-agent-selection.e2e.ts apps/web/tests/business-agents.snapshot.ts

# 仓库要求的相关静态和文档检查
pnpm run typecheck
pnpm run lint
pnpm run hygiene
pnpm run doc-sync
```

遵守仓库“定向验证，CI 承担全量矩阵”规则。已有构建产物满足前置条件时可用对应 `:contracts-ready` 检查，避免重复构建；不要关闭检查来规避新增 package 声明问题。若修改标准 Preset 以外的共享路径，追加该路径现有快照场景。API provider 没有变化时无需扩大为所有 provider 实网测试。

## 9. 风险和实施边界

| 风险 | 处理方式 |
|---|---|
| 当前源码是下载目录，缺少 Git 与依赖 | T0 建立可比较的基线，先证实官方构建/运行；不把环境失败算作业务实现失败 |
| Preset 共享插件实例导致模拟状态串会话 | 使用 Session 作为状态归属，测试同 preset 多 Session 与不同 preset 并发 |
| UI 默认设置或空会话复用导致实际 Agent 不对 | 创建时传 id，等待配置完成；测试明确身份；演示使用独立 home |
| 默认模型凭据/可用性影响演示 | 用用户已有有效配置；测试 mock 与实网结果分开记录，不写入密钥 |
| YAML 动态求值和插件配置有执行能力 | 仅部署侧受信文件；不提供上传任意 YAML 或动态安装工具的业务入口 |
| SQLite 只读不等于完整隔离/超时 | 驱动能力验证、语句限制、固定数据库、关闭扩展、可中断查询和上限 |
| 修改 Preset 文件后历史行为不完全可重现 | 沿用官方 generation 语义；验收期间固定配置。版本化部署/配置快照另属后续阶段 |
| 工具显示正常但模型未实际使用 | 捕获真实模型请求和 tool result，再检查下一步依赖关系 |

不预计修改 `packages/core/agent-loop`、`core/session`、`core/tools`、`core/system-prompt` 的实现。若实施中发现必须改动，先提供具体失败用例、已有扩展点不足之处和最小修改范围，再调整本计划，不能顺便改写底层。

## 10. 交付清单与完成定义

- 一个可用现有 `dsh` 启动的业务 Web 组合，以及三个统一结构的 Agent Definition。
- 三组业务工具、可复现示例数据与清晰的 mock 标识。
- Agent Selector、独立 Session、正确 Prompt 和可验证的工具隔离。
- 无 key 自动化测试、三个场景可回放快照、真实模型演示记录。
- 启动/重置示例数据/新增第四个 Agent 的简明指南。
- 按仓库要求补齐相关 README、locale、生成目录与非机械实现的 Agent Note；不为计划文件伪造“已实现”记录。
- 验收报告逐项填写 A01–A16：通过/失败/未执行、命令与输出位置、关键 Session id、失败原因；无 key 时真实模型项仍标未完成。

面试中的设计概括：**业务 Agent 是一套 Preset 配置，配置决定身份和工具；官方 Registry 发现配置，官方 Factory 在 Session 创建时挂载配置，所有 Agent 运行同一个官方 Loop。平台第一阶段新增的是业务组合和业务能力，而不是第二套 Harness。**
