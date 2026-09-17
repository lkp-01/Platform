# Shared Resources R1 验收记录

日期：2026-09-17。

## Demo 范围

按用户要求，不实现登录、RBAC、多团队身份验证或凭证管理平台。Owner 是展示元数据。共享资源管理使用独立 Storage Domain 和管理类，放在现有 AgentBuilder 包中；通过已有 Cordis、Typert Remote、Preset 和 Harness Agent Loop 执行。

## 已交付

- 侧栏「资源中心」支持 Model、Tool、Skill 注册、草稿编辑、发布不可变版本、查看历史配置、弃用、禁用、归档和恢复。
- 现有已配置模型与 11 个业务 Tool 幂等导入为已发布资源，不因重复打开目录而重置管理员修改。
- Agent 表单选择具体资源版本，保存时服务端从引用派生实际模型路由和工具 operation；资源页列出引用它的 Agent 草稿、历史版本和部署状态。
- 第二版 Agent 快照固定资源配置、内容和摘要；发布资源 v2 不会改变引用 v1 的 Agent。旧快照 hash/渲染保持兼容，旧草稿通过编辑保存获得资源引用。
- Skill 首版支持纯 Markdown 指令，固定版本内容与 Prompt 一起进入现有系统提示及 Session 记录。合计上限为 32,000 字符；不执行 Skill 脚本，也不自动读取用户目录。
- 部署、启动和后续受管模型/工具调用检查资源状态。禁用/归档阻止后续执行，但保留历史详情；已发出的远端调用不能被回溯撤销。
- Model 复用 Host 已有 provider/凭证，Tool 复用已接入业务能力；资源和 Agent 配置不接受密钥字段。

## 验证结果

所有命令从 `deepseek-harness-master/` 执行。

| 检查 | 结果 |
|---|---|
| `pnpm run build` | 通过，包含 Host/Client 构建和 Web 产物 |
| `pnpm exec tsc -b tsconfig.host.json tsconfig.client.json --pretty false` | 通过 |
| `pnpm exec vitest run packages/business/agent-builder/tests packages/bundle/business-agents/tests` | 7 文件、49 测试通过 |
| `pnpm exec vitest run packages/client/ui-agent-preset/tests` | 10 文件、168 测试通过 |
| `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/shared-resources.e2e.ts apps/web/tests/agent-version.e2e.ts apps/web/tests/agent-registry.e2e.ts apps/web/tests/agent-run.e2e.ts` | 4 文件、5 场景通过 |
| 修改的业务源码、UI 和测试的 oxlint | 通过 |
| Cordis、Client、Config、Persistence 和文档图谱目录检查 | 更新生成物后通过 |
| 导出 JSDoc 检查 | 通过 |
| 中英配对 | 对应文档已同步并更新记录 |

新增 Web 场景通过实际 Loader/Web 组合创建并发布 Skill，用表单创建 Agent，执行真实 Harness 工具循环中的 `order_query`，从 Trace 确认工具调用。发布 Skill v2 后模型仍收到 v1 内容；禁用后新 Run 为 FAILED 且未增加模型调用。模型可见工具列表和固定 Skill 内容保存为所属测试目录内的快照。

截图：[资源中心](verification/shared-resources-center.png)、[Agent 资源选择](verification/shared-resources-agent.png)。

## 文档全量检查的环境限制

已运行 `pnpm run doc-sync`。本功能造成的目录新鲜度和类型归属问题已修复并单独复查。两项全仓检查仍存在与功能无关的环境问题：

1. `verify-archived-agent-notes` 从 Git HEAD 读取 `.agents/notes/archived/manifest.json`，但本仓库位于上层仓库的 `deepseek-harness-master/` 子目录，基线路径解析失败。没有修改冻结的归档记录。
2. `scripts/project-doc-site.spec.ts` 的符号链接场景在当前 Windows 返回 `EPERM`。没有绕过或禁用测试。

## 后续范围

MCP Server、Knowledge Source、任意 API Adapter、按资源版本禁用、Skill 脚本/附件和按需加载尚未实现。资源版本保证平台配置可追溯，不保证远端模型权重、服务代码或实时数据完全可复现。
