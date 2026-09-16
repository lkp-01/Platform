# Agent Registry Implementation Plan

**Goal:** 将 Agent 从 Preset 配置提升为有稳定身份、组织归属、可编辑配置与独立详情页的平台资源。

**Architecture:** Registry 属于 Control Plane，通过 Cordis 插件提供资源管理，以现有 Storage Domain 持久化，通过 Typert Remote 和客户端插件呈现。Harness 继续负责 Agent Loop；Version、Runtime、Deployment 分别拥有版本快照、运行记录、部署事实，详情页只聚合它们的数据。

**Tech Stack:** 仓库现有 TypeScript ESM、Cordis、Storage Domain / SQLite、Typert Remote、React、Vitest 与 Web 测试设施。

**状态：** R1 已按单 Host 共享空间实施，验收与实际落点见 [交付记录](../agent-registry-acceptance.md)。实际复用现有 AgentBuilder 包、Remote 通道和客户端布局，Storage Domain 沿用部署后端；旧 Preset 在启动时幂等导入。R2 的 Version/Runtime/Deployment 联通及真实组织身份权限仍待后续模块。以下保留原实施规划，具体交付边界以验收记录为准。

## 1. 范围与交付层次

产品问题是“公司有哪些 Agent、分别由谁维护、配置是什么”，对应 Control Plane 的资源管理。第一阶段已有 Preset 发现和自助创建，尚不足以表达长期稳定的业务资源。本阶段有具体资源管理需求，因此可以新增 Registry 抽象，但不能同时重做执行引擎。

建议分成两个明确的交付层次：

- **R1：Registry 本体。** 创建、列表、详情、编辑元数据及当前配置草稿、归档/恢复、持久化、Workspace 归属、Owner 引用、旧定义迁移。
- **R2：完整资源详情联通。** 读取 Version 的版本列表、Runtime 的运行记录、Deployment 的部署状态，联通既有 Harness 执行入口。三个模块未具备能力时，此部分是显式依赖，不计作 Registry 已交付。

R1 可以独立验收。用户示例中的 `Current Version: v3 / Status: Deployed / Runs: 126` 属于 R2 联合验收，不能仅靠 Registry 开发宣称完成。

本计划默认先做单 Host、单写服务部署；第一版仅支持 DeepSeek Harness。保留 Harness 标识和受控目录接口，不建设通用多引擎编排。暂不做硬删除、跨 Workspace 转移、Marketplace、Prompt 版本 diff、评测、运行调度和完整 IAM。

## 2. 现有能力与实际缺口

以下源码路径均相对 `D:/developer/Platform/deepseek-harness-master`。

| 现有实现 | 可复用能力 | 本次缺口 |
|---|---|---|
| `packages/business/agent-builder/src/{types,index,definition,authoring}.ts` | 名称、Prompt、模型、工具的受限表单；目录原子发布；提交幂等 | 当前定义不可变，ID 来自创建 token；缺少长期资源身份、描述、归属和编辑 |
| `packages/client/ui-agent-preset/src/client/AgentBuilder.tsx`、`builder-store.ts` | 创建表单、模板填充和 Agent 列表弹窗 | 缺少平台首页资源列表和可直接打开的详情页 |
| `packages/preset/agent-presets/src/index.ts` | Preset 发现、解析、挂载、Session 关联 | Preset 是执行配置载体，不等于团队拥有的 Agent 资源 |
| `packages/api/session-controller/src/{types,agent}.ts` | Session 创建、Preset 绑定、初始模型钩子 | Session 不应直接被当作 Platform Run；缺少平台 Agent / Version 归因 |
| `packages/storage/storage-domain/src/{index,domain,spec}.ts` | Schema 校验、持久化、单 Domain 写入队列、单记录原子 update | 可承载 Registry；现有接口不提供跨服务事务或多进程 CAS |
| `packages/workspace/workspace/src/types.ts` | 本地目录与 Session 集合 | 不是 Redis Team 一类组织空间，不能直接复用其 ID 语义 |

已有验收记录见 [自助创建 Agent 验收](../self-service-agent-acceptance.md)。旧计划中“Preset 已满足 Registry”的判断适用于当时的单 Host 演示范围，本计划引入组织资源管理后，该判断不再覆盖本阶段需求。

