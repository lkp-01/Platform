# Tool / MCP Resource Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> 执行时使用当前环境实际提供的 executing-plans 技能。本文是实施计划，不表示功能已经实现或测试通过。

**Goal:** 让 Platform 决定每个 Workspace、Agent Version 和 Run 可以发现及调用哪些 Tool / MCP，复用 Harness 完成实际工具执行。

**Architecture:** 延续现有 SharedResources、AgentVersion、Deployment、PlatformRuns 和 Trace。平台解析不可变绑定，通过 Agent scope 挂载 `dsh-mcp-client`，同时控制模型可见 schema 与调用授权；不创建第二套 Agent Loop 或 MCP 协议实现。

**Tech Stack:** TypeScript、Node.js、Cordis、现有 Storage Domain / JSON 或 SQLite backend、`@deepseek-ai/dsh-mcp-client`、Vitest 和现有 Web snapshot。

**基线：** 2026-09-17，Git HEAD `f6b66c8` 加当前工作区未提交的 Workspace 资源实现。已阅读本地源码，未运行功能测试。上游网页本次未能访问，本文不把用户提及的 RFC 当作当前 checkout 的能力依据。下文源码路径相对 `D:/developer/Platform/deepseek-harness-master/`；实施前应先固定当前 Workspace 改动的基线，不覆盖这些已有工作。

---

## 1. 现状与本阶段增量

| 已核对的源码 | 现状 | 本阶段动作 |
|---|---|---|
| `packages/business/agent-builder/src/shared-resources.ts` | 已有工作区目录、资源生命周期、发布版本、依赖递归校验 | 在同一目录上提供 ToolRegistry / McpServerRegistry 语义，不另建相同数据表 |
| `packages/business/agent-builder/src/resource-types.ts` | 已有 Tool、MCP Server、Credential；Tool 引用 Server，Server 引用 Credential | 增加 MCP 发现信息、transport 配置和完整的版本绑定表达 |
| `packages/business/agent-builder/src/workspace-runtime-resources.ts` | 已按 Agent 注册工具，但 `callWorkspaceMcp()` 直接创建 SDK Client；仅 HTTP，schema 来自手填参数 | 将这条路径替换为 Harness MCP adapter；保留 Memory 相关行为 |
| `packages/core/tools/src/index.ts` | `agent.ctx.tools.register()` 支持 scoped registration；`guard()` 支持最终单调拒绝 | 复用，无需修改核心 ToolRuntime |
| 同上 `restrict()` | **只过滤全局工具；scope-local 工具仍然可见** | 不能先注册所有 MCP 工具再仅靠 allowlist 或 guard 隐藏 |
| `packages/mcp/mcp-client/src/index.ts` | namespace 按 `scopeOf(ctx) ?? ctx.root` 隔离；支持 strict startup | 可以按 Agent 挂载同名 namespace，等待初始发现成功再运行模型 |
| `packages/mcp/mcp-client/src/tools.ts`、`connection.ts` | 已实现发现、schema、调用、分页、工具更新通知、重连与释放；目前发现的工具全部注册 | 增加可选的注册选择策略，初次连接、更新、重连都执行同一策略 |
| `packages/business/agent-builder/src/index.ts` | 已有 pre-step 挂载、request 检查和调用 guard | 提取共享的异步 prepare，覆盖正常启动及恢复执行 |
| `packages/business/agent-builder/src/platform-runs.ts` | 恢复路径会先调用 `RuntimeTools.recover()` | MCP 挂载必须早于恢复工具分派，不能只放在首次 pre-step |

本阶段解决“哪个 Agent 能看见并使用哪个空间的资源”，归 Control Plane 与 Platform Runtime 所有。Harness 已提供协议和执行扩展点；最小交付是补齐发现、绑定、解析、挂载、授权和 Trace 的闭环。

## 2. 目标链路与范围

```text
Workspace
  └─ MCP Server version ── credential_ref
       └─ discovered Tool versions
            └─ AgentVersion binding / manifest
                 └─ Deployment
                      └─ Run 固定 workspace + agentVersion
                           └─ resolve → prepare → Agent-scoped MCP adapter
                                └─ Harness ToolRuntime → 现有 Session Events → Trace
```

第一版交付：MCP 资源管理、连接测试与发现、工具选择、AgentVersion 固定绑定、HTTP 与 stdio 接入、同 Host 并发隔离、假凭证演示和 Trace 归因。原生业务 Tool 使用同一资源引用及调用 guard。

