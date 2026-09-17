# Run 第一版验收记录

实施日期：2026-09-17。对应 [Run 实施计划](plans/2026-09-16-run.md)。本次未创建 Git commit。

## 使用入口

重启加载业务 Agent bundle 的 Host 后，在 **Agents → Agent 详情 → Runs** 提交任务。每次任务固定当前部署版本，先获得 Run ID，再由现有 Harness 执行。列表可以按版本和状态筛选；**Run details / Run 详情** 打开可刷新链接 `#agents/<agentId>/runs/<runId>`。

详情展示 Agent、版本、发起者、创建/开始/结束时间、运行耗时、输入、最终结果或错误，以及只读版本和原始执行记录入口。待执行或运行中的任务可以取消；界面等待 Harness 确认停止后再显示 CANCELLED。

## 已交付

- 公开状态统一为 PENDING、RUNNING、SUCCEEDED、FAILED、CANCELLED。单次工具错误不会单独决定 Run 终态；以整个 Harness 任务的结束事实为准。
- Run 先落盘再准备版本与启动 Session；准备失败保留 FAILED 记录。相同 token 不重复执行，也不重新解析部署版本。
- Runtime 监听原始 Session 开始/结束事件，flush 后持久化生命周期、源事件序号、最终文本摘要与输出引用；无需客户端查询即可保存终态。
- 生命周期事件与状态在同一 Run 记录原子保存。列表读 Run 索引，不逐条扫描完整对话；LLM、工具和消息明细仍由 Harness Session 保存。
- 新增 runCancel 和执行页 Run 查询入口；待启动取消阻止提交，执行中取消保留请求意图，终态不被迟到取消覆盖。
- 旧版小写状态及 accepted 记录兼容读取并根据原 Session 对账；遗留未完成任务归为 FAILED / EXECUTION_INTERRUPTED，不自动重发。
- 中断检测时间与真实执行结束时间区分展示；缺失历史时间不伪造耗时。
- Run 列表、详情、直达链接、状态/版本筛选、有限轮询及中英文文案；终态停止轮询并冻结耗时。

## 实现落点

- [Platform Runtime](../deepseek-harness-master/packages/business/agent-builder/src/platform-runs.ts)：接收、启动、取消、对账与生命周期监听。
- [状态机](../deepseek-harness-master/packages/business/agent-builder/src/run-lifecycle.ts)及[兼容存储 Schema](../deepseek-harness-master/packages/business/agent-builder/src/run-schema.ts)。
- [Remote API](../deepseek-harness-master/packages/business/agent-builder/src/index.ts)与生成的 API 目录。
- [Run 列表](../deepseek-harness-master/packages/client/ui-agent-preset/src/client/AgentRuns.tsx)及[详情](../deepseek-harness-master/packages/client/ui-agent-preset/src/client/RunDetails.tsx)。

计划中的适配与存储用例保持在已有 PlatformRuns 内，仅提取 Schema 和纯状态机，避免新增只有单一调用方的包或接口。重要持久化、API 和取消测试放入现有真实 Loader 组合测试，复用其生产 Harness 装配。

## 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 完整 Host / Client / Web 构建 | 通过；最后 UI 路由调整另做定向编译与打包 | [完整构建](verification/run-build-final.log)、[UI 构建](verification/run-ui-build-final.log) |
| 最终定向后端与 UI 测试 | 14 个文件、201 项通过 | [定向回归](verification/run-focused-final.log) |
| 扩展 Session Controller 回归 | 941 通过、1 跳过、1 环境失败 | [扩展回归](verification/run-regression-clean.log) |
| Run 浏览器验收 | 通过；最终输出快照、刷新直达、取消确认、失败和筛选 | [Run 浏览器](verification/run-browser-final.log) |
| 原 Agent Version 浏览器流程 | 通过，包含部署/回滚及 Host 重启查询 | [Version 复验](verification/run-browser-recheck.log) |
| 原 Registry 浏览器流程 | 2 项通过 | [Registry 验收所在执行](verification/run-browser.log) |
| 变更源码与测试定向 lint | 通过 | [lint](verification/run-lint-final.log) |
| 文档快速检查 | 15 项通过、1 既有路径限制 | [文档检查](verification/run-docs-final.log) |
| 存储目录、客户端国际化、导出 JSDoc | 通过 | [存储目录](verification/run-check-1.log)、[国际化](verification/run-check-2.log)、[JSDoc](verification/run-check-3.log) |
| 最终类型检查、API/客户端目录、双语配对 | 通过，97 项生成产物与 817 组文档配对一致 | [类型](verification/run-types-final.log)、[API 目录](verification/run-catalog-check-final.log)、[客户端目录](verification/run-client-catalog-final.log)、[配对](verification/run-pairing-final.log) |

扩展测试唯一失败为 `media-references.host.spec.ts` 创建文件符号链接时报 Windows EPERM。文档唯一失败为归档校验假设 Harness 位于 Git 根目录，但本项目把它放在子目录；与既有验收记录中的限制一致。它们没有被计为通过，也没有为通过门禁而修改无关测试。

开发中的一次客户端编译因新 Web 测试未排除出客户端程序而生成了源码目录旁的产物；已补齐与同类测试一致的 exclude，将本次生成的未跟踪产物隔离到 `.business-runtime/run-build-residue-20260917`，随后重新通过定向回归。浏览器验收还修复了同一 Agent 内切换详情未触发重新读取的问题。所有测试均使用无密钥模型 fixture，没有调用真实模型服务。

页面截图：[成功详情](verification/agent-run-success.png)、[取消详情](verification/agent-run-cancelled.png)。已查看截图验证布局。

## 首版边界

单写入 Host、shared-host 身份、一个 Run 对应一次任务与一个 Session。未修改 Harness Agent Loop。没有增加自动 retry、checkpoint、resume、任务队列、分布式 worker、执行并发限额或完整身份权限系统。取消不能撤销已完成的工具副作用，也不能强制不协作工具立即停止。生命周期事件通过现有 Storage Domain 通知发布，不承诺跨进程可靠消息投递。