## 3. 方案选择

| 方案 | 优点 | 代价 | 选择 |
|---|---|---|---|
| Control Plane Registry 插件 + 既有存储和执行适配 | 稳定身份独立于配置文件，复用当前技术栈 | 需要清晰划分草稿与执行配置的权威来源 | **推荐** |
| 继续给 Preset YAML 增加元数据 | 初始改动最少 | 资源身份、目录、版本和组织归属继续耦合，编辑影响执行配置 | 不作为长期资源模型 |
| 独立 Registry 微服务 + 新数据库 | 方便后续独立部署与多实例 | 当前增加网络、鉴权、运维和一致性成本 | 有多实例需求时再评估 |

新增插件即可实现 Registry 本体，无需修改 `core/agent-loop`。只有后续运行归因确实缺少公开钩子时，才单独论证 Session API 组合层的最小扩展。

## 4. 职责和页面字段来源

| 数据/动作 | 权威模块 | Registry 如何使用 |
|---|---|---|
| Agent ID、名称、描述、归属、标签、资源状态 | Registry | 持久化并管理 |
| 当前待发布配置：Harness、模型、Prompt、Tools | Registry 草稿 | 只保存当前值，不累积历史 |
| 不可变配置版本、历史 Prompt、版本号 | Version | 引用/查询，不保存第二份历史 |
| 发布到什么环境、当前部署版本、部署结果 | Deployment | 只读取摘要；创建或保存 Agent 不等于部署 |
| Run、状态、耗时、次数、trace | Runtime / Observability | 根据 Agent ID 查询，Registry 不累加计数 |
| Workspace、Team、User 与成员权限 | Control Plane 身份与空间模块 | 保存稳定引用，委托权限判断 |
| 模型连接、工具实现、凭证 | 模型目录 / Tool Platform / 凭证服务 | 保存受控 ID，不保存密钥或任意插件路径 |

`Active / Archived` 是资源生命周期；`Draft / Published` 是配置发布状态；`Deployed / Failed` 是部署状态。三者不能合成一个可自由修改的 `status` 字段。

详情页使用一个只读聚合层连接这些模块。Registry 服务自身不依赖 Runtime 才能启动；运行记录服务失败时，Agent 基本信息仍可用。

## 5. 最小数据模型

建议一个 Agent 聚合记录包含元数据与当前草稿，便于首次创建原子落盘。这里的结构是设计 DTO，实施时按仓库规范使用 branded IDs 和严格的边界 Schema。

```typescript
interface AgentRecord {
  id: AgentId;
  platformWorkspaceId: PlatformWorkspaceId;
  ownerTeamId: TeamId;
  name: string;
  description: string;
  tags: string[];
  lifecycle: 'active' | 'archived';
  revision: number; // 乐观锁，不是 v1/v2 业务版本
  draft: {
    harnessId: 'deepseek-harness';
    model: { provider: string; model: string };
    prompt: string;
    toolIds: string[];
  };
  createdBy: UserId;
  updatedBy: UserId;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
```

- `id` 在改名、编辑、发布、归档后保持不变，不能绑定可变的目录名或 Prompt 内容。
- 同一 Workspace 内名称允许重复，UI 通过描述和 ID 区分；第一版不引入 slug 唯一索引。
- `platformWorkspaceId` 明确区别于 Harness 的工作目录 Workspace ID。新建后不可由普通编辑接口修改。
- Owner 默认当前 Workspace 的团队；服务端校验其归属。创建者/修改者来自可信请求身份，不接受表单伪造。
- 模型继续保存现有 provider/model 组合，Tools 继续使用现有稳定 toolId。Harness 首版只有一个可选项。
- Prompt 当前正文可以放入草稿：这是当前配置数据，不是 Prompt 历史服务。Version 发布时获取完整快照；草稿覆盖不会自动形成版本。
- 第一版不在 Registry 表写入 `runCount`、`runStatus`、`trace` 或 `deployed`。当前部署版本由 Deployment 查询返回；“最新发布版本”由 Version 返回。
- 内部另含创建幂等指纹与可选 legacy Preset 引用，不在普通客户端详情中暴露。保留初始请求指纹，不能用编辑后的草稿判断旧创建请求是否重复。

## 6. 持久化、一致性和访问范围

