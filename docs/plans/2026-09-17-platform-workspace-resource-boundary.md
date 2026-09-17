# Platform Workspace Resource Boundary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> 执行时使用当前环境实际提供的 executing-plans 技能；本文件仅为计划，不表示已实施或测试通过。

**Goal:** 建立独立于 Harness 目录 Workspace 的平台资源归属，使配置、执行、恢复和查询始终使用同一个 PlatformWorkspace。

**Architecture:** 复用现有 Workspace / Governance、Storage Domain、Registry、Shared Resources、Runtime 和 Trace，补齐缺失的资源类型及一致性检查。Control Plane 管理归属，Runtime 从 Agent 固定执行空间，Harness 保持原有 Agent Loop，工具和资源适配器通过现成 hooks 落实校验。

**Tech Stack:** Node.js、TypeScript、pnpm、Cordis、Zod、Storage Domain、现有 JSON / SQLite backend、Vitest 和现有 Web 测试设施。

**基线：** 2026-09-17，Git `f6b66c8`。本次已阅读代码及旧验收记录，未运行功能测试。下列源码路径以 `D:/developer/Platform/deepseek-harness-master/` 为根；本计划位于外层 `docs/plans/`。

---

## 1. 先确认现有基础，避免重复实现

| 能力 | 当前代码事实 | 本阶段处理 |
|---|---|---|
| Harness Workspace | `packages/workspace/workspace/src/types.ts` 以目录、Session 列表为核心 | 保持原义，不增加租户语义 |
| 平台工作区记录 | `agent-builder/src/governance.ts` 的 `platform_governance.workspaces` 已保存 ID、名称、时间、状态及成员 | 复用现有记录，提取薄的 PlatformWorkspace 接口，不新建第二套工作区身份 |
| Agent / Version / Deployment / Run | 已有 `platformWorkspaceId`，并有父子归属校验 | 补齐调用路径和类型约束，不再并列添加同义字段 |
| Shared Resources | 已有 `workspaceId`、`forWorkspace()`、引用检查及不可变版本；类型仅为 Model、Tool、Skill | 延续此目录，补 MCP Server、MemoryStore、Eval Dataset、Credential 引用元数据 |
| Runtime | `index.ts` 已使用 `tools.guard()` 和 `agent/request`，部分执行限制依赖 governance 是否启用 | 资源归属检查必须独立于登录和 RBAC，覆盖启动、恢复及每次资源解析 |
| Trace / Observability | `RunTrace` 和持久化 summaries 已有 `platformWorkspaceId`；分析事实已有 `workspaceId` | 验证固化、分页、重建和查询一致性，不创建第二套执行记录 |
| MCP | `packages/mcp/mcp-client` 已提供连接与工具注册，支持 Agent scope | 增加平台资源适配层，复用客户端和工具协议 |
| Memory / Evaluation | 当前 business 包没有 Platform MemoryStore / Eval Dataset 目录；销售 `dataset_read` 是业务样例 | 本期建立一级资源元数据和有实际消费者的范围解析，不把销售数据误当 Eval Dataset |
| 持久化 | base profile 使用 JSON Storage Domain；仓库另有 SQLite backend，未发现本平台使用 PostgreSQL 的依据 | 默认延续当前路由；若选择 SQLite，用现有 backend，不绕过 Domain 写一套 SQL 仓库 |

旧的 [Workspace / Governance 计划](2026-09-17-workspace-governance.md) 和 [验收记录](../workspace-governance-acceptance.md) 作为兼容性输入。本计划聚焦统一资源 namespace，不扩建成员、角色或登录体系。

## 2. 范围与方案选择

推荐在现有业务插件内部增加薄的工作区目录接口和统一 scope，继续使用现有服务。另两种方案是直接给 Harness Workspace 增加业务字段，以及为每个空间启动独立服务；前者混淆目录与资源归属，后者超出当前内部平台阶段。

本期交付：

