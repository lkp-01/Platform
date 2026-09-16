# Agent Version Implementation Plan

**Goal:** 保存和查看不可变 Agent 配置版本，部署指定版本并回滚，让每次平台 Run 都关联实际执行的版本。

**Architecture:** Registry 管草稿，Version 管快照，Deployment 管生效版本，Runtime 管运行归因；通过 Cordis 插件、现有存储和 Harness adapter 联通，继续使用 Harness Agent Loop。

**Tech Stack:** 当前仓库的 TypeScript、Cordis、Storage Domain、Typert Remote、React、Vitest 与 Web 测试设施。

**状态：** 2026-09-16 已实施。基于当前工作区（包含尚未提交的 Registry R1），验收结果见 [Agent Version 验收记录](../agent-version-acceptance.md)。

## 1. 认可的产品方向与首版边界

认可“Version 是不可变 Agent 配置快照”的定义。目标是能够回答某次运行使用了什么配置，并能重新选择旧配置运行。

- 保存草稿与保存版本分开：普通编辑不自动生成 vN；开发者显式点击“保存为新版本”。
- 保存版本与部署分开：创建 v3 不改变当前运行的 v2。
- 回滚是将部署指针重新指向 v2，不覆盖 v3，不回写草稿，不重新生成一个内容相同的 v4。
- Run 在接受执行请求时固定版本；后续部署、回滚、草稿编辑不改变该 Run。
- 最新保存版本、当前部署版本、草稿 revision 是三个不同概念，界面分别展示。

首版支持单写入 Host、一个默认部署目标、受控模型与工具目录、版本保存/列表/详情、部署/回滚，以及最小 Run 归因。版本编号按 Agent 从 v1 递增。

暂不支持 branch、merge、diff、版本删除、灰度发布、多环境管理、代码仓库管理、完整 Runtime 调度和 Eval 评分。Eval 本期只获得可靠的版本关联，不实现评分页面。

配置快照保证平台保存的配置可追溯，不承诺完全复现模型输出。远端模型别名、工具服务实现和外部数据仍可能变化；记录可用的依赖标识，但不在本期扩展为工具代码或模型权重版本管理。

## 2. 已核对的现有能力

以下源码路径以 `D:/developer/Platform/deepseek-harness-master/` 为根。

| 位置 | 当前能力 | 本期使用方式 |
|---|---|---|
| `packages/business/agent-builder/src/registry.ts` | 当前草稿、稳定 Agent ID、revision、归档、Storage Domain 持久化 | 获取指定 revision 的完整配置，不另建草稿系统 |
| `packages/business/agent-builder/src/types.ts` | 模型 provider/model、Prompt、toolIds、Harness 标识 | 定义独立快照契约；不能直接将整条 Registry 记录当版本 |
| `packages/business/agent-builder/src/definition.ts`、`authoring.ts` | 受控组合生成、不可变目录、重试去重 | 提取可复用渲染/发布能力，为每个版本生成独立执行产物 |
| `packages/business/agent-builder/src/index.ts` | Remote 通道、模型目录校验、初始模型 hook、旧 Preset 归档检查 | 复用入口和 scope；补平台版本受控入口 |
| `packages/preset/agent-presets/src/index.ts` | Preset 解析、挂载，按 ID 共享已挂载组合 | 每个版本使用独立 Preset ID，禁止覆盖同一路径 |
| `packages/api/session-controller/src/agent.ts`、`types.ts` | 创建/恢复会话、Preset 绑定、模型选择与事件 | adapter 委托执行，补运行关联与必要的入口策略 |
| `packages/client/ui-agent-preset/src/client/AgentRegistry.tsx` | 草稿详情、版本/运行记录占位 | 在现有详情页补齐功能 |

当前 Registry R1 没有 Deployment 与 Platform Run。若只交付版本表，仍无法满足“部署、回滚、Run 记录版本”，所以本计划包含这两个相邻模块的最小闭环。

## 3. 方案和职责