复用 `ctx.storageDomain`，为 `platform-agent-registry` 定义独立 Domain，建议使用现有 SQLite backend。记录独立于安装目录，Host 重启可恢复。底层是 JSON record KV，不假设已存在 SQL 查询索引、关系外键或跨表事务。

更新使用 Domain 的 `table.update()`，在写入队列内部校验 `expectedRevision` 并增加 revision。两个用户从 revision 3 同时编辑，只允许一个提交成功；另一个返回 conflict，保留本地表单并提示刷新比较。禁止先读后无条件 put。

创建采用服务端按 Workspace + actor + requestToken 派生稳定 ID，并在 Registry 的创建队列中完成查重、初始指纹比较和单记录 put。相同请求重试返回相同 Agent；同 token 不同内容报冲突。元数据、草稿和幂等凭据同记录落盘，避免双写半成品。

这个策略只保证单 Registry 写实例。SQLite 并不自动消除 Storage Domain 的进程内缓存限制；第一版必须禁止多个写进程共享该 Domain，后续水平扩展应迁移到具备数据库条件更新能力的 repository。

读写均经 Workspace 权限策略。Owner 是归属信息，不等于访问授权。接入已有可信身份（若无则作为 Control Plane 前置依赖），最小权限为 viewer 读取、editor 创建/编辑、admin 归档/恢复；禁止只在前端过滤 Workspace。外部空间的 ID 返回不泄露对象存在性的错误。

若先交付本地演示，可用 Host 配置提供固定 Workspace、Team 和 actor，页面标明共享演示空间；这种模式不能宣称完成企业多租户隔离。真实团队上线前必须接入身份与成员权限。

## 7. 接口与校验

优先使用现有 Typert Remote 通道，不为同一功能再造 REST 服务。以下为拟议方法，权限上下文由服务端注入：

| 方法 | 行为 |
|---|---|
| `catalog(workspaceId)` | 返回受当前空间权限限制的 Harness、模型、工具、可选 Owner |
| `list({ workspaceId, query, ownerTeamId, lifecycle, cursor, limit })` | 只返回列表摘要，不包含完整 Prompt；默认排除归档 |
| `get({ workspaceId, agentId })` | 返回基本信息和当前草稿 |
| `create({ workspaceId, input, requestToken })` | 校验并创建资源；不执行模型、工具、发布或部署 |
| `update({ workspaceId, agentId, expectedRevision, patch })` | 更新允许字段，原子保存草稿/元数据；不影响既有执行版本 |
| `archive / restore({ workspaceId, agentId, expectedRevision })` | 幂等地管理生命周期，不清理历史版本和运行记录 |

独立的 Agent Details Controller 提供 `overview()`、`versions()`、`runs()` 等读取聚合入口。Run 数据由 Runtime 按真实 runId 分页；若只接入 Harness Session，应显示“会话”，不能把 Session 数量命名为 Runs。

复用现有名称长度、Prompt 上限、模型目录、工具集合校验；补充 description/tags 上限、分页 limit 上限、严格字段白名单和 Harness allowlist。下线的模型/工具不应导致整个列表或历史详情无法打开：返回配置不可用原因；修改相关配置、发布和执行时重新验证。

错误至少区分 validation、not-found、forbidden、revision-conflict、idempotency-conflict、dependency-unavailable、persistence-failed。业务失败保留表单；创建已提交但刷新失败时显示已创建的 Agent ID，重试不能再次创建。

## 8. 用户流程与页面

1. **平台首页 / Agents 列表：** 选组织 Workspace，展示名称、描述摘要、Owner、Harness、资源状态；支持搜索、Owner 筛选、归档筛选和分页。
2. **创建：** 名称、描述、Owner、Harness、模型、Prompt、Tools；延续现有模板填充能力。创建后进入详情，即使尚无版本和运行记录也能长期存在。
3. **详情概览：** 资源信息、归属、创建/更新时间、发布与部署摘要。
4. **配置页签：** 区分“当前草稿”与“已发布配置”；编辑保存只修改草稿。冲突时保留本地输入，不静默覆盖别人的修改。
5. **版本页签：** Version 提供真实版本列表，未接入时展示“版本服务未接入”。
6. **运行记录页签：** Runtime 提供状态、时间和 trace 入口；未接入时展示“运行记录未接入”。服务故障与实际零条记录要区分。
7. **归档：** 从默认列表隐藏，仍可查看历史。已归档资源禁止编辑草稿、发布和新运行；恢复后继续使用原 ID。已有运行不被取消。