本期不引入独立 Gateway 服务、Java 服务、Kubernetes、连接池、跨 Workspace 共享或新的数据库。MCP Resource 指平台的 Server 元数据，本期仍只桥接 MCP Tools，不扩展协议的 Resources / Prompts。该能力隔离模型与工具访问权限；同进程插件和 stdio 子进程仍受 Host 信任模型约束，不宣称提供操作系统沙箱。

## 3. 架构决策

### ADR-1：沿用统一资源目录

- 决策：复用 `platform_shared_resources` 和 `forWorkspace()`；必要时添加薄的分类 facade，不复制 CRUD、版本发布和存储逻辑。
- 理由：现有记录已经具备 ownership、版本和状态；再建两套 Registry 会增加一致性问题。
- 约束：Tool → MCP Server → Credential 每一跳必须属于 Run workspace，版本也必须属于对应父资源。UI 过滤不能代替服务端校验。

### ADR-2：Agent scope + MCP 注册时筛选 + 调用 guard

- 决策：在 Agent scope 挂载 adapter。对全局工具使用现有 `restrict()`；对 MCP scoped 工具在 `syncTools()` 注册之前选择；每次分派由平台 guard 复核绑定及资源状态。
- 不采用：将 MCP 全部加载到 root 后只阻止调用。该方案会泄漏 schema，且全局可变注册会引入并发冲突。
- 必要的最小 adapter 扩展：为 `dsh-mcp-client` 增加可选的显式工具选择及描述校验参数，默认未配置时保持现有行为。该扩展不修改 Agent Loop、ToolRuntime 或 MCP 协议。
- 原因：现有公开配置没有选择 discovered tools 的能力，`restrict()` 又不能过滤 scoped registrations。只改 Platform 的 guard 无法满足“模型只看到授权工具”。
- 不建议用另一个工具执行流水线包住 MCP 再分派：容易产生重复 Trace、双重重试和额外生命周期。若实施时找到已有等价的公开选择接口，直接复用并删除本项扩展。

### ADR-3：绑定工具版本，Server 选择在发布时展开

- Agent 可以选择单个 Tool，也可以选择 MCP Server 的已发现工具集合；发布 AgentVersion 时全部展开为精确 Tool versions，并保存 Server / Credential 元数据版本引用。
- “绑定 Server”不是永久通配授权。Server 后续增加 `delete_all` 不会进入旧 AgentVersion；需要重新发现、选择、发布和部署。
- Tool manifest 固定 publicName、rawName、description、inputSchema、可用的 outputSchema 和描述摘要；保持 rawName 与模型名称分离，禁止从名称反向推断 workspace 或权限。
- 保留现有 `toolOperation()` 生成的历史 MCP 名称，通过 adapter 的显式名称映射接入；新版本也持久化最终名称。不能改掉旧 Run journal 的工具名。
- 模型可见 schema 必须来自已发布 manifest。远端新增无关工具忽略；选中工具缺失或描述/schema 变化按不兼容处理，拒绝启动或暂停后续分派，要求重新发布。
- 比较采用规范化 JSON 描述摘要，避免仅因对象键序变化误判。远端实际业务行为无法由 schema hash 保证不变，Demo 与正式部署需自行固定服务端版本。

### ADR-4：每个执行 Agent 独立持有连接，统一事件链

- 第一版连接归本次执行 Agent / Run attempt 所有；同一执行内每个绑定 Server 最多一条连接，不跨 Workspace、AgentVersion 或 Run 共享。
- 代价是连接和 stdio 进程更多；换取简单的取消、释放和凭证隔离。平台现有 Run 并发限制约束资源使用。
- MCP 连接重试由现有 adapter 管，工具业务调用重试继续由 `RuntimeTools` 管。默认不把 MCP 写操作加入 replay-safe；未知结果沿用人工介入流程。
- 所有真实 Tool Call 只走一次 Harness ToolRuntime，再进入已有 Session Events / Trace；不新增独立 MCP 调用日志系统。

## 4. 数据及运行契约