- Workspace 创建、列表、详情与选择；业务资源归属不可通过普通更新接口迁移。
- Agent、Tool、MCP Server、MemoryStore、Eval Dataset 的平台目录归属；已有 Model、Skill 一并遵守相同规则。
- Credential 只登记空间归属和 Host secret 引用，真实值继续由已有凭证 provider 持有。
- 配置阶段拒绝跨区引用；执行阶段再次检查持久化引用和本次调用目标。
- Run、Trace、Observability 及恢复流程维持同一空间身份。
- 无登录 Demo 可以注入 workspace scope；现有治理模式继续使用原有身份与成员检查。

不包含：跨空间共享、移动资源、Workspace 硬删除、企业 IAM、配额、第二套 Agent Loop、完整 Memory 检索引擎、完整 Eval 评分系统和新基础设施。MemoryStore / Dataset 的目录与解析验收不等同于完整 Memory / Evaluation 产品已交付。

## 3. 数据模型与不可变条件

`workspace_id` 是概念名称。新 TypeScript 接口统一使用 `PlatformWorkspaceId`；已有持久化的 `platformWorkspaceId` / `workspaceId` 保持原名，通过边界映射表达相同语义，避免无必要的全仓字段迁移。

```ts
type PlatformWorkspaceId = string & Branded<'PlatformWorkspaceId'>

interface PlatformWorkspace {
  id: PlatformWorkspaceId
  name: string
  createdAt: string
}

interface WorkspaceScope {
  workspaceId: PlatformWorkspaceId
}

interface ExecutionScope extends WorkspaceScope {
  runId: PlatformRunId
  agentId: RegistryAgentId
  agentVersionId: AgentVersionId
}
```

上述是目标接口示意，实施时核对并复用已有 ID 导出。当前 Workspace 的状态、revision、成员等扩展字段继续保留，薄接口不是删字段迁移。

| 对象 | 归属来源与规则 |
|---|---|
| Agent | 直接持久化 PlatformWorkspaceId |
| Tool / MCP Server / MemoryStore / Eval Dataset / Model / Skill / Credential 元数据 | 直接持久化 workspaceId；ID 全局稳定，name 仅用于显示 |
| ResourceVersion | 继承父资源，校验 version.resourceId；不可用外区版本替换 |
| AgentVersion / Deployment | 继承 Agent；现有冗余字段保留并与父记录核对 |
| Tool → MCP Server → Credential | 每一跳都校验与执行空间相同，不能只验证第一跳 Tool |
| Run | 从已加载的 Agent 复制归属，客户端只选择目标空间，不决定 Run 的归属 |
| Trace | 写入摘要时从持久化 Run 复制归属；重建或导出不得使用当前请求的空间覆写 |
| Memory entry / Dataset item | 继承已校验的父资源；底层键至少包含 workspaceId、resourceId 和本地 key |

必须始终成立：

```text
request.workspace = agent.workspace
run.workspace = agent.workspace = agentVersion.workspace
resolvedResource.workspace = run.workspace
trace.workspace = run.workspace
```

1. A、B 可以拥有同名 `redis-agent`、同名 Tool；请求和引用使用 ID，不按名字全局查找。保留当前显示名规则，不额外强加同空间 name 唯一；将来引入可寻址 slug 时才按 `(workspaceId, kind, slug)` 建唯一约束。
2. `list/get/update/archive/publish/usage/search/count/export` 全部限定 scope；先过滤后分页、计数和聚合。
3. 外区 ID 与不存在 ID 对外统一返回 not-found；缺失或格式错误的 scope 返回参数错误；重复幂等键但业务输入不同返回 conflict。
4. 不在单例对象保存可变的 currentWorkspace；显式传递 scope，或复用请求级 AsyncLocalStorage，后台执行重新从 Run 构建 scope。
5. 配置修改、保存版本、部署、Run 启动、重试恢复、每次工具/Memory/Credential 解析都检查关系；UI 过滤不能代替服务端检查。
6. 多 Workspace 平台入口缺少 scope 时不能回退到默认空间。旧单空间入口仅能通过显式 legacy adapter 注入既有固定空间。
7. 资源归属校验不依赖成员身份存在；治理开启时在其上叠加现有授权，不能用 Demo 请求绕过治理模式。

## 4. 分阶段执行任务

每个任务采用“新增行为测试 → 确认失败于目标行为 → 最小实现 → 定向回归”的顺序。按下面的依赖依次实施，每个通过验证的任务可作为独立提交；本次计划阶段不提交功能代码。