示例卡片的 R2 映射：`Workspace: Redis Team`、`Owner: Redis Team` 来自组织目录和 Registry；`Current Version: v3` 必须明确为“当前部署版本（环境）”；`Status: Deployed` 来自 Deployment；`Runs: 126` 来自 Runtime 且明确统计范围，建议为该 Agent 在当前 Workspace 的累计 Run 数。

## 9. 与 Version、Runtime、Deployment 的接缝

发布流程由 Version 用例编排：权限检查 → 读取指定 revision 的完整草稿 → 创建不可变版本。返回版本的 sourceRevision，即使保存期间有人编辑，也只能发布取到的那份完整草稿；按 requestToken 幂等处理发布重试。Registry 不因保存动作自动创建版本。

部署由 Deployment 绑定环境与 agentVersionId。运行由 Runtime 获取具体版本，持久化 `agentId + agentVersionId + platformWorkspaceId`，然后经 Harness adapter 生成/解析不可变 Preset，继续委托 Session Controller 和官方 Loop。不能用可变草稿覆盖已挂载的 Preset，否则恢复历史 Session 时可能读取错误配置。

如果未来支持草稿试运行，配置快照归 Runtime 的执行输入管理，并明确标注未发布；不把试运行快照当作 Registry 的隐式版本历史。第一版不需要增加此能力。

归档检查必须位于受控发布/启动入口，不能仅隐藏前端按钮。若保留可直接按 managed Preset ID 创建 Session 的入口，adapter 必须对这些平台 Preset 验证所属 Agent 的生命周期和调用方权限；默认不得将受管理的执行产物暴露为可绕过权限的自由 Preset。已有运行与历史恢复不按新运行处理。

Runtime、Observability、Evaluation 共用后续执行事件和 trace 归因。Registry 的资源变更通知只用于资源刷新，不能另建一套运行事件库。

## 10. 旧定义迁移

- 三个内置业务 Preset 保留为模板；用户选择模板创建时才产生归属于某 Workspace 的 Agent 资源，避免自动把模板算成每个团队的 Agent。
- 现有自定义 `agent-*` 定义导入一个明确配置的默认组织 Workspace/Team；不推断真实创建者，标注 migration actor，记录导入时间。
- 保留旧 Agent ID 或稳定映射，保存 legacy Preset 引用，迁移可重复执行而不重复创建。先做 dry-run 报告，读取原格式并校验，损坏记录单独报告。
- 导入成功后，Registry 是新资源元数据和草稿的权威来源；原 YAML 保留为旧执行配置，不继续反向同步。草稿保存不得覆盖旧 YAML。
- 旧 Session 仍引用原 Preset，并可按原配置恢复。只有确认 Version/Runtime 接缝就绪后，新运行才走新版本入口。
- 切换创建页面时旧 builder 写接口应停用或委托同一 Registry 创建用例，不允许新旧两套入口持续产生彼此不可见的 Agent。
- Registry 插件/新 UI 可通过 bundle 配置关闭回退；保留原 Preset 和迁移前备份。R1 创建的新资源在旧 UI 中不可见，回退需明确说明这一限制，不能声称无损双向兼容。

## 11. 实施任务与文件落点

以下为拟新增路径；实施前读取源码子目录的 AGENTS.md、architecture 和相关开发约束。每项按“行为测试 → 确认失败 → 最小实现 → 针对性复验 → 独立提交”执行。任务内不要混入无关重构。