| 对象 | 建议增量 |
|---|---|
| MCP Server ResourceSpec | 显式 `transport`；HTTP endpoint 或 Host 批准的 stdio launch profile；credential 引用和非敏感配置；timeout / reconnect 策略 |
| Tool ResourceSpec | Server version ref、rawName、发现的 schema / description、描述摘要；现有原生 `operation` 继续支持 |
| AgentResources | 保留 `tools`；可增加 `mcpServers` 作为发布时展开的输入，不能在 Runtime 用浮动 latest 展开 |
| ResourceManifest | 完整工具列表和传递依赖元数据；无 secret；形成唯一 ResolvedToolSet 输入 |
| Run | 继续使用现有 workspace / agentVersion；必要时在现有 Run 记录中保存 manifest hash 及 name → resource 映射，不复制第二份 Run 身份 |
| TraceEvent | 按需要增加 toolResourceId、toolVersionId、mcpServerId / versionId；从持久化执行映射派生 |

建议平台内部接口（目标示意，实施时复用已有 branded ID）：

```ts
interface ResolvedToolSet {
  manifestHash: string
  tools: readonly ResolvedToolBinding[]
  servers: readonly ResolvedMcpBinding[]
}

// 只解析引用和公开描述；不解析 secret，不连接网络。
resolveRunTools(run: PlatformRun, version: AgentVersion): ResolvedToolSet

// 校验 → 解析凭证 → 挂载 → 等待 ready → 验证最终 schema。
// 返回可等待的清理句柄；正常执行与 recover 必须走同一个入口。
prepareRunTools(agent: Agent, run: PlatformRun): Promise<MountedToolSet>
```

关键规则：

1. `run.workspace = agentVersion.workspace = tool.workspace = server.workspace = credential.workspace`；先完成整条链校验再解析 secret 或连接网络。
2. 没有绑定就是空 Tool Set；不得回退到 Host 工具全集。受管理 Agent 的 native schema 只能包含已解析集合。
3. `restrict({ allow: [] })` 可屏蔽全部继承的全局工具；本地注册只由受信任的受管理 composition 产生。若存在未绑定的 local tool，在模型请求前拒绝执行，不悄悄泄漏。
4. MCP selection 的“未配置”保持普通 Harness 全量行为；“显式空数组”表示零工具；受管理执行始终传显式列表。
5. 初始发现、重连、`tools/list_changed` 都不得扩大列表；发现分页必须完整成功后再发布结果。
6. managed 模式发生已选描述不兼容时使该连接的已选工具不可调用并回收注册，不沿用当前默认的“保留 last good list 后继续调用”策略。普通 Harness 默认行为不变。
7. 挂载事务：任一必需 Server 失败，释放本次已创建的全部连接和注册；不发送部分工具集合的模型请求。重复 prepare 复用正在初始化的 Promise，失败后清理标记。
8. scope 来自持久化 Run，不能读取可变的 current workspace；注册、缓存和生命周期都不使用“全局当前 Agent”。
9. 取消、deadline、启动失败、Run 结束、Agent dispose、Host shutdown 均等待清理；一个 Run dispose 不能移除另一 Run 的工具。处理“连接尚未 ready 就取消”的竞态。
10. 恢复使用原 Run 的 AgentVersion 和描述摘要，重新检查资源状态及凭证，不能因 Deployment 更新而升级工具。

### 凭证与连接配置

- 延续现有 Credential metadata + Host `credentialBindings` + provider，Agent 只保存 Tool / Server 引用。
- stdio 的 secret 仅注入本次子进程 env，HTTP 注入本次连接 header；不改 `process.env`，不写生成的 preset、Agent snapshot、API response、Trace 或日志。
- stdio 使用 Host 预设的 command / args / cwd 模板，workspace 管理者选择模板及允许参数；不向普通 Agent 作者开放任意启动命令。
- 保持现有“凭证旋转后下一次调用使用新值”的验收语义。连接复用时，每次分派前经异步准备检查凭证，发生变化则在该 Run/Server 的互斥区内等待旧操作结束并重新挂载；同步 guard 只负责权限判断。secret 不进入持久化 hash。
- transport 保持既有 credential scrubbing；HTTP 禁止携带凭证跨重定向。检查连接失败 cause、logger 和 server 返回内容的脱敏，而不只检查 Trace 字段。
- Demo 用假的 credential provider 和本地 MCP fixtures；真实 secret manager 与自动 OAuth 不属于本期。

## 5. 实施任务与顺序