### Task 1：固定基线与隔离契约

**文件：** 阅读 `packages/business/agent-builder/src/{governance,registry,shared-resources,index,platform-runs,platform-traces,platform-api,platform-http}.ts`；扩展 `packages/business/agent-builder/tests/workspace-isolation.spec.ts`。

1. 按创建、详情、更新、版本、部署、运行、恢复、Trace、usage 逐项列出入口及 scope 来源，标记治理开启/关闭的差异。
2. 新增 A/B 同名 Agent 与 Tool、交叉读写、复用 requestToken 的测试；已支持的行为作为回归，不重复实现。
3. 增加“无登录但有有效 WorkspaceScope”的隔离测试；找出依赖 governance 开关才执行的资源校验。
4. 核对 `docs/architecture.md`、`docs/defensive-patterns.md`、`docs/testing.md` 和受影响目录的 AGENTS，记录会用到的 hooks。

**完成标准：** 基线能力与缺口有测试定位；不能仅凭旧验收文档判断当前功能通过。

### Task 2：明确 PlatformWorkspace 身份与请求上下文

**新增：** `packages/business/agent-builder/src/platform-workspaces.ts`、`workspace-context.ts`、`tests/platform-workspaces.spec.ts`。

**修改：** 同包 `governance.ts`、`principal-context.ts`、`types.ts`、`index.ts`、`platform-api.ts`、`platform-http.ts`；`scripts/provision-platform-governance.ts`。

1. 引入独立 branded ID 和薄 Workspace 视图。复用 `platform_governance.workspaces` 的稳定 ID，不另设平行 Workspace 表。
2. 提取目录访问及创建逻辑，使 namespace 服务可以在没有用户登录时使用；同一 Domain 仍由单一 owner 打开和关闭，Governance 复用句柄，不重复打开同名 Domain。
3. 保留既有治理记录结构及成员信息。Workspace 创建由维护者初始化入口承接；治理模式继续绑定既有管理员，不增加全局管理员角色。
4. Demo profile 提供创建/列出/读取 Workspace 的受控接口和 selector，以显式 demo 配置启用；治理 profile 不挂载免登录入口。Demo 新记录不伪造真实用户，切换到治理部署时先由维护者补齐有效管理员，再完成启动校验。
5. 复用现有 API envelope 的 `workspaceId` 注入 scope，不再同时引入 URL、Header 多套优先级。将 namespace scope 与身份 principal 分开；新 Workspace ID 服务端生成、创建幂等、改名不改 ID。
6. 增加创建重试、重启、未知空间、并发 A/B 请求、多模式入口不可互相绕过的测试。

**完成标准：** 可以创建 A/B 并持久化；Demo 不需要建设登录能力，既有治理模式仍保持原有授权行为。

### Task 3：将一级资源纳入同一目录

**修改：** `packages/business/agent-builder/src/{resource-types,resource-schema,shared-resources,registry,version-schema,versions,deployments}.ts`；`tests/{shared-resources,versions,workspace-isolation}.spec.ts`。

**新增：** `packages/business/agent-builder/tests/workspace-resource-types.spec.ts`。

1. 延续 Shared Resources 的版本、状态与 scoped lookup，扩展 MCP Server、MemoryStore、Eval Dataset 和 Credential 元数据类型；只有确有不同生命周期时才拆单独表。
2. MCP Server 保存适配配置与 Credential 资源引用；Tool 可以引用明确的 MCP Server 版本和远端 tool key。MemoryStore / Dataset 保存已登记 adapter 标识及受控位置，不能把任意路径当资源 ID。
3. Agent 增加可选 MemoryStore 引用；Eval Dataset 作为独立一级资源由评测/数据预览入口消费，不强制成为所有 Agent 的运行依赖。
4. Credential 元数据只含 Host 管理的 secret 引用和空间归属；绑定链中的实际值不进入公共 API、AgentVersion、Trace 或日志。Host provider 可以共享实现，但平台解析必须先检查空间内引用。
5. 给每种资源补 list/get/create/update/status/reference 测试；更新所有 discriminated union 消费者、版本快照和输入解析。
6. 同名资源使用不同 ID。缓存、幂等键、usage、分页 cursor 均包含所属空间或绑定唯一父资源，拒绝复用外区 cursor。

