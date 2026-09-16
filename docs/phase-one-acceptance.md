# 第一阶段 Agent Core：交付与验收

日期：2026-09-15。

## 结果

三个业务 Agent 已接入原有 Web 前端，并通过真实 DeepSeek 模型调用。每个 Agent 使用独立 Session、不同 Persona 和工具集，共享官方 Agent Loop、模型适配器、Session、工具调度和上下文管理。

`packages/core` 基线中的 158 个文件 SHA-256 全部保持一致。没有新增 Agent Loop，也没有修改 Core 实现。

## 启动

当前演示服务运行在本机端口 **3210**，已请求在 Codex 浏览器面板打开认证入口。

手动启动时，在 PowerShell 执行：

```powershell
cd D:\developer\Platform\deepseek-harness-master
$env:DSH_HOME = 'D:\developer\Platform\.business-runtime'
pnpm dsh --profile web --patch ./packages/bundle/business-agents/cordis.patch.yml --port 3210
```

若端口已被本次演示服务占用，使用已打开的页面，或将端口改为 3211。

密钥位于仓库根目录 `.env`，已经配置并通过真实调用验证；该文件被 Git 忽略。重启服务后才会重新读取文件。全新安装先执行 `pnpm install` 和 `pnpm run build`，本机使用 Node 24.12.0。

页面中先选择工作区，再从输入框旁的 Agent 菜单选择业务 Agent。选择会创建独立 Session，并保留工作区。`Start a new chat` 为当前 Agent 再建一个 Session；已有对话仍可从侧栏打开。

## 三个演示任务

| Agent | 实际工具 | 可直接粘贴的问题 | 验收结果 |
|---|---|---|---|
| Customer Service Agent | `knowledge_search`、`order_query`、`ticket_create` | 我的订单 O-1002 一直没发货，请查订单和延期政策，引用来源，并创建升级工单。直接执行模拟操作。 | 识别 9 月 12 日预计发货、演示日 9 月 15 日已延期 3 天；引用 `knowledge:shipping-delay`；创建 escalated 工单并说明是模拟操作。 |
| Data Agent | `data_catalog`、`sql_query`、`dataset_read`、`data_analyze` | 先看数据字典，分析 2026 年 8 月哪个产品收入下降最多，用数值分析工具计算变化；再分析退款率上涨。 | 产品 A 收入 100000 → 60000，下降 40000 / 40%；整体退款率 2% → 5%，上升 3 个百分点；区分事实与因果推测。 |
| Operations Agent | `project_query`、`calendar_query`、`task_create`、`message_send` | 查看延期项目和负责人明天的日历，创建明天到期的跟进任务，再发引用任务的模拟通知。 | 找到 P-101 与 Amy；读取 9 月 16 日日历；创建负责人匹配的任务；通知引用实际 taskId，并说明未向外部发送。 |

演示业务日期固定为 **2026-09-15 / Asia/Singapore**。销售数据只有 2026 年 7 月和 8 月。工单、任务与消息都是模拟记录，不会联系真实人员。

## 实现入口

- [业务定义与启动配置](../deepseek-harness-master/packages/bundle/business-agents/README.zh.md)
- [业务工具及能力边界](../deepseek-harness-master/packages/business/business-tools/README.zh.md)
- [架构决策](../deepseek-harness-master/.agents/notes/implemented/architecture/2026-09-15-business-agents-over-presets.zh.md)
- [原执行计划](plans/2026-09-15-phase-one-agent-core.md)

产品抽象映射：Agent Registry = 官方 `AgentPresets`；Agent Definition = Preset 目录；Factory = 原 Session 创建路径中的官方 AgentFactory。目录名是 id，`preset.yml` 保存名称与简介，`agent.cordis.yml` 组合 Persona 和工具插件。模型采用共同 Host 默认值，保留官方逐 Session 模型选择能力。

三个工具入口集中在一个业务工具包中，避免增加三套重复包结构。模拟写入由官方 `tool/result` 事件与 Session projection 保存和重建，不另建日志或全局可变业务数据库。只读 SQLite 子进程只运行固定程序，模型仅提供 SQL；超时或取消会终止进程并等待退出。它不执行 Shell 或任意 Python/JavaScript。

## 验收矩阵