每个任务按“新增目标行为测试 → 验证失败原因 → 最小实现 → 定向回归”执行；通过后可作为一个独立提交。以下新文件为建议新增，其他为当前已有文件。

### Task 1：固定扩展点和隔离测试基线

**文件：** 新增 `packages/business/agent-builder/tests/tool-isolation.spec.ts`；复用 `packages/mcp/mcp-client/tests/apply.spec.ts` 和 `packages/business/agent-builder/tests/workspace-runtime.spec.ts`。

1. 建立同 Host 的 A/B 两个执行 Agent 和 fake model；记录实际传给 LLM 的 schemas。
2. 证明 Agent-scoped MCP namespace 可以复用；证明 `restrict()` 只影响全局工具。
3. 增加失败测试：同一个 MCP Server 提供 read/write，但 Agent 只绑定 read；write 在 schemas 中缺席，强制构造调用也不触达 Server。
4. 覆盖 root 在运行期间新增工具、scope-local 未授权工具；明确空集合行为。

**验收：** 先得到可重现的 schema 泄漏测试，再进入 adapter 改造；不能仅断言注册表数量。

### Task 2：MCP adapter 的显式选择和描述固定

**文件：** 修改 `packages/mcp/mcp-client/src/index.ts`、`tools.ts`、`connection.ts`；必要时修改 `transport.ts`；扩展 `tests/mcp-client.spec.ts`、`apply.spec.ts`、`reconnect.spec.ts`、`egress.spec.ts`。

1. 增加可选 managed selection，包含 rawName、可选 publicName 映射和预期工具描述；Platform 只传数据，不在 adapter 放 Workspace 逻辑。
2. 在注册前校验选中项存在、名称无冲突且描述相符。缺失选择参数保持普通 Harness 行为。
3. 对初次发现、列表通知和重连执行同一选择；严格模式的描述失配必须使旧分派失效。
4. 公开最小的 discovery / naming seam，复用已有分页及 schema 转换代码；禁止 Platform 再实现 `tools/list` 或 `tools/call`。
5. 测试取消和释放，确保部分挂载、过期连接 generation、重连失败都不能复活旧工具。

**验收：** 现有 MCP 行为回归通过；新增工具不会自动变成权限；选择项的失配可观察且拒绝执行。

### Task 3：资源发现与 Registry 元数据

**文件：** 修改 `packages/business/agent-builder/src/resource-types.ts`、`resource-schema.ts`、`shared-resources.ts`、`index.ts`、`platform-http.ts`、`platform-api.ts`；新增 `src/mcp-resources.ts`、`tests/mcp-resources.spec.ts`。

1. 扩展 transport / descriptor 数据模型，沿用同一 Storage Domain 和现有 optimistic revision、requestToken 幂等约束。
2. 在现有 Workspace resources 路由下增加连接测试、发现预览、导入为 Tool 草稿的操作；复用现有 admin 权限和错误处理。
3. discovery 使用短生命周期、独立且不继承给运行 Agent 的 scope；返回 tools 后必须释放，不能污染 root 注册表。
4. 完整发现后才允许导入；分页/连接失败不发布半份目录。重复导入以 Server version + rawName 定位，不能生成重复 Tool。
5. 发现结果先预览，再由用户发布资源版本；工具消失或 schema 更新不原地覆盖已发布版本。

**验收：** A 无法发现或导入 B 的 Server；失败不产生部分发布；发现操作不会调用任何业务工具。

### Task 4：AgentVersion 精确绑定与历史兼容

**文件：** 修改 `packages/business/agent-builder/src/versions.ts`、`version-schema.ts`、`version-preset.ts`、`types.ts`、`definition.ts`、`shared-resources.ts`；扩展 `tests/versions.spec.ts`、`shared-resources.spec.ts`。

1. 发布时展开 Server 选择，并固化 Tool / Server / Credential 元数据版本和模型工具名称。
2. Resolver 同时检查直接 Tool 和传递 Server / Credential 的工作区、版本及可用状态；拒绝冲突名称、重复绑定和不完整 schema。
3. 检查当前 `tools.max(11)` 等业务样例限制；将需要随部署变化的工具数量上限放到经过验证的配置，避免让 11 个内置 Tool 成为 MCP 限制。
4. 新快照格式走显式版本分支及相邻迁移；不修改旧快照、旧 hash 和旧模型工具名称。旧 MCP 手填 schema 不能被伪装成“已发现验证”：不兼容时保留历史并要求重新发现/发布。
5. 保持普通原生业务工具、现有 Memory 自动工具和已发布 Agent 的兼容路径；禁用/归档阻断执行，deprecated 的历史执行遵循现有策略。