**完成标准：** 所有目标一级资源都有持久化归属与 scoped API；A/B 同名不冲突、详情和使用关系不串区。

### Task 4：配置阶段关闭跨区引用

**修改：** `packages/business/agent-builder/src/{index,shared-resources,versions,deployments}.ts`。

**新增：** `packages/business/agent-builder/src/workspace-resource-resolver.ts`、`tests/workspace-bindings.spec.ts`。

1. 集中提供按 `(scope, resourceId, versionId, expectedKind)` 解析资源的函数，复用现有 `resolve()`、`validateReferences()` 和 `assertAvailable()`，避免重复注册表。
2. Agent 创建/更新、保存版本、部署/回滚均使用同一解析规则；被拒绝的变更不得留下新草稿、版本或部署记录。
3. 逐跳核对 Tool → MCP Server → Credential、MemoryStore → Credential；检查资源种类、版本父对象、状态和内容 hash。
4. 读历史允许保留已停用资源的事实；新增绑定和实际执行沿用现有 availability 规则。
5. 测试 B 的 Tool ID、B 的 versionId、B 的 Credential 和 A Tool 隐藏引用 B Server，分别在预期边界被拒绝。

**完成标准：** 配置绕过 UI 直接请求 API，也不能创建跨区引用；并发发布与停用不绕过写入校验。

### Task 5：Runtime 固定空间并校验实际执行目标

**修改：** `packages/business/agent-builder/src/{platform-runs,runtime-tools,index,version-preset,run-schema}.ts`。

**新增：** `packages/business/agent-builder/src/workspace-runtime-resources.ts`、`tests/workspace-runtime.spec.ts`；按需新增同包 `workspace-mcp.ts` 和 `tests/workspace-mcp.spec.ts`。

1. Run admission 先用请求 scope 加载 Agent，再从 Agent 复制空间；ExecutionScope 来源于持久化 Run，不读取 UI 当前选择或可伪造的工具参数。
2. 启动、排队派发、重试、checkpoint 恢复都核对 Run/AgentVersion/Agent 的归属。缺失归属不回退默认空间，保留故障事实并拒绝派发。
3. 使用现有 `tools.guard()`、`tools.restrict()`、`agent/request` 和 Runtime 工具记录；将资源检查从 governance 条件中分离，原授权仍保留。
4. 将实际调用的工具名映射到当前版本绑定的 ResourceRef；不能仅检查“版本里有一个合法 Tool”，随后按 Host 全局裸 operation 找到另一个配置。相同 operation 的歧义绑定应拒绝或明确别名。
5. MCP 在 Agent scope 中挂载已解析的服务配置，复用现有 mcp-client；连接/凭证缓存以 workspace、serverId、versionId 分区。凭证在实际操作前解析，停用后不得从缓存绕过校验。
6. Memory 使用最小本地适配器验证真实读写；Dataset 使用最小预览/读取消费者验证所属空间。数据键使用 `(workspaceId, resourceId, key)`，底层路径由适配器生成。完整向量检索和 Eval 执行器不在本任务建设。
7. 在存储夹具中注入脏引用，并通过真实 Runtime 恢复或直接派发路径验证拒绝；断言模型/工具/凭证/MCP/Memory 底层 spy 没被调用。保留启动校验，同时证明运行时自身也能拦截。
8. 将拒绝写入现有 Run/工具错误与 Trace 投影，复用事件来源；对外不暴露外区名称、参数或 secret。

**完成标准：** A Run 在启动后、UI 切换后、Host 重启后仍只能访问 A 资源；拒绝发生在本次外部副作用之前。

### Task 6：Run / Trace 固化、历史兼容与存储验证

**修改：** `packages/business/agent-builder/src/{platform-traces,trace-types,trace-schema,trace-projection,platform-observability,observability-schema}.ts` 中确有缺口的部分。

**测试：** 扩展 `tests/{runtime-recovery,trace-projection,observability-projection}.spec.ts`；新增 `tests/workspace-migration.spec.ts`。

