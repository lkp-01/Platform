# Platform Workspace 验收记录

日期：2026-09-17。基线：`f6b66c8`。范围：单 Host、现有 Platform Storage Domain、平台资源命名空间与执行隔离。

## 已交付

- `PlatformWorkspaces` 独立于 Harness 目录 Workspace，复用已有治理 Domain，持久化稳定 ID、名称、状态和创建时间。无登录 Demo 可创建并切换工作区，治理部署继续使用真实成员授权。
- Agent、Model、Tool、Skill、MCP Server、Credential、MemoryStore、Eval Dataset 都有工作区归属；Agent Version、Deployment 保留已有父子关系和归属校验。
- Tool → MCP Server → Credential 的跨区引用在创建、编辑、发布和执行时校验。Memory 与 Dataset 的读取和写入使用工作区、资源 ID、条目 key 联合定位。
- Run 从 Agent 固定 `platformWorkspaceId`，重试和恢复读取持久化 Run；Trace 读取核对权威 Run 的工作区、Agent、版本和 Session。原 Harness Agent Loop 保持不变。
- MemoryStore 已接入真实 Harness 工具调用；MCP 通过现有 SDK 的 Streamable HTTP 适配器调用，每次重新解析凭证并关闭连接，支持超时与取消。
- `/platform` 支持同名资源分区、MemoryStore 绑定、MCP 依赖选择、Memory/Dataset 条目读写；切换取消旧请求，刷新恢复当前选择。

## 启动无登录 Demo

在 `D:/developer/Platform/deepseek-harness-master/` 执行：

```powershell
pnpm dsh --profile web --patch ./packages/bundle/business-agents/cordis.patch.yml --patch ./packages/bundle/business-agents/workspace-demo.patch.yml --no-open
```

访问 `http://127.0.0.1:3000/platform`。实际 Agent 调用仍需要 Host 已配置的模型提供商。已有治理部署继续使用原治理 patch；`workspaceDemo` 与 `governanceFile` 不能同时启用。此次没有修改或启动用户现有运行 profile。

MCP Credential 资源仅保存 alias。Host 配置 `credentialBindings` 使用工作区 ID → alias → 既有 credential reference 映射，真实值由现有 credentials provider 提供；前端不能指定任意环境变量读取。MCP 默认操作时限为 60 秒。

## 持久化与兼容

沿用已有 Storage Domain backend，没有换数据库。原 `platform_governance` 工作区表复用，新增字段可选；新增 `platform_resource_data` Domain 存放本地条目。旧版本可选 `memoryStores` 字段不自动补入 hash 输入。旧 Agent、Version、Deployment、Run ID 与 hash 不重写。

Demo 初始化仅为显式配置的旧 Host workspaceId 建立目录记录，不猜测其他空间。启动校验未知空间、缺失父资源及错误引用并拒绝歧义。已有注册资源保留原身份；没有共享资源绑定的旧版本需要编辑、绑定并重新发布后才可在命名空间模式执行。历史裸 Preset 导入失败会在 catalog 的 importErrors 中显示，不能据此认为已完成导入。

本次是加字段与复用现有归属，不需要批量迁移或切换 SQLite。启用前停止原写入 Host，备份完整存储与配置；回退时停止新 Host，恢复完整备份及匹配配置。不得用旧版程序直接覆盖新写入数据。后续启用治理时，管理员配置可以显式接管 Demo namespace，保留原 ID 和创建时间；已治理工作区不会恢复被移除成员。

## 实测结果

以下命令均在 monorepo 根目录执行，结果记录于外层 `.business-runtime/workspace-*.log`。

| 检查 | 结果 |
|---|---|
| `pnpm exec vitest run packages/business/agent-builder/tests packages/bundle/business-agents/tests packages/mcp/mcp-client/tests/mcp-client.spec.ts` | 17 个文件、143 项通过 |
| `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/platform-workspace.e2e.ts apps/web/tests/workspace-governance.e2e.ts apps/web/tests/agent-run.e2e.ts apps/web/tests/shared-resources.e2e.ts` | 4 个文件、8 项通过；最后收紧旧入口后，Workspace 与 Governance 5 项再次通过 |
| `pnpm run build` | 完整构建通过；最后代码改动后 Host 构建再次通过 |
| Host / Client TypeScript、改动文件 Oxlint | 通过 |
| export JSDoc、Client UI i18n、package dependencies | 通过 |
| 配置目录、Cordis API 目录、持久化目录生成与检查 | 通过；持久化目录是 Session 事件目录，本次未改变事件格式 |
| `pnpm run verify-translation-pairing` | 823 对文档一致性通过 |
| `pnpm run doc-sync` | 31 项通过；当次配置目录过期已重新生成并独立复核，其余限制见下文 |
| `git diff --check` | 通过 |

重点行为覆盖：A/B 同名 Agent 和 Tool；Memory/Dataset 同 key 不串读写；缺失 scope 和未知空间拒绝；A 不能读取 B Agent 或绑定 B Tool；配置跨区依赖拒绝；直接注入错误持久化 MCP 依赖后，执行仍在凭证解析及外部调用前拒绝；凭证轮换下一次调用生效；停用依赖阻止后续调用；真实 Harness Memory 写入仅落在 A，Trace 固定 A；工作区重开保留身份；旧版本 hash 与部署保持不变；既有治理和 Runtime 恢复回归通过。

旧组合测试的“索引读取不扫描 Session”断言会观察到未完成的后台 Trace 投影。测试现先等待 Trace 投影，再观察索引读取；未改变 Runtime 或 Trace 的执行逻辑。

## 检查限制

- Harness 目录 Workspace 的 45 项中有 2 项因 Windows `symlink` 的 `EPERM` 失败。相同测试在原始提交的独立 worktree 上复现；未修改该模块或绕过测试。
- 文档站点测试有 1 项同样因文件符号链接权限失败。
- `verify-archived-agent-notes` 假设 monorepo 就是 Git 根目录；实际 Git 根目录在外层 Platform，导致读取 `HEAD:.agents/...` 失败。未改写归档清单或为本次功能扩大修复范围。
- `verify-cordis-config` 被既有 ACP 测试 profile 阻挡：其文件内容为符号链接目标文本，未成为 Windows 上真实链接；原始提交内容相同。新增 Demo 使用相同 Loader/WebServer 模式，并经真实 Loader 浏览器测试验证。

## 本期边界

交付的是已纳管资源的 **Platform-level resource namespace/isolation**。无登录 Demo 面向本机，任何使用者均可切换命名空间；多用户授权继续使用已有治理部署。MemoryStore 是本地有界文本存储；Eval Dataset 是条目存储与预览，没有向量检索、评分或版本比较引擎。MCP 当前支持 HTTP 与 JSON 结果展示，没有 stdio、连接池或专用多媒体展示。已发出的外部副作用无法撤回。

MCP 使用同一 SDK 的平台适配器，避免把凭证序列化进不可变 Preset；这替代了计划中的直接复用长期 mcp-client 配置。测试分别验证真实 HTTP SDK 调用和真实 Harness Memory 闭环，未声称访问真实生产 MCP 或模型服务。