| 任务 | 主要文件 | 实施与验收 |
|---|---|---|
| T1 资源契约与存储 | 新增 `packages/control-plane/agent-registry/src/{types,schema,spec,repository,index}.ts` 和 `tests/repository.spec.ts` | 定义 ID、字段、生命周期；配置 Storage Domain；验证落盘、重启、revision 冲突、写入失败不更新内存、并发创建与幂等重试 |
| T2 Registry 业务与权限 | 新增同包 `src/{service,policy,catalog}.ts` 和 `tests/service.spec.ts` | 实现创建/读取/更新/归档；复用现有受限模型/工具目录；验证跨 Workspace 拒绝、伪造 Owner 拒绝、Prompt 原文和归档规则 |
| T3 资源 API 与只读聚合 | 新增 `packages/api/agent-controller/src/{index,types,overview}.ts` 和 `tests/controller.spec.ts` | 接入 Remote 身份、错误映射、列表分页；Version/Runtime/Deployment 使用可选 reader；依赖离线时基本信息仍可读 |
| T4 首页与详情 | 新增 `packages/client/ui-agent-registry/src/client/{AgentList,AgentDetail,AgentForm}.tsx`、`{store,locales}.ts` 和 `tests/*.client.spec.tsx` | 接入现有布局/slot；复用表单逻辑；完成 Workspace 选择、创建、编辑、归档、刷新恢复、详情深链接、空状态和权限状态 |
| T5 迁移与装配切换 | 新增 Registry 包 `src/legacy-import.ts`、`tests/legacy-import.spec.ts`；修改 `packages/bundle/business-agents/cordis.patch.yml`、`src/index.ts` 与 builder/client 入口 | dry-run 后幂等导入；保留旧 Preset；新入口统一到 Registry；验证旧会话和三个模板仍可用 |
| T6 R1 验收与文档 | 新增 `apps/web/tests/agent-registry.e2e.ts` 和平台 `docs/agent-registry-acceptance.md` | 浏览器创建→刷新→重启→编辑→冲突→归档→恢复；补权限负例；新包 README、JSDoc、必要 Agent Note 与生成目录一起更新 |
| T7 R2 模块联通 | 文件由 Version/Runtime/Deployment 后续模块方案确定；修改 controller reader 与新增 Harness adapter 集成测试 | 真实版本列表、真实部署状态和 Run 归因；改草稿不改变 v1；v1 历史恢复与 v2 新运行互不影响；归档入口无绕过 |

所有新包补齐 `package.json`、对应 Host/Client tsconfig、tsdown 配置及 README，并更新实际依赖、Remote 生成声明和 bundle 装配。生成文件使用仓库工具，不手工复制生成内容。

建议 T1–T3 一个后端里程碑，T4 一个前端里程碑，T5–T6 完成 R1 上线；T7 单独跟踪跨模块依赖。以一位熟悉仓库的工程师估计，R1 约 8–12 个工作日；已有身份服务可缩短接入时间，缺失身份模块和 R2 工作不包含在这个估算内。

## 12. 验证方式与完成标准

在 `D:/developer/Platform/deepseek-harness-master` 执行以下计划命令；这些是实施后的检查，不是本次已经运行的结果：

```powershell
pnpm exec vitest run packages/control-plane/agent-registry/tests packages/api/agent-controller/tests
pnpm exec vitest run packages/client/ui-agent-registry/tests
pnpm exec vitest run packages/business/agent-builder/tests packages/bundle/business-agents/tests packages/client/ui-agent-preset/tests
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/agent-registry.e2e.ts
pnpm run lint
pnpm run doc-sync
pnpm run hygiene
```

新增产品可见流程按仓库要求补 keyless snapshot；需要的 fixture 和注册跟随同次改动提交。对构建、文档或 Windows 既有失败分别记录原因，不能把未通过项标为通过。Registry CRUD 测试不需要真实模型密钥，也不应发起模型调用。

R1 必须同时满足：

- 页面创建的 Agent 在刷新和 Host 重启后仍存在；改名/编辑不会换 ID。
- 名称、描述、Workspace、Owner、Harness、模型、Prompt、Tools 均可查看，允许字段可编辑；空工具集有效。
- 存储失败不产生成功假象；并发编辑不丢更新；网络重试不重复创建。
- 团队模式下所有读写均有服务端成员授权；演示模式明确其共享范围。
- 归档/恢复不删除旧 Preset、版本和 Session；原有业务 Agent 与会话相关回归通过。
- 未连接的版本、部署、运行模块显示真实缺失状态，不能伪装为成功部署或零次运行。
- Registry 不包含 Agent Loop、任务状态机、运行计数器或完整 Prompt 历史。

R2 另需证明示例卡片每个字段都来自其权威模块，且 Agent → Version → Run 的关联可跨重启恢复；没有 T7 的验收结果，不宣布完整平台资源详情联通完成。