1. 保留当前 Run 和 Trace summary 已持久化的字段；页查询先核对权威 Run，缓存和汇总按空间隔离。
2. 独立导出的事件在导出 envelope 中携带 Run 与 workspace 身份；原始 SessionEvent 继续沿现有 `platform/run` 事实关联，不新增平行日志系统。
3. 确认旧数据字段能原样读取、旧版本 configHash 不变；新可选数组不要在旧 hash 输入中自动补默认值。需要改变快照格式时显式版本化。
4. 迁移先 dry-run 输出已知归属、缺失归属及冲突；只对有明确旧配置来源的记录做显式映射。缺失父资源、冲突归属或未知空间不自动归入当前空间。
5. 停止写入并备份后执行必要迁移；重跑幂等，记录迁移版本。Storage Domain 的版本不匹配会拒绝打开，不能只增加 version 数字就当作已实现迁移。
6. 默认使用现有 backend。若决定切 SQLite，单独验证 KV/domain 能力、数据复制、条数/ID/hash 对照及重启；不同时迁移 Harness Session 日志。回退按停机备份恢复，不承诺新格式可被旧代码直接读取。

**完成标准：** 历史 Run/Trace 空间不漂移；跨区统计与导出无泄露；迁移不改历史 ID/hash，重启仍满足相同约束。

### Task 7：完成 Demo Selector 与可见资源分区

**修改：** `packages/business/agent-builder/src/{platform-page,platform-api,platform-http}.ts`；确有需要时更新 `packages/client/ui-agent-preset/src/client/` 的消费入口。

**新增：** `apps/web/tests/platform-workspace.e2e.ts`；扩展 `apps/web/tests/workspace-governance.e2e.ts`。

1. Demo 显示创建/选择 Workspace、Agent 列表、各类资源列表和运行历史；已有治理页面复用其切换机制。
2. 切换后取消旧请求，清空旧选中 Agent/Resource/Run/Trace；请求返回时校验请求所属空间，缓存包含 workspaceId。
3. 资源选择器只列本区可绑定资源；保留服务端负向验证。UI 中区分业务 Workspace 与 Harness 工作目录。
4. 中英文文案走现有 locale；测试快速切换 A→B、迟到响应、多标签页、刷新恢复与未知空间 URL/状态。

**完成标准：** 两区能各自创建同名 `redis-agent`、同名 Tool，切换后列表、详情、绑定选项、统计和历史全部同步切换。

### Task 8：组合验收与交付记录

**修改：** `packages/business/agent-builder/README.md`、`README.zh.md` 及必要 API / persistence 文档；新增符合仓库规范的 Agent Note。

**新增：** 外层 `D:/developer/Platform/docs/platform-workspace-acceptance.md`。

1. 用真实 Loader/profile、HTTP API、浏览器和确定性模型跑 A/B 场景；MCP 使用本地测试服务，Memory 使用本地隔离存储。
2. 跑既有治理、Agent Version、Deployment、Runtime 恢复、Trace、共享资源回归；Harness 目录 Workspace 单独回归。
3. 更新受影响的 keyless 快照、API/配置/持久化生成目录和中英 README；若改变 SessionEventMap，再补仓库要求的 SDK 消费测试。
4. 验收记录列出实际命令、结果、限制，以及 Memory/Evaluation 本期只交付哪些能力。旧验收中的失败项需重新核查，不预先认定为环境原因。

**完成标准：** 下述必测矩阵通过，且未更改 Harness Agent Loop。

## 5. 验收矩阵

