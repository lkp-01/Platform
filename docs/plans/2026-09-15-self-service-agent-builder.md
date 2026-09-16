# 自助创建 Agent 升级计划

**Goal:** 用户在页面填写名称和 Prompt、选择 Model、勾选 Tools，点击 Create Agent 后得到可保存、可重复使用的 Agent。

**Architecture:** 增加轻量 Control Plane 作者服务，将受限表单输入生成 Harness Preset，继续使用官方发现、挂载、Session Controller、模型选择状态和 Agent Loop。三个现有 Agent 保留运行入口，同时提供模板；平台不新增独立执行循环。

**Tech Stack:** 当前仓库的 TypeScript ESM、Cordis、Typert Remote、React、文件持久化、Vitest、Web 浏览器测试。

**状态：** 已按用户指令实施。实际实现复用 `ui-agent-preset` 的客户端界面，并通过 Session Controller 的 `api-session/initial-model` 钩子应用保存的模型，覆盖所有新建会话入口。交付与验收见 [自助创建 Agent 验收](../self-service-agent-acceptance.md)。以下保留原设计任务拆分，具体结果以验收记录为准。

## 1. 本阶段产品目标

完成「定义一个 Agent → 保存 → 在列表找到它 → 开始新会话 → 按所选配置运行」的闭环。业务人员创建第四个 Agent 时，不需要修改源码、手写 YAML 或重启服务。

需要区分两件事：

- **Create Agent：** 保存可复用的业务定义，不调用模型、不创建一份新进程。
- **Start Chat：** 依据这个定义创建独立 Session，运行仍由原有 Harness 完成。同一个 Agent 可以开多个会话。

默认规划：单 Host、现有访问范围内的共享 Agent 列表、平台已配置的模型、平台已注册的业务工具。此阶段不提供每个用户单独的「我的 Agent」隔离承诺。

## 2. 当前实现与缺口

以下路径相对 `D:/developer/Platform/deepseek-harness-master`。

| 能力 | 已有实现 | 本次需要补齐 |
|---|---|---|
| 三种业务定义 | `packages/bundle/business-agents/presets/` 的客服、数据、运营配置 | 空白创建、模板填充、保存新定义 |
| 定义发现与挂载 | `packages/preset/agent-presets/src/index.ts`；list/resolve 每次读取目录 | 把服务写入的定义目录加入发现根目录 |
| 已有作者接口 | `packages/preset/agent-presets/src/authoring.ts` 支持复制、读取、删除 | 固定字段的创建接口；现有 copy 不能表达自由 Prompt 和任意工具子集 |
| 持久化目录 | 业务 patch 只启用 system 业务根目录，关闭 includeUserRoot | 指定独立、持久、可写的托管目录，不写入安装包 |
| Prompt | `packages/preset/persona/src/index.ts` 支持角色提示词 | 用户文本按原文传入，避免被当作模板表达式 |
| 模型目录 | `packages/api/session-controller/src/catalog.ts` 已从已安装 Provider 构建模型目录 | 复用目录，保存 provider/model 组合 |
| 模型运行配置 | `SessionCreateRequest` 当前无 model；`selectModel` 会顺便保存全局默认模型 | 首次创建 Session 时应用 Agent 自带模型，且不改变其他 Agent 的默认模型 |
| 业务工具 | 三个业务插件提供 3、4、4 个工具 | 按单个工具选择注册，允许跨组组合与零工具 |
| 运行与日志 | Session Controller、Loop、model/selection、模型请求及 tool/result 日志 | 接入现有路径，测试配置进入真实请求与工具调用 |

源码阅读特别发现：`tools.restrict` 过滤继承工具，不会移除同一 scope 自己注册的工具。因此不能给当前整组注册的业务插件加一个同层 allow 列表，就认为已经实现逐项勾选。

## 3. 方案选择

| 方案 | 收益 | 成本/限制 | 决策 |
|---|---|---|---|
| 表单 → 受限作者服务 → Preset | 延续现有实现，存储和运行方式一致，改动较小 | 文件方案适用于当前单 Host；需要处理完整写入和配置校验 | **本阶段推荐** |
| Agent 数据库 → Preset 编译或动态适配 | 便于后续版本、查询、多服务实例与租户管理 | 现在就产生数据库与执行配置的一致性问题 | 出现明确需求时再引入 |
| 开放 Cordis/YAML 编辑器 | 实现简单，灵活 | 用户需要理解插件和配置语言；原始配置还可以包含可执行表达式 | 不作为业务创建入口 |

