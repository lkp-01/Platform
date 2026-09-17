# Workspace / Governance 首版验收

日期：2026-09-17。适用范围：单公司、单写入 Host、多用户、多团队工作区。

## 已交付

- 独立凭证登录、服务端会话、退出/过期/账号停用/凭证轮换失效；角色由服务端当前成员记录决定。
- 工作区切换、成员添加/移除/角色修改、最后管理员保护、工作区改名/归档/恢复及治理记录。
- Agent、Model/Tool/Skill、版本、部署、Run 和 Trace 按工作区隔离；真实创建者和更新者可追溯。创建重试按工作区和用户区分。
- 管理员管理共享资源和成员；开发者创建、编辑、发布和部署 Agent；普通用户调用已部署 Agent，只查看自己的运行状态、输入和最终结果。开发者/管理员可查看所在工作区完整运行记录。
- 禁用资源、撤销成员和归档工作区会在后续排队启动、模型步骤、工具派发及恢复时重新校验，拒绝未授权执行。已经发出的外部调用无法撤回。
- 启动验证历史归属与引用，不重写既有 Agent ID、版本 hash 和部署；历史 shared-host 任务不会自动获得用户身份。
- 中英双语 `/platform` 页面支持 Agent、资源、版本、部署、运行和成员管理。切换工作区会取消旧请求，防止迟到响应混入新页面。

![成员与治理页面](verification/workspace-governance-members.png)

## 启用

初始化配置已经生成在 `D:/developer/Platform/.business-runtime/governance/`。该目录被 Git 忽略；凭证只在本地 `credentials.txt` 中，未写入代码或本验收记录。默认工作区为 Sales（ID 为兼容历史的 shared）、Operations、Finance；提供各工作区管理员及销售开发者、普通用户账号。后两者需要销售管理员在成员页面添加。

在 `D:/developer/Platform/deepseek-harness-master/` 执行：

```powershell
pnpm dsh --profile web --patch ./packages/bundle/business-agents/cordis.patch.yml --patch ../.business-runtime/governance/governance.patch.yml --no-open
```

启动后访问 `http://127.0.0.1:3000/platform`，使用对应用户的独立凭证登录。首次配置资源时由管理员点击“导入已安装资源”；实际运行仍使用原 Host 已配置的模型及凭证。

已有数据迁移前停止原写入 Host 并备份完整存储；配置必须包含旧 workspaceId。新模式不会自动为缺少显式共享资源引用的历史版本补配权限，重新编辑并发布后再运行。已有 profile 尚未被自动修改或启动。

创建另一套独立配置可执行：

```powershell
pnpm exec tsx scripts/provision-platform-governance.ts --out ../.business-runtime/governance-new
```

工具拒绝覆盖已有目录。需要远程访问时自行配置 HTTPS 反向代理和准确的 `publicOrigin`，首版配置默认只接受本地来源。

## 架构边界

治理模式只开放 `/platform` 及显式业务 API。原始 Harness RPC、Session、附件、文件、全局事件与 WebSocket 入口被统一拒绝。WebServer 的 `requireAccessPolicy` 在策略挂载前和卸载后拒绝所有流量。默认未配置治理的单用户行为保持兼容。

使用既有 Storage Domain、Registry、Shared Resources、Runtime 和 Harness hooks；没有第二套 Agent Loop。隔离是应用层资源/权限隔离，不是操作系统沙箱。插件和管理员预装的工具适配器属于可信部署代码。

治理审计和执行 Trace 分开：审计记录控制面变更，Trace 沿用 Runtime 事实。跨 Domain 的业务提交和审计追加不是原子事务，审计追加失败可能发生在业务提交之后，重试应复用原 token。

## 验证

以下命令在内层仓库执行：

| 检查 | 结果 |
|---|---|
| `pnpm exec vitest run packages/bundle/business-agents/tests packages/business/agent-builder/tests packages/host/webserver/tests/webserver.spec.ts` | 12 文件，73 测试通过 |
| `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-governance.e2e.ts apps/web/tests/agent-run.e2e.ts apps/web/tests/shared-resources.e2e.ts` | 3 文件，6 测试通过 |
| `pnpm exec tsc -b tsconfig.host.json --pretty false` | 通过 |
| `pnpm run typecheck:contracts-ready` | 通过 |
| Host 库构建和 AgentBuilder 更新打包 | 通过 |
| 新增和修改的治理源码、测试、初始化脚本定向 oxlint | 通过 |
| `pnpm run verify-export-jsdoc` | 通过 |

Web 测试使用真实 Loader/HTTP/浏览器和确定性模型，检查登录、跨区 404、越权 403、身份伪造、资源绑定、创建/编辑/部署/运行、结果裁剪、禁用资源及工作区切换。单测补充并发管理员修改、凭证轮换、重启成员不复活、历史数据保留和恢复时权限撤销。

## 明确边界

- 未实现企业 IAM、SSO/SCIM、自定义 RBAC、跨区共享、单资源 ACL、配额或多写入 Host。
- 一个用户在不同工作区可以有不同角色；首版每个用户只保留一个浏览器会话，新登录替换旧会话。

## 全仓检查限制与回归修复

- `pnpm run test:docs`：15 项通过，唯一失败是既有的归档基线路径检查。该脚本从 Git HEAD 读取 `.agents/notes/archived/manifest.json`，未处理内层仓库位于 `deepseek-harness-master/` 子目录的布局。未改动冻结归档。
- `pnpm run doc-sync`：首次 30/34 通过；本次导致的 Config/Persistence 目录已重新生成，单独复查均通过。另一个环境失败是文档站符号链接测试在 Windows 返回 `EPERM`；文档构建本身通过。
- 821 对中英配对检查通过。
- `verify-client-ui-i18n` 仍报告原 Shared Resources UI 的 6 个硬编码版本前缀 `v`，位于 ResourcePicker.tsx 和 SharedResources.tsx；未在本次治理任务中修改原页面。新门户所有界面文案由本地中英字典提供。
- 新增 Web 测试最初误入 Client TypeScript 项目，已归入 Host 并排除 Client；最终两者全量类型检查通过，排查产生的编译残留已移入被忽略的 `.business-runtime/` 目录。
- 扩大业务组合回归时补齐测试的真实 Session 持久化装配，并使直接测试 Controller 保持其原调用上下文。历史迁移测试去掉仅新格式存在的 runtime/policy；异步调度断言等待实际终态。
- 修复 Runtime 对最终索引写入错误的处理：先重新读取 Harness 执行事实，避免以存储错误替换已经发生的模型错误或完成结果。原组合用例验证这一行为。