| 场景 | 预期 |
|---|---|
| A/B 各自创建同名 Agent、Tool、MemoryStore、Dataset | ID 不同，列表各自独立 |
| A scope 直接读取/更新/发布 B 的资源 ID | not-found，B 记录不变 |
| A Agent 绑定 B Tool，或 A Tool 绑定 B MCP Server / Credential | 配置请求拒绝，无部分提交 |
| 脏数据含跨区引用，启动检查被测试路径绕过 | Runtime 再次拒绝，外部调用计数为 0 |
| A/B MCP 使用相同显示名和远端 tool key | 实际连接、配置、结果与缓存互不串用 |
| A/B MemoryStore 写入相同 key | 各自读回自己的值；A 不能按 B storeId 读取 |
| A scope 预览 B Eval Dataset | 读取适配器调用前拒绝 |
| A Run 发起后切换 UI 到 B | Run、Trace、恢复上下文仍固定为 A |
| 同时从 A/B 发起相同 requestToken 请求 | 各自幂等，不返回另一空间对象 |
| 请求缺 scope / 使用外区 cursor / 旧响应迟到 | 参数或范围检查拒绝；当前页面不被污染 |
| Run 排队、重试或恢复前依赖被停用 | 下一次派发拒绝，历史已完成事实保留 |
| Trace 重建、统计、分页、导出、Host 重启 | 始终从持久化 Run 获取归属 |
| Demo 无用户登录；治理已配置 | Demo 仍校验资源归属；治理不出现免登录绕过入口 |
| 历史迁移重跑、缺失或冲突归属 | 幂等；明确拒绝歧义，不改旧版本 hash |
| Harness 原目录 Workspace 和原 Agent Loop | 既有相关测试继续通过 |

## 6. 验证命令与交付顺序

以下命令在 `D:/developer/Platform/deepseek-harness-master/` 执行，新增文件落地后才可运行。先按任务运行对应单个 spec；最终再运行相关集合。

```powershell
pnpm exec vitest run packages/business/agent-builder/tests/platform-workspaces.spec.ts packages/business/agent-builder/tests/workspace-isolation.spec.ts packages/business/agent-builder/tests/workspace-resource-types.spec.ts packages/business/agent-builder/tests/workspace-bindings.spec.ts packages/business/agent-builder/tests/workspace-runtime.spec.ts packages/business/agent-builder/tests/workspace-migration.spec.ts
pnpm exec vitest run packages/business/agent-builder/tests packages/bundle/business-agents/tests packages/workspace/workspace/tests packages/mcp/mcp-client/tests/mcp-client.spec.ts
pnpm run build
pnpm run typecheck
pnpm run test:web:built -- apps/web/tests/platform-workspace.e2e.ts apps/web/tests/workspace-governance.e2e.ts apps/web/tests/agent-run.e2e.ts apps/web/tests/shared-resources.e2e.ts
pnpm run verify-export-jsdoc
pnpm run verify-client-ui-i18n
pnpm run test:docs
pnpm run doc-sync
git diff --check
```

预期是所有新增负向场景拒绝于指定边界，正向功能、类型检查和必要快照通过。构建/原生依赖按仓库当前环境准备；记录任何未运行项，不能用计划命令替代真实结果。

建议拆为四个连续交付批次：

1. **W1：Task 1–2**，统一工作区身份与上下文，复用已有治理数据。
2. **W2：Task 3–4**，补一级资源目录及配置关系校验。
3. **W3：Task 5–6**，封闭执行/恢复边界，验证 Run/Trace 固化与兼容。
4. **W4：Task 7–8**，完成界面与真实组合验收。

所有 W1–W4 完成后，才对本期已纳管的资源声明 **Platform-level resource namespace/isolation**。新增资源类型以后必须接入同一个 scope、解析规则和执行事实，不能仅增加 workspaceId 字段。


## 7. 执行记录（2026-09-17）

W1–W4 的核心交付已完成。实际结果、启动方法及剩余环境限制见 [验收记录](../platform-workspace-acceptance.md)。不以原计划的预期矩阵代替实测结果。

执行中的明确调整：

- Workspace 目录复用已有治理 Domain，不建立第二套权威表；新增字段兼容现有记录，无批量迁移或数据库切换。
- 资源类型与绑定测试合并到现有 shared-resources.spec.ts；兼容验证复用 workspace-isolation.spec.ts，并新增 platform-workspaces.spec.ts、workspace-runtime.spec.ts。
- MCP 使用现有 SDK 的平台适配器，每次解析凭证，避免将秘密写入版本 Preset；保留 Harness Agent Loop。
- 本地 Memory/Dataset 只实现有界条目存取，不扩展向量检索和评测评分。
- 全部新功能测试、相关业务回归、构建、类型和修改文件 lint 通过；Windows 符号链接、旧 ACP profile 及文档归档脚本的基线限制单独记录。