选择“现有插件体系 + 持久化快照 + 默认部署指针 + Harness adapter”。不以不断复制 YAML 代替平台版本记录；也不在当前规模引入独立微服务和新数据库。

| 层 | 本期职责 |
|---|---|
| Registry | 可变草稿和资源生命周期，继续沿用现有实现 |
| Version / Control Plane | 不可变快照、业务版本号、创建记录、历史查询 |
| Deployment / Control Plane | 默认目标的生效版本、并发保护、部署/回滚历史 |
| Runtime | 接受任务、固定版本、记录 Run、对接 Harness 执行及结束事实 |
| Harness | 原有模型交互、工具调用、Agent Loop、会话持久化 |
| Observability / Eval | 消费相同 Run/Version 关联与 Harness 执行事件 |

Version 可先作为 AgentBuilder 包内独立模块实现；最小 Runtime adapter 使用独立模块与接口，不把任务执行塞入版本存储类。暂不为每个概念新增一整套包；出现明确独立部署需求再拆包。

预期不需要修改 `core/agent-loop`。先验证现有组合、Session 事件扩展和调用边界；如果无法拦截平台会话的模型切换或直接启动，只在 Session API 组合层补最小策略扩展，并在实施前记录原因和影响范围。

## 4. 最小数据契约

以下是拟议契约，不是已经存在的 API；实施时使用仓库 branded IDs 和严格 Schema。

```typescript
interface AgentVersion {
  id: AgentVersionId;
  agentId: RegistryAgentId;
  platformWorkspaceId: string;
  versionNumber: number;        // 展示为 v1/v2，与 Registry revision 无关
  sourceRevision: number;
  schemaVersion: number;        // 快照格式版本
  snapshot: {
    harnessId: 'deepseek-harness';
    prompt: string;
    model: { provider: string; model: string };
    toolIds: string[];
    executionConfig: JsonValue; // 白名单内、已解析的行为参数及组合默认值
  };
  configHash: string;
  changeNote: string;
  createdBy: string;
  createdAt: string;
}

interface AgentDeployment {
  agentId: RegistryAgentId;
  platformWorkspaceId: string;
  target: 'default';
  versionId: AgentVersionId;
  revision: number;             // 部署并发锁
  updatedBy: string;
  updatedAt: string;
}

interface RunAttribution {
  runId: RunId;
  agentId: RegistryAgentId;
  agentVersionId: AgentVersionId;
  platformWorkspaceId: string;
  configHash: string;
  deploymentRevision: number;
  sessionId: SessionId;
}
```

- 快照包括影响行为的配置。现有表单只支持模型选择、Prompt、工具；先盘点实际生效的模型参数、固定工具参数、persona 和 compaction 默认值，再确定 `executionConfig` 的严格字段。禁止把任意 JSON、插件路径或可执行表达式作为开放表单能力。
- 已支持且能通过现有扩展固定的参数随版本保存；未支持的参数不提供编辑入口。任何影响行为但无法冻结的 Host 设置必须标明边界并记录运行时实际值，不能假装已被版本锁定。
- Memory 本期未接入，不伪造配置；以后将 memory 策略/namespace 引用纳入快照，不把实际记忆内容作为版本。
- API key、token、密码不进入快照和 hash；只允许安全的连接/凭证引用。实际 provider/model 与调用参数继续由执行事件记录，排查依赖漂移。
- 名称、描述、Owner、标签属于 Registry 元数据，不因更名生成行为版本；如需要旧名称，可作为版本创建时的展示元数据另存。
- 历史快照读取只做结构校验，不依赖当前工具 allowlist 或模型在线状态；依赖下线后仍能打开历史详情。
- `configHash` 用于完整性校验和相同配置提示，不能代替版本 ID。相同配置的全新保存请求允许创建新版本；同一请求重试必须返回同一版本。

## 5. 保存版本与持久化

