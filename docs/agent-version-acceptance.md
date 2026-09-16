# Agent Version 验收记录

实施日期：2026-09-16。保留了工作区原有 Registry 改动，未提交 Git commit。

## 使用流程

在 Agents 中打开 Agent，编辑并保存草稿；进入 Versions，填写可选说明并“保存为新版本”。保存不会切换线上配置。选择 Deploy 后，在 Overview 或 Runs 提交任务。选择旧版本的 Roll back 可切回旧配置；已接受的 Run 继续使用原版本。Run 列表支持查看版本快照与原始执行记录。

## 已交付

- 不可变版本快照：Prompt、模型、工具、支持的模型参数和执行配置，附编号、来源 revision、配置哈希、时间和创建者。
- 单默认部署目标、部署历史、回滚；准备失败与存储写入失败不替换原部署。
- 保存、部署、运行的幂等请求；并发操作与草稿编辑、归档按 Agent 串行化。
- Run 在接受时绑定版本；复用 Harness Session 和 Agent Loop，将归因写入共享 `platform/run` 事件。重启后仍可查询历史版本和执行状态。
- 版本化会话禁止普通入口改模型、追加任务、fork 或切换配置；版本 Preset 禁止复制、删除和切换绕过。可取消执行。
- Web 版本列表、详情、部署与回滚、部署历史、任务提交、Run 列表及只读执行页，中英文文案。

## 验证

- 完整 `pnpm run build` 通过，包含 Host、Client 和 Web 构建。
- 最终定向后端回归 53 项通过：版本/Registry 存储、真实 Loader 与 Agent Loop、Preset 复制和 Remote 操作。
- 注入存储失败、并发保存、部署失败、归档竞争、重启读取、篡改产物拒绝等均有覆盖。
- 真实模型适配器测试将 Run A 停在 v2 执行中，回滚后启动 Run B，核对实际模型、Prompt、工具；A 保持 v2，B 使用 v1。
- 最终浏览器回归 3 个文件、5 项测试全部通过，涵盖版本保存、部署、任务、回滚、执行页、重启追溯，以及原有 Registry 和 Agent 创建。无外部模型调用，模型请求快照核对两个版本的真实请求。
- 生产代码及定向后端测试采用类型感知 lint；Web 测试采用仓库 staged lint 配置（与其他 Host scaffold E2E 一样排除在 Client tsconfig 外）。

扩展后端检查曾得到 947 通过、2 失败、1 跳过；两项失败均为 Windows 创建符号链接时 EPERM。扩展浏览器回归为 11 通过、1 失败，失败是原有 Preset authoring 快照的 Windows 路径分隔符差异。没有改写这些无关测试的断言。

全库 doc-sync 为 32 通过、2 失败：归档笔记校验假设 Harness 位于 Git 根目录，但本项目将其放在子目录；文档站测试因 Windows 符号链接 EPERM 失败。hygiene 为 14 通过、2 失败：NodeNext 检查未提供具体诊断；现有 ACP 测试的 `cordis.yml` 是未还原为符号链接的路径文本。新增界面国际化、目录生成、双语配对、依赖与文档检查均通过。详细结果保存在 `verification/agent-version-*-final.log`，未通过的门禁没有计为通过。

界面截图：[版本列表](verification/agent-version-versions.png)、[Run 列表](verification/agent-version-runs.png)。

## 首版边界

一个写入 Host、一个默认部署目标，沿用 shared-host 身份；不提供多租户 RBAC、多环境、branch/merge/diff 或 Eval 评分。一个 Run 对应一个任务与 Session，进程中断不自动重发任务。旧 Session 不伪造版本归属。

快照冻结受支持的业务配置，不冻结远程模型服务、工具实现、外部记忆或 Host 插件代码，因此不承诺确定性重放。版本历史按 Agent 聚合存储，未来多写入者或大量历史需要扩展存储设计。