这次确实需要新增的是「业务人员编写 Agent 定义」能力。Harness 已拥有配置发现和执行机制，因此不再新建另一份运行 Registry、Factory 或 Loop。

## 4. 页面与用户流程

### 4.1 Agent 列表

- 展示名称、模型名称、工具数量，以及「内置」或「自定义」标识。
- 保留现有三个内置 Agent，可以直接运行，也可以选择「以此为模板创建」。
- 提供 Create Agent 入口与每个 Agent 的 Start Chat 操作。
- 原有聊天选择器继续可用；创建后刷新对应列表。

### 4.2 创建表单

| 字段 | 交互与规则 |
|---|---|
| Name | 必填，用于列表识别；id 由服务端生成，名称不作为文件路径 |
| Prompt | 必填、多行输入；定义角色、目标、规则及输出要求；保留换行和原文 |
| Model | 单选，来源于 Host 模型目录；保存 provider + model；无可用模型时展示原因并阻止提交 |
| Tools | 多选，按客服、数据、运营分组；展示名称、用途和模拟操作标识；可跨组勾选，也可不选 |

从模板创建只预填同一张表单，用户可以修改 Prompt、Model 和 Tools，不维护三套创建页面。创建新定义时将模板使用的默认模型解析成具体模型；原有三个内置配置可以继续保持当前 Host 默认模型语义。

点击 Create Agent 后：校验 → 保存完整定义 → 刷新列表 → 显示创建成功和 Start Chat。请求失败保留表单。创建成功但列表刷新失败应提示「已创建，刷新失败」，不引导重复创建。

本阶段允许用「以此为模板创建」做迭代，暂不就地编辑或删除定义。这样历史 Session 引用的 Preset 不会因为这次引入的 UI 操作被覆盖或移除。

## 5. 定义与持久化

产品层最小定义：

```typescript
interface AgentDefinition {
  id: string;                     // 实现时采用仓库要求的 branded id
  name: string;
  prompt: string;
  model: { provider: string; model: string };
  toolIds: string[];
}
```

创建请求没有客户端指定的路径、插件包、JS/YAML、provider URL、API key、memory 或 permission。提交去重 token 属于请求处理字段，不属于 Agent 的业务配置。

建议每份定义仍落成一个 Preset 目录：名称使用现有 `preset.yml`，业务配置使用 `agent.cordis.yml` 中平台固定插件的受验证 config。作者服务负责序列化、读取和 DTO 投影；不额外维护一份可独立修改的 JSON 数据库或 JSON 文件。

同一次提交先在不被扫描的暂存目录写入完整内容，验证固定插件、模型引用、工具引用和配置格式，再在同一文件系统发布到最终目录。提交失败不留下可发现的半成品；服务端生成唯一 id，并提供可跨请求重试识别的创建 token。重复 token 必须核对请求内容，避免同一个 token 被用于两份不同定义。

定义创建仅校验配置及模型路由可解析，不消耗 token 测试模型，也不执行业务工具。模型目录可见不保证远端服务永远可用；后续运行失败应展示实际错误。

## 6. 后端职责与接口

新增一个平台作者插件，承接 Control Plane 的以下操作，使用现有 Typert Remote 通道：

- `catalog()`：返回可选模型、单工具目录和内置模板摘要。模型查询复用现有目录实现。
- `list()` / `get(id)`：读取 Preset 和受限平台配置，投影为页面数据。
- `create(input, requestToken)`：校验并保存完整的新定义。
- `startChat(id, workspaceId)`：解析保存的配置，委托现有 Session Controller 建立会话。

这些名称是拟议接口，不代表现在已存在。Service 内部复用 Preset 服务，不保存第二份同内容 Registry。

### 6.1 Prompt 按文本传递

现有 Persona 会解析 `{{variable}}`，用户粘贴的 Prompt 可能恰好包含这样的内容。建议通过作用域插件注册一个固定变量，例如 `platform_agent_prompt`，Persona 的 prefix 只引用 `{{platform_agent_prompt}}`；变量值返回用户 Prompt。现有渲染器不会再次扫描替换后的值，可复用此能力保持文本原样。

用户 Prompt 定义角色和业务规则；Host 必要的系统说明及工具说明继续由 Harness 组合。必须测试换行、引号、Unicode、`{{...}}` 和类似 YAML 标签的文本按普通内容处理，并进入现有可重建的模型请求日志。

### 6.2 Model 在首条请求前绑定

