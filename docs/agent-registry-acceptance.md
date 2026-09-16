# Agent Registry 第一版交付记录

日期：2026-09-16。范围为 [实现计划](plans/2026-09-16-agent-registry.md) 的 R1 资源管理；R2 的 Version、Runtime、Deployment 联通尚未实施。

## 已交付

- 侧栏 **Agents** 资源页面，支持列表、搜索、状态筛选、分页、创建和模板填充。
- 独立详情链接 `#agents/<id>`，支持概览、配置草稿、编辑、归档与恢复。
- 名称、描述、组织空间、归属团队、Harness、模型、Prompt、Tools、标签、创建/更新时间与编辑修订号。
- 稳定资源 ID、跨重启持久化、创建重试去重，以及乐观锁编辑冲突。冲突保留浏览器中未保存的输入。
- 旧自定义 Preset 幂等导入；原创建接口也登记资源。内置三个 Agent 保留为模板。
- 草稿编辑不覆盖原 Preset；归档保留历史，阻止通过 Session Controller 新建该旧 Preset 的会话；已有会话仍可恢复。
- 版本、部署、Run 区域明确显示未接入，不生成虚假的版本号、部署状态或运行次数。

## 实现落点与计划调整

Registry 位于 [registry.ts](../deepseek-harness-master/packages/business/agent-builder/src/registry.ts)，资源接口由现有 [AgentBuilder](../deepseek-harness-master/packages/business/agent-builder/src/index.ts) 提供；UI 位于 [AgentRegistry.tsx](../deepseek-harness-master/packages/client/ui-agent-preset/src/client/AgentRegistry.tsx)。复用现有包、Remote 通道与布局插件，未新增独立 Registry/API/UI 包，避免重复装配和目录逻辑。

使用已有 Storage Domain 的 `platform_agent_registry`，继承部署的存储路由；当前基础配置为 JSON，而非强制新增 SQLite。已有 SQLite backend 仍可按 Domain 配置使用。运行目录与组织空间保持不同概念。

旧定义启动时执行非破坏性自动导入，错误在页面报告；未增加单独 dry-run 命令。原 YAML 保留不变，历史 Session 不迁移。

本阶段按单写入 Host 的共享空间交付。Workspace/Owner 来自 Host 配置，当前 actor 为 `shared-host`，导入 actor 为 `migration`。服务端拒绝其他 Workspace 和未知 Owner，但这不等于组织成员认证或多租户 RBAC。多实例写入、组织管理、完整权限、版本发布、部署与 Run 管理不属于本次实现。

新 **Agents** 页面创建的是资源草稿，暂不提供执行按钮。原 **Agent 工作台 / Agent library** 仍提供不可变 Preset 创建与对话入口；草稿编辑不会改变它运行的原配置。

## 验证结果

| 检查 | 结果 | 记录 |
|---|---|---|
| 完整构建（最终代码） | 通过 | [构建日志](verification/agent-registry-build-final.log) |
| Registry、原业务组合、原 Preset UI 回归 | 180 项通过 | [回归日志](verification/agent-registry-regression.log) |
| 最后一次创建 actor 调整后的存储复验 | 3 项通过 | [存储日志](verification/agent-registry-store-final.log) |
| 新 Registry 浏览器验收 | 2 个完整流程通过 | [浏览器日志](verification/agent-registry-browser-recheck.log) |
| 原创建与对话浏览器兼容 | 2 项通过 | [首次浏览器日志](verification/agent-registry-browser.log)，其中 Registry 当时失败项已由上行复验修复 |
| 变更源码与新增测试定向 lint | 通过 | [lint 日志](verification/agent-registry-lint.log) |
| 双语配对 | 815 对通过 | [双语日志](verification/agent-registry-translation.log) |

Web 测试使用真实 Loader / Host / 客户端组合与无密钥模型目录；资源 CRUD 未调用真实模型。已查看 [列表截图](verification/agent-registry-list.png) 和 [详情截图](verification/agent-registry-detail.png)。没有运行全仓库测试或真实模型评测。

文档同步共 34 项，首次 30 项通过。此次引入的客户端目录过期和双语锚点差异已修复并单独复验；剩余归档 Note 校验受嵌套 Git 根目录影响，文档站测试受 Windows 创建文件符号链接权限影响，均与之前验收记录中的环境限制一致，见 [文档检查日志](verification/agent-registry-doc-sync.log)。独立 NodeNext 消费者检查未通过且未输出详细诊断，见 [日志](verification/agent-registry-node-next.log)，不计为通过。

## 使用入口

加载业务 Agent bundle 的 Web Host 重启后，进入侧栏 **Agents**。创建后打开详情；复制详情链接可在同一 Host 上重新打开。默认组织空间为 `Shared workspace`，归属为 `Shared team`，页面明确提示共享访问范围。部署方可通过 AgentBuilder 的 `workspaceId`、`workspaceName`、`ownerTeamId`、`ownerTeamName` 配置更改显示与归属引用。