1. 客户端先完成草稿保存，再传 `agentId + expectedRevision + requestToken + changeNote` 保存版本。
2. 服务端检查 Workspace、资源 active 状态与 revision，读取并复制完整草稿；校验可执行配置并解析版本内默认值。
3. 将已捕获的完整内容写入版本存储。保存期间草稿继续修改时，版本仍只包含原 `sourceRevision` 对应的内容，不能重新拼读部分字段。
4. 成功后返回持久化版本；响应丢失后的同 token 重试直接返回原结果，不因草稿后来改变而创建另一个版本。

复用 Storage Domain，默认继承现有后端，不强制迁移 SQLite。现有存储缺少跨记录事务和跨进程 CAS：首版建议每 Agent 一个版本聚合记录，将版本序号分配、不可变条目、请求 token/原请求指纹放在一次 `table.update()` 内提交。对外不暴露更新/删除版本的方法。

同一 Agent 的并发保存通过该写队列排序，保证版本编号唯一；存储失败不能返回成功。记录大小随版本数增长是此最小方案的代价，后续规模扩大时迁移具备事务能力的 repository，不把它宣传成多写入实例方案。

保存流程与归档使用共同的单 Host、按 Agent 串行控制，避免归档已生效后又接受新的版本。跨草稿和版本记录的失败不回退已保存草稿；用户可凭相同 token 重试版本保存。

## 6. 部署与回滚

首版“部署”明确表示：指定当前 Host 上该 Agent 后续新任务的默认执行版本，不涉及容器构建或远程发布。

1. 读取目标版本并验证其属于同一 Workspace/Agent，检查 Agent 未归档。
2. 从该版本快照生成受控执行组合，为版本分配独立、稳定的 Preset ID 和目录；写入后校验 hash。组合产物记录渲染格式版本，后续不能用新的默认值静默重写旧版本产物。
3. 检查模型路由、工具和组合可加载；不为部署校验调用付费模型或执行业务工具。
4. 使用 `expectedDeploymentRevision` 原子切换默认指针，同时记录 from/to、操作者、时间、动作和 requestToken。
5. 只有切换成功才显示部署成功；失败保持旧指针。并发部署返回冲突，不最后写入者静默覆盖。

部署指针、部署历史及幂等记录放在一个部署聚合记录内提交，避免成功切换却没有审计记录。先完成不可变产物再切换指针：进程中断可能留下未启用产物，但不能留下指向半成品的部署。

回滚复用同一用例，目标为已存在旧版本，历史记录标记 rollback。旧模型/工具不可用时明确失败并保留当前部署；不能偷偷替换为相近模型或当前草稿。

保存版本和部署不互相隐式调用。归档后保留版本、部署历史和 Run，禁止新部署和新任务；已有任务继续按其绑定版本执行。

## 7. Run 归因与 Harness 适配

首版定义一个平台 Run 为一次明确提交的任务，包含 Harness 的多轮 LLM/Tool 循环，直至终态。最小实现为每个新 Run 创建独立 Harness Session，避免跨版本混用对话历史；Session ID 与 Run ID 是不同身份。

执行顺序：

```text
接受任务（requestToken）
  → 读取当前部署并固定 versionId/deploymentRevision
  → 持久化 Run 关联和确定的 sessionId
  → 加载该版本的独立 Preset
  → Session Controller / Harness 执行
  → 用 Harness 持久化事件投影 Run 状态和详情
```

- Run 记录落盘失败时不得启动执行；没有部署版本时拒绝新运行。
- 同一启动 token 重试返回同一 Run；首次已接受后，即使部署已切换，也不得重新解析到新版本。
- 用于入口幂等的绑定先于模型/工具副作用写入。对启动中断的 Run，重启后依据已保存 sessionId 和执行事实恢复/标记中断，不盲目重发任务；不承诺业务工具副作用 exactly-once。
- 运行记录列表/详情展示 Agent、vN、versionId、开始时间、状态、Session/trace 入口，并能跳转只读版本详情。
- 利用已有 Session 持久化事件与 projection 保存/查询归因，Run 存储只承担索引和平台任务事实，不复制完整 LLM/tool transcript；Observability/Eval 复用这些身份。
- 平台运行必须通过受控入口；不能直接调用普通 Session 创建接口绕过归档检查或缺失 Run 绑定。
- 当前 Session 支持模型切换。平台受管 Run 必须在服务端禁止改变已冻结的模型/配置，前端隐藏切换只作为体验层；普通非平台会话维持原行为。
- 恢复既有 Run 使用原版本和原 Preset，绝不读取当前部署。完整 retry/checkpoint/concurrency 产品能力另行规划。