建议为 Session Controller 增加可选的 `initialModel` 请求字段：平台 startChat 从已保存定义读取并传入，后端校验，在 `composeAgent` 的 setup / 正式发布之前通过既有 Session 选择机制写入 `model/selection`。原调用者省略该字段，行为保持当前默认逻辑。

此变更属于 API 组合层，不修改 `core/agent-loop`。优先复用 `resolveCallConfig` 和 `selectForNextRequest`。不能直接复用当前 `selectModel` 命令作为初始化，因为它还会调用 `agentDefaultModel.saveSelection`，使一次启动意外改变全局默认模型。

初始化只针对新 Session；恢复、显式 id 复用或历史会话不得用 Agent 默认值覆盖已记录模型。更新类型、Remote 生成结果和所有受影响调用者；选择器为自定义 Agent 开新会话时统一走此入口。重开已有会话使用历史记录，不重新初始化。

原有聊天内手动切换模型可以保留：它是当前 Session 的选择，不回写 Agent 定义。每次从该 Agent 开新会话仍取定义中的模型。

### 6.3 Tools 按实际选择注册

第一版目录仅包含现有 11 个业务工具。目录记录稳定 toolId、显示名称、描述、分组、是否模拟操作和服务端插件映射；业务用户只能选择 toolId。

为三个业务工具插件增加可选 `enabledTools` 配置，未传时保持原有整组注册行为；传入时只注册指定工具。作者服务按选择集合生成必要的插件行，校验 toolId 与工具组匹配。空选择不挂载业务工具，同时屏蔽不应继承的 Host 工具。

当前 `isolateTools` 在每个业务插件中执行，需要核对跨组挂载和 scope 继承的效果，必要时将共享隔离策略集中到平台组合插件，防止后挂载组误伤前一组。以最终 Session 的精确 schema 集合和真实执行拒绝作为判定依据。

跨组选中多个工具不自动形成业务流程，也不自动解决参数依赖。工具描述需要说明已知 orderId、dataset 等输入要求；不为了「方便」偷偷勾选或开放额外工具。

## 7. 分阶段实施任务

文件路径均相对源码根目录；新包需按仓库规则补齐 manifest、tsconfig、README、构建声明和必要的生成配置。

### T1：工具目录与精确选择

**拟新增：** `packages/business/agent-builder/src/catalog.ts`。

**拟修改：** `packages/business/business-tools/src/{customer-service,data-analysis,operations,shared}.ts`。

**拟新增测试：** `packages/business/business-tools/tests/selection.spec.ts`。

步骤：先补精确工具集合和未选工具调用失败的用例；新增按配置注册；覆盖跨组三种组合及零工具；运行既有组合测试，证明三个内置 Agent 保持 3/4/4 个业务工具和原有模拟记录隔离。

**验收：** 自定义 Agent 的实际业务工具集合等于勾选集合；恶意强制 dispatch 不能调用未选择工具。

### T2：受限定义存储与 Prompt 适配

**拟新增：** `packages/business/agent-builder/src/{index,types,definition,authoring,prompt}.ts`。

**拟修改：** `packages/bundle/business-agents/cordis.patch.yml` 及 resolver 依赖声明。

**拟新增测试：** `packages/business/agent-builder/tests/{authoring,prompt}.spec.ts`。

步骤：先定义表单 DTO 及输入上限配置；编写无效模型/工具、重复提交、半成品不可见测试；实现固定配置序列化与原子发布；接入持久根目录；使用官方 Persona 与变量注册验证原文 Prompt；重启后从磁盘重新发现定义。

**验收：** 无需手改 YAML 即可创建第四份配置；无需重启可发现；实际重启后仍存在；原三个定义不被覆盖。

### T3：Agent 到 Session 的模型绑定

**拟新增：** `packages/business/agent-builder/src/launch.ts`。

**拟修改：** `packages/api/session-controller/src/{types,commands,agent}.ts` 及受影响 Remote 类型/消费者。

**拟新增测试：** `packages/api/session-controller/tests/session-initial-model.host.spec.ts`、`packages/business/agent-builder/tests/launch.spec.ts`。

步骤：先编写两个 Agent 使用不同模型且全局默认不变的用例；补 initialModel 校验和 setup 前置绑定；接入平台启动服务；验证模型不可用失败、恢复不覆盖、取消隔离和首条消息不会抢跑；固定模型响应经过真实 Harness Loop，捕获 Prompt、model、tool schemas。

**验收：** 任意新会话的第一次及后续请求使用正确配置；A/B Agent 并发运行不互相改变模型、工具或模拟写入记录。

