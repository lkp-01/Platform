# Trace 第一版验收记录

实施日期：2026-09-17。对应 [Trace 实施计划](plans/2026-09-17-trace.md)。本次未创建 Git commit，保留工作区原有 Run 改动。

## 使用入口

重启加载业务 Agent bundle 的 Host 后，打开 **Agents → Agent → Runs → Run details**。Run 原有状态、耗时、输入、结果及取消入口保持不变；下方新增 **Trace 执行时间线**。

顶部显示模型/工具调用次数、输入/输出/已记录 Token。时间线包含 Run 开始与结束、每次模型调用和结果、工具参数与结果、错误、已有模型重试及最终答案。展开事件可查看有界预览；长时间线按页加载。运行中自动刷新，Run 终态之后继续等待 Trace 投影结算。部分数据或读取失败提供刷新重试。

## 实现与边界

- 原始 Harness Session 与 Run 生命周期仍是事实来源，没有修改 Agent Loop 或新增执行循环。
- 模型起点由 `agent/assistant-stream` 通知采集，持久化到 `platform_run_traces`，关联 Run 和相邻 Session 序号；未添加新的 Session 格式事件。
- 存储按 Run 保存模型起点、版本化事件页及摘要。页面落盘后才发布摘要版本；重放重新计算统计，不重复累加。游标绑定 Run/版本，查询校验 workspace/Agent/Run 归属。
- 重启可读取已保存的 Trace；未完成投影恢复对账，历史缺少投影时首次访问重建。缺失真实模型起点、工具恢复结果和 Token 时如实显示未知/不完整。
- 模型耗时取观察到的开始至结算；工具耗时取调用到结果。Run 总耗时沿用生命周期，不能用并行调用耗时求和代替。
- usage 同时出现在 stream 和 message 时只计一次；重试按真实尝试计数，缓存输入计入完整输入，reasoning 不重复累加。只有充分的提供方用量才标记统计完整。
- 参数与结果以文本渲染，常见凭证字段掩码，预览默认限制 4000 个 Unicode 码点，可配置 `tracePreviewChars`。原始记录沿用 Session 现有访问范围；不承诺任意文本的全面脱敏。
- Trace 写入故障显示不可用/部分数据并记录日志，不覆盖 Run 的执行结果；关闭时先结算 Run，再排空 Trace 写入。

第一版为单 Host、单 Run 对应单 Session。源日志对账合并相关通知后进行完整折叠，普通查询直接读取已保存页面；尚未加入持久化增量游标优化，因此很长的活跃 Run 会有额外对账开销。没有跨 Session span 树、分布式 tracing、日志检索、自动保留策略或零丢失审计保证；进程骤停前未 flush 的事实仍可能缺失。

## 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 定向后端、Run、Trace、Token、工具统计和客户端回归 | 7 个文件、100 项通过 | [最终定向回归](verification/trace-focused-final.log) |
| 完整 Host / Client / Web 构建 | 通过；后续修改补做定向编译与打包 | [完整构建](verification/trace-build.log)、[Host 打包](verification/trace-host-bundle.log)、[Client 打包](verification/trace-client-bundle.log) |
| 最终 Host / Client 类型检查 | 通过 | [类型检查](verification/trace-typecheck-final.log) |
| Run Trace 与原 Agent Version 浏览器流程 | 2 个文件、2 项通过 | [浏览器验收](verification/trace-browser-final.log) |
| 最终 Host 产物复验 | 通过，包含 Host 重启后查询 | [最终产物验收](verification/trace-browser-final-host.log) |
| 定向源码、测试 lint | 通过 | [lint](verification/trace-lint-final.log) |
| API、配置、Session 持久化目录 | 通过 | [API](verification/trace-catalog-final.log)、[配置](verification/trace-config-final.log)、[持久化](verification/trace-persistence-final.log) |
| 导出 JSDoc、客户端国际化 | 通过 | [JSDoc](verification/trace-jsdoc.log)、[国际化](verification/trace-i18n.log) |
| 双语配对 | 818 组一致 | [配对](verification/trace-pairing-final.log) |
| 文档快速检查 | 除已有归档路径检查问题外通过 | [文档检查](verification/trace-docs-final.log) |

文档归档校验仍假设 Harness 位于 Git 根目录，本项目却放在子目录，读取 `HEAD:.agents/notes/archived/manifest.json` 失败。此问题与 Run 验收记录一致，未修改无关归档规则或把失败计为通过。

测试使用无密钥模型 fixture，未调用真实模型服务。浏览器场景执行“模型 → 工具 → 模型 → 最终答案”，核对 2 次模型调用、1 次工具调用、300 输入 Token、30 输出 Token，总计 330 Token，并验证刷新、失败、取消及 Host 重启。已查看截图确认统计布局、事件顺序和展开内容。

![Trace 时间线](verification/agent-trace-timeline.png)

## 主要实现位置

- [Trace 服务](../deepseek-harness-master/packages/business/agent-builder/src/platform-traces.ts)、[投影器](../deepseek-harness-master/packages/business/agent-builder/src/trace-projection.ts)、[存储 Schema](../deepseek-harness-master/packages/business/agent-builder/src/trace-schema.ts)。
- [Remote API](../deepseek-harness-master/packages/business/agent-builder/src/index.ts)、[时间线组件](../deepseek-harness-master/packages/client/ui-agent-preset/src/client/RunTrace.tsx)。
- [设计决策](../deepseek-harness-master/.agents/notes/implemented/architecture/2026-09-17-run-trace.zh.md)。