**验收：** 发布新 Tool / Server 版本不会改变旧 AgentVersion；Deployment 升级不改变已存在 Run。

### Task 5：Runtime 解析、挂载和恢复

**文件：** 新增 `packages/business/agent-builder/src/runtime-mcp.ts`、`tool-resolver.ts`、`tests/runtime-mcp.spec.ts`；修改 `src/workspace-runtime-resources.ts`、`index.ts`、`platform-runs.ts`；扩展 `tests/runtime-recovery.spec.ts`、`workspace-runtime.spec.ts`；更新 `package.json` 依赖。

1. 实现无 I/O 的 `resolveRunTools()` 与可等待的 `prepareRunTools()`；挂载完成并验证最终 schemas 后才允许模型运行。
2. 将 `callWorkspaceMcp()` 的直接 SDK 调用移除，替换为 dsh-mcp-client；保留现有 Memory 逻辑和 Credential provider。
3. 正常启动、重试、恢复都先 prepare，再进入 Harness loop 或 `RuntimeTools.recover()`。注册与释放统一归可等待的执行句柄管理。
4. 处理幂等初始化、并发调用、凭证旋转、取消和部分连接失败；失败路径释放所有本次持有资源。
5. 加入最终绑定 guard；通过 native ToolRuntime 及 PTC 分派的能力调用都受相同授权。若受管理 preset 当前仅使用 native，本期保持该模式，不能靠额外开放 `run_code` 扩权。
6. 已授权只读操作沿用现有 replay-safe 配置；写操作未知结果进入现有介入流程，不能因 reconnect 成功自动重放。

**验收：** 冷启动与恢复得到相同 Tool Set；同 Host A/B 并发无交叉 schema、调用、凭证或释放干扰。

### Task 6：Trace 归因与错误状态

**文件：** 修改 `packages/business/agent-builder/src/trace-types.ts`、`trace-schema.ts`、`trace-projection.ts`、`platform-traces.ts`；扩展 `tests/trace-projection.spec.ts`；必要时扩展现有 Run lifecycle 类型及其消费者。

1. 由固定 manifest 的 publicName 映射补充 Tool / Server 资源 ID 和版本归因。
2. 复用现有工具 start/result 事件，验证 success、denied、timeout、cancel、MCP error 均可追溯且不重复计数。
3. 准备阶段失败尚无 Tool Call，使用现有 Run failed / lifecycle 错误字段记录脱敏原因，不伪造一次工具调用。
4. 记录公开 manifest hash 与准备结果所需元数据，使重启后 Trace 可重建；不依赖当前目录最新名称。
5. 校验模型可见 schema 已由现有 Session 日志完整记录；若缺项，使用已有事件扩展规则补齐，并更新受影响投影和 SDK 消费者。

**验收：** A/B Trace 归属正确；凭证、环境变量及认证 header 不出现在持久化执行记录；历史 Trace 不因重命名资源而改变归因。

### Task 7：管理界面与可重复 Demo

**文件：** 修改 `packages/client/ui-agent-preset/src/client/SharedResources.tsx`、`ResourcePicker.tsx`、`registry-locales.ts`；新增 `apps/web/tests/platform-mcp.e2e.ts` 和 owner-local snapshot；新增 `packages/business/agent-builder/tests/fixtures/platform-mcp-server.ts`；更新 `packages/bundle/business-agents/workspace-demo.patch.yml`。

1. 复用资源页：MCP Server 配置、连接/发现、工具预览、发布；凭证页只显示 alias / ref。
2. Agent 编辑器按 Server 分组选择具体工具，显示固定版本；提供“选择当前已发现工具”而非无限通配。
3. Demo 数据：A 有 filesystem、redis；B 有 github。Agent A 仅绑定 Redis Tool，Agent B 仅绑定 GitHub Tool。
4. fake model + 本地 MCP fixture 提供无密钥、可重复的验收；另用实际 filesystem MCP 做 stdio smoke。fixture 模拟 Redis/GitHub 的结果不冒充真实服务连通性验证。
5. 同时启动两个 Run，展示实际模型请求 schemas、各自成功调用和 Trace。再演示强制越权拒绝、工具更新不扩权和 A 取消不影响 B。