| 编号 | 检查 | 结果与证据 |
|---|---|---|
| A01 | 启动、三个名称与描述、进入聊天 | 通过；真实 Web 启动及业务浏览器测试。 |
| A02 | 独立 Session、正确 Preset、共享 Core | 通过；浏览器创建请求断言、Loader 组合测试、Core 哈希核对。 |
| A03 | 对应 Persona、共同默认模型 | 通过；脚本模型请求断言及三类真实模型调用。 |
| A04 | 精确工具集合 | 通过；客服 3、Data 4、运营 4，无额外工具。 |
| A05 | 客服越权工具拒绝 | 通过；SQL、Shell、运营工具均不暴露，强制 dispatch 也被拒绝。 |
| A06 | 客服完整链路 | 通过；实际模型查订单、搜索知识、创建升级工单。 |
| A07 | Data 精确计算、多轮工具调用 | 通过；固定数据独立断言与实际模型结果一致。 |
| A08 | SQL 与资源边界 | 通过；写入、ATTACH、PRAGMA、扩展、多语句、路径越界拒绝；行数、字节、取消及真实同步查询超时测试通过。 |
| A09 | 运营多工具组合 | 通过；实际 taskId 被消息引用，负责人匹配，全部是 mock。 |
| A10 | 并发与隔离 | 通过；同一 Host 下两个客服与一个运营 Loop 交错执行，同一个幂等键生成各自记录；取消查询不影响其他查询。 |
| A11 | 快速选择、重复创建、创建失败 | 通过；controller 忙碌/重试测试及浏览器独立创建、工作区保留、可编辑输入框断言。 |
| A12 | 已开始 Session 身份与刷新 | 通过；原 Preset 浏览器回归，以及三个真实场景完成后刷新仍可看到原 Agent 与对话。 |
| A13 | 配置与输入错误 | 通过；未知 Preset、挂载拒绝、非法数据集、工具参数及不存在业务实体等定向测试。 |
| A14 | 模拟写入幂等 | 通过；同 Session 重复创建返回同记录，冲突参数拒绝，其他 Session 不共享记录。 |
| A15 | 第四个 Agent | 通过；测试只添加 Returns Agent 两份定义文件并复用客服工具，即可被发现并运行不同 Persona。 |
| A16 | 原功能回归 | 通过；原 Preset 浏览器 8 项，Session client 与选择器等相关回归通过。 |

这些检查不代表企业级租户授权、故障恢复或所有并发调度顺序的形式化保证。工具权限范围是当前配置的部署；不应在此演示部署动态挂载额外的 Host 全局高风险工具。

## 测试记录

| 检查 | 结果 |
|---|---|
| `pnpm run build` | 通过；[日志](verification/implementation-build-final.log) |
| TypeScript host / client 检查 | 通过；包含在完整构建及定向类型检查中 |
| 全仓库 lint + 最后改动的定向 lint | 通过；[全量](verification/implementation-lint-final.log)、[定向](verification/focused-lint-final.log) |
| 业务与相关回归测试 | **221 项通过 / 10 个文件**；[日志](verification/business-regression-final.log) |
| 业务选择器浏览器测试 | **1 项通过**；[日志](verification/business-browser-tests.log) |
| 原 Preset 浏览器测试 | **8 项通过**；[日志](verification/existing-preset-browser-tests.log) |
| 真实 DeepSeek 三场景及刷新 | **3 项通过**；[日志](verification/business-live-tests.log) |
| 子进程超时修复后的真实 Data 场景 | **1 项通过**；另两项未重复运行；[日志](verification/business-data-live-final.log) |
| Core 完整性 | **158 个基线文件未变**；[记录](verification/core-integrity.json) |
| 翻译一致性 | **812 对文档通过**；最后修改的文档对已重新登记 |
| `git diff --check`、工作区约束、包不变量 | 通过 |

本阶段采用官方 Loop 上的脚本模型来重复验证多步链路，并保存真实模型结果与浏览器截图。没有引入独立的生产 Replay/Evaluation 服务，也没有为这些场景新增官方录制型 `snapshot.yml` 目录。

真实结果记录：[客服](verification/customer-live.json)、[数据](verification/data-live.json)、[运营](verification/operations-live.json)。截图：[选择器](verification/business-agents-browser.png)、[客服](verification/customer-live.png)、[数据](verification/data-live.png)、[运营](verification/operations-live.png)。这些本地验证产物与运行目录已被 Git 忽略。

### 未通过的仓库通用门禁

没有把下列失败隐藏或计为通过；它们不是本阶段业务验收测试：

- Windows 当前不允许创建符号链接（独立探针返回 `EPERM`），导致 NodeNext 外部消费者检查和文档站点的链接越界测试无法完成；原 Preset discovery 基线中也存在同类失败。
- 归档 Agent Note 检查按 Git 根目录读取 `.agents/...`，但实际源码位于 Git 根目录下的 `deepseek-harness-master/`，导致读取基线失败。
- Cordis 全仓库配置校验在原有 `apps/cli/tests/profiles/acp/cordis.yml` 报告“root must be a Loader entry array”；该文件未修改。
- 文档同步最后一轮为 31 项通过、3 项失败，其中翻译一致性问题已修复并独立复验通过；剩余失败是上面的符号链接与 Git 目录布局问题。

详情：[文档同步](verification/business-doc-sync-final.log)、[hygiene](verification/business-hygiene.log)、[NodeNext](verification/node-next-final.log)。没有为消除这些输出而放宽校验规则。

## 新增 Agent 与重置演示

新增 Agent：在 `packages/bundle/business-agents/presets/` 下新建目录，提供 `preset.yml` 和 `agent.cordis.yml`，组合现有 Persona 与工具插件即可。新增真正不同的业务能力时，实现新工具插件；无需改 Agent Loop。第四个定义的可执行示例见组合测试中的 Returns Agent。

重置模拟写入：开始新 Session。它有自己的空记录集合，原 Session 仍保留历史。演示查询数据不被工具修改；编辑 JSON/CSV 后重启服务以重新载入数据。调整演示日期时同步更新 Persona 和运营工具的 `businessDate`。

本阶段不包含完整 RAG、RBAC、多租户、长期 Memory、Durable Runtime、真实 SaaS、多 Agent 协作或评估平台。