### T4：页面创建、模板和列表入口

**拟新增：** `packages/client/ui-agent-builder/`，包括表单、列表、客户端 store、locale 和交互测试。

**拟修改：** `packages/client/ui-agent-preset/src/client/` 中列表刷新及启动接入点，以及业务 bundle 的客户端插件装配。

**拟新增浏览器用例：** `apps/web/tests/agent-builder.e2e.ts`。

步骤：复用现有 UI primitive 和 locale 约定；展示 Name / Prompt / Model / Tools；支持空白与模板填充；处理加载、空目录、字段错误、重复点击和网络失败；保存后刷新列表；从列表和旧选择器启动同一份配置。

**验收：** 用户全程通过页面完成创建第四个 Agent、刷新查找和开始对话；创建动作本身没有模型调用。

### T5：集成回归与交付

**拟更新：** `packages/bundle/business-agents/README.zh.md`、对应英文文档及仓库要求的 Agent Note；新增 `docs/self-service-agent-acceptance.md` 于 Platform 根目录。

步骤：运行相关单测、浏览器测试、配置/类型/构建/文档检查；补用户可见变更要求的无 key 快照；最后用已配置真实模型验证一次新建 Agent 的工具调用与最终结果。真实服务不可用时，将真实模型项记录为未验证，不用 mock 结果替代。

**验收：** 下方矩阵有测试或操作证据，存储路径及重启方式有文档，未通过门禁明确列出原因。

## 8. 验收矩阵

| 场景 | 预期 |
|---|---|
| 从空白创建 Agent | 新配置被保存并列出，原三种 Agent 保持可用 |
| 从三种模板分别创建 | 表单正确预填，保存为新 id，模板原件保持原状 |
| 不选工具 | 正常纯对话，不获得默认业务工具或 Host 工具 |
| 跨组选择部分工具 | 模型仅看到选中业务工具，未选执行请求被拒绝 |
| Prompt 含换行、中文、引号和 `{{...}}` | 原文进入最终角色说明，不作为代码或模板再次解析 |
| 两个 Agent 选不同模型 | 首次真实 Loop 请求分别匹配选择，Host 默认不变 |
| 保存后刷新、服务重启 | 配置仍可发现并开新会话 |
| 同一 Agent 两个会话、不同 Agent 并发 | 会话和模拟写入隔离，取消一个不影响其他会话 |
| 首次启动立即发送 | 必须在模型与工具装配完成后接受执行 |
| 重复点击、响应丢失后重试 | 相同提交返回同一创建结果，不重复定义 |
| 模型/工具无效或运行时不可用 | 返回具体错误，不静默回退到其他模型或额外工具 |
| 重开历史 Session | 使用已有 Session 状态，不覆盖模型选择或历史身份 |
| 回归现有三个 Agent | 原业务 Prompt、工具行为及模拟操作仍正常 |

建议定向命令（新增路径在实现后才存在；本次未运行）：

```powershell
# 工作目录：D:/developer/Platform/deepseek-harness-master
pnpm exec vitest run packages/business/business-tools/tests packages/business/agent-builder/tests packages/bundle/business-agents/tests
pnpm exec vitest run packages/api/session-controller/tests/session-initial-model.host.spec.ts packages/api/session-controller/tests/session-models.host.spec.ts packages/api/session-controller/tests/session-presets.host.spec.ts
pnpm exec vitest run packages/client/ui-agent-builder/tests packages/client/ui-agent-preset/tests
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/agent-builder.e2e.ts apps/web/tests/business-agents.e2e.ts
pnpm run typecheck
pnpm run lint
pnpm run hygiene
pnpm run doc-sync
```

## 9. 本阶段边界与下一步

本阶段不新增创建时的 Memory、权限、温度、最大 token、知识库上传、工具安装、API key 管理、发布审批或版本管理页面。平台仍使用既有会话上下文和部署配置；工具是否可见、是否可执行属于本次勾选功能本身的正确性要求。

后续如果需要「编辑 Agent」，再增加不可变配置修订和历史 Session 固定引用；如果需要多团队权限或多个 Host 共享目录，再引入明确的 ownership 与数据库存储。不要通过直接覆盖 Preset 文件提前实现编辑，现有驻留挂载和冷恢复的语义会产生不一致。

实施顺序建议为 **T1 → T2 → T3 → T4 → T5**。先证实保存的 Prompt、Model、Tools 可以驱动真实 Loop，再把页面接上。这五项共同构成本次完整交付。