**验收：** 用户从资源注册到 Agent 绑定、部署、运行及 Trace 可以完成完整操作；产品文字进入现有中英文 locale。

## 6. 必须通过的验收矩阵

| 场景 | 预期证据 |
|---|---|
| A 只绑定 Redis | 实际 LLM request 中只出现绑定的 Redis schema |
| 同 Host 并发运行 B | A 无 GitHub schema；B 无 Redis schema；root 无运行级 MCP 注册残留 |
| 同 Server 只选 read | write schema 不出现；伪造 write 调用被拒，Server 收到的业务调用数为 0 |
| A 引用 B 的 Tool / Server / Credential | 每一跳均拒绝；在失败之前没有解析外区 secret 或打开连接 |
| Server 增加工具、重连或列表更新 | 旧 AgentVersion 的可见工具集合不增加 |
| 选中工具删除或 schema 变化 | strict startup 失败或连接进入不可执行状态；没有沿用不兼容旧工具执行 |
| 发布 v2，恢复 v1 Run | 仍用 v1 manifest 和工具名称；禁用依赖时拒绝恢复 |
| MCP 部分启动失败、取消和 deadline | 不发出部分 schemas；无残留进程、连接和注册 |
| 凭证隔离与旋转 | A/B 使用各自值；下一次调用使用旋转后的值；持久化信息无 secret |
| native / PTC 越权调用 | 所有受支持分派路径都进入相同 guard；不触达未授权 Server |
| 成功、错误、超时、拒绝、恢复 | 现有 Trace 完整关联 Run / Version / Workspace / Tool，单次调用不双计数 |
| 历史数据与内置能力 | 原生工具、Memory、旧版本读取及已有 Runtime 回归继续通过 |

## 7. 验证命令与交付记录

以下命令在 `D:/developer/Platform/deepseek-harness-master/` 执行；其中新测试在相应 Task 创建后运行。当前计划阶段尚未运行这些命令。

```powershell
# 按任务定向运行；有失败先判断是否来自正在进行的 Workspace 基线。
pnpm exec vitest run packages/business/agent-builder/tests/tool-isolation.spec.ts
pnpm exec vitest run packages/mcp/mcp-client/tests
pnpm exec vitest run packages/business/agent-builder/tests/mcp-resources.spec.ts packages/business/agent-builder/tests/versions.spec.ts packages/business/agent-builder/tests/shared-resources.spec.ts
pnpm exec vitest run packages/business/agent-builder/tests/runtime-mcp.spec.ts packages/business/agent-builder/tests/runtime-recovery.spec.ts packages/business/agent-builder/tests/workspace-runtime.spec.ts
pnpm exec vitest run packages/business/agent-builder/tests/trace-projection.spec.ts packages/bundle/business-agents/tests
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/platform-mcp.e2e.ts
pnpm run test:docs
pnpm run doc-sync
```

涉及新的 model-visible 行为时补充仓库要求的 keyless recorded-session snapshot；fixture 和预期结果放在对应 owner 的测试目录，按实际覆盖面运行，不默认重跑全仓 coverage。发布路径改变后补相应 built smoke / hygiene。stdio fixture 应符合仓库子进程启动测试约定；Demo 应用仍通过 `dsh --profile` 启动。

完成实施时新增外层 `docs/tool-mcp-isolation-acceptance.md`，记录实际命令、结果、schema 证据、Trace 证据与未覆盖的真实服务；更新 MCP Client / Agent Builder README 及对应双语文档、配置目录，并按仓库规则新增 Agent Note。需要新增 SessionEvent 时同步受影响 SDK 预期输出。

## 8. 建议里程碑

1. **M1：隔离内核成立（Task 1–2）**——一个 Server 多工具，Agent 只看到选择项，重连不能扩权。
2. **M2：Platform 资源闭环（Task 3–5）**——Workspace → Tool / MCP → AgentVersion → Deployment → Run，含恢复和凭证。
3. **M3：可验收演示（Task 6–7）**——A/B 同 Host 并发、越权拒绝、Trace 归因和 UI 流程全部有可重复证据。

优先把 M1 的失败测试和 adapter 最小扩展做实，再扩展管理界面；整个阶段的完成标准是模型 schema、实际分派、恢复和 Trace 四处使用同一份固定授权集合。