## 8. 接口与界面

沿用 Typert Remote。拟议服务方法：

| 方法 | 输入/结果要点 |
|---|---|
| `versionCreate` | workspaceId、agentId、expectedRevision、requestToken、changeNote → Version |
| `versionList` / `versionGet` | Agent 范围内分页摘要 / 只读完整快照 |
| `deploymentGet` / `deploymentHistory` | 当前默认版本及分页历史 |
| `deploymentActivate` | versionId、expectedDeploymentRevision、requestToken、deploy/rollback → 当前部署 |
| `runStart` | agentId、任务输入、requestToken → 固定版本的 Run |
| `runList` / `runGet` | 按 Agent/versionId 查询真实记录 |

actor 来自现有 Host 服务端上下文，继续标明 shared-host；不接受客户端伪造创建者。不在本期声称具备组织 RBAC，但所有接口必须保持既有 Workspace/Owner 约束。

界面流程：配置页保存草稿 → 保存为新版本并填写可选说明 → 版本列表查看 v1/v2/v3 → 详情查看完整配置 → 点击部署或回滚 → 概览查看当前部署 → 发起任务 → Run 详情查看固定版本。

版本列表显示版本号、创建时间、创建者、说明、模型/工具摘要，以及当前部署标记。部署状态是读取 Deployment 后叠加的展示信息，不写进不可变版本。

存储失败、revision 冲突、幂等冲突、归档、依赖不可用分别提示；保留用户输入。最新版本、部署版本可并列显示，例如“最新 v3 / 当前部署 v2”。不增加 diff 编辑器。

## 9. 分阶段实施及文件落点

以下新增路径为建议落点；每项实施前读取相应子目录 AGENTS.md。按“关键行为测试 → 最小实现 → 定向验证”推进，不改动其他正在进行的 Registry 工作。

| 顺序 | 工作 | 文件落点（相对源码根） | 阶段验收 |
|---|---|---|---|
| T1 | 冻结快照边界与存储契约 | 修改 `packages/business/agent-builder/src/types.ts`；新增同目录 `version-schema.ts`、`versions.ts` 与 `tests/versions.spec.ts` | Prompt 原文保留；参数/默认值可解释；跨重启不变；并发编号与幂等成立 |
| T2 | 保存/查询版本接口 | 修改 `packages/business/agent-builder/src/index.ts`、`registry.ts`；新增 `tests/version-api.spec.ts` | revision 冲突、归档、跨空间、失败重试均正确；历史依赖下线仍可查看 |
| T3 | 不可变执行产物 | 新增 `packages/business/agent-builder/src/version-preset.ts`、`tests/version-preset.spec.ts`；按需提取 `definition.ts`、`authoring.ts` 的共用逻辑 | v1/v2 目录独立；旧渲染产物不被覆盖；执行实际 Prompt/工具/模型与版本一致 |
| T4 | 默认部署和回滚 | 新增 `packages/business/agent-builder/src/deployments.ts`、`tests/deployments.spec.ts`；接入 Remote | 原子切换、失败保留旧指针、历史持久化、并发冲突和幂等正确 |
| T5 | 最小 Runtime 归因 | 新增 `packages/business/agent-builder/src/platform-runs.ts`、`run-attribution.ts`、`tests/platform-runs.spec.ts`；必要时在 `packages/api/session-controller/src/` 添加受管执行策略扩展及对应测试 | 每个 Run 锁定版本；重试不重启第二次任务；直接启动/模型切换不可绕过；恢复不漂移 |
| T6 | 页面闭环 | 修改 `packages/client/ui-agent-preset/src/client/AgentRegistry.tsx`、`registry-client.ts`、`registry-locales.ts`、`AgentRegistry.module.css`；按复杂度提取 `AgentVersions.tsx`、`AgentRuns.tsx`；补客户端测试 | 草稿、最新版本、当前部署明确分离；版本详情、部署、回滚、运行关联可用 |
| T7 | 兼容、集成与交付 | 修改 `packages/bundle/business-agents/` 装配与测试；新增 `apps/web/tests/agent-version.e2e.ts`、平台 `docs/agent-version-acceptance.md`；更新包 README 和生成契约 | 完成下述完整场景；旧 Preset 和普通会话回归通过 |

T1–T2 是版本基础；T3–T5 构成可执行闭环；T6–T7 才完成用户可见交付。只完成版本保存和列表，不宣布整个功能完成。

新 Runtime/Version 模块若需要独立 package，先以实际依赖环或装配边界为依据再拆，不预先增设空包。生成声明、目录与文档使用仓库工具更新。

## 10. 旧数据与兼容

- 现有 Registry 资源保持草稿状态，默认版本列表为空；用户首次保存才产生 v1，不虚构历史。
- 旧自定义 Preset 与已有 Session 原样保留。不能把已编辑过的 Registry 草稿冒充旧会话当时的配置。
- 历史会话显示 legacy / 未关联平台版本；本期不批量补造 Run 或 v1。内置 Agent 继续作为模板。
- 旧 Agent library 的入口继续明确为 legacy 会话，不计入平台版本 Run。平台受管版本只能经受控入口启动。
- 新版本产物使用独立命名/目录规则，不匹配现有自动导入 `agent-*` 的规则，避免重启后把每个版本导入成一个新 Agent。
- 旧产物不因回滚、归档或配置编辑删除。恢复时缺失产物先按保存的原格式/内容校验重建；无法重建则报告不兼容，禁止用当前草稿替代。

## 11. 验证与完成标准

关键端到端场景：

1. 创建 SRE Agent 草稿，保存 v1；修改 Prompt/工具保存 v2，再修改模型保存 v3。
2. 查看 v1/v2/v3，配置各自完整且不可变；修改草稿不影响任何版本。
3. 部署 v3，启动 Run A，确认实际模型、Prompt、工具和归因均为 v3。
4. Run A 仍运行时回滚至 v2，再启动 Run B；A 保持 v3，B 使用 v2。
5. Host 重启后版本、当前部署、部署历史、Run 关联仍可查询；恢复 A 不转成 v2。
6. 并发保存、重复请求、存储故障和部署中断不会产生重复版本、错误成功状态或悬空部署。
7. 归档阻止新保存/部署/Run，但历史可查看；下线依赖不破坏历史查看，部署旧版本失败时保留原部署。
8. 普通会话、原 Agent 工作台、Registry CRUD 和三个业务模板相关回归通过；无新增 Agent Loop。

验收先使用仓库现有 mock 模型和工具，断言实际执行内容，不能只断言 UI 的版本标签；不使用示例 82%/89% 伪装成真实 Eval 成绩。

实施后在 `D:/developer/Platform/deepseek-harness-master` 执行相应检查（本次规划未运行）：

```powershell
pnpm exec vitest run packages/business/agent-builder/tests packages/bundle/business-agents/tests packages/client/ui-agent-preset/tests
pnpm exec vitest run packages/api/session-controller/tests
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/agent-version.e2e.ts apps/web/tests/agent-registry.e2e.ts
pnpm run lint
pnpm run doc-sync
pnpm run hygiene
```

补充受影响的 keyless snapshot；若修改 Session 事件/projection，再执行对应持久化与恢复测试。记录实际测试范围、失败和环境限制，不把未运行检查标为通过。

完成标准是“保存 → 查看 → 部署 → 真实运行归因 → 回滚 → 再运行 → 重启后追溯”的完整链路成立，且保持 Harness 和平台职责边界。Eval 之后可直接按稳定 versionId 关联样本与结果。
