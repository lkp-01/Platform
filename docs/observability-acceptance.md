# Agent Observability 验收记录

2026-09-17：当前单 Host 版本已实现，保留 Harness 原有 Agent Loop。

## 使用入口

- 平台 `/platform`：管理员进入「工作区运行总览」，查看 Agent 排行、依赖健康、失败分类、趋势、Token 与估算成本。
- Agent 详情：进入「运行分析」，按时间、最近 1000 次或版本对比，打开匹配 Run，再进入原始 Trace。
- Agent Registry：新增 Analytics 页签，通过现有 Remote API 查询同一套分析事实。
- 普通执行用户不能访问分析；团队开发者按 Agent 编辑权限访问；工作区整体数据仅对该工作区管理员开放。

## 已实现

LLM、Tool 尝试、错误、重试及人工介入复用 Trace/Runtime 生命周期。工具调用区分每次尝试和逻辑最终结果，派发前参数拒绝单独计数。运行指标包含成功率、取消、平均/P50/P95 耗时、Token、失败类型、重试、人工介入和缺失数据覆盖。

后台自动处理未打开过的 Run；每个 Run 的紧凑分析记录原子替换，失败可重试。普通查询不扫描原始会话。分页绑定筛选条件与投影版本，变化时要求重新读取，避免混用数据。分析故障不改变任务结果。关闭服务先停止执行，再排空分析和 Trace，最后关闭源存储。

版本对比描述运行表现；答案质量下降仍需要 Evaluation 数据，不能用运行成功率代替答案正确率。未采集的 usage、耗时、价格展示未知，不补零或猜测。

## 价格配置

agent-builder 的 `observabilityPricesFile` 指向运维维护的 JSON 数组；`observabilityRefreshMs` 默认 1000。下面是示例费率，不代表任何供应商实际价格：

```json
[
  {
    "id": "example-usd-v1",
    "provider": "example",
    "model": "demo",
    "currency": "USD",
    "effectiveFrom": "2026-09-01T00:00:00Z",
    "effectiveTo": null,
    "input": 1000000,
    "cacheRead": 100000,
    "cacheWrite": 1000000,
    "output": 2000000
  }
]
```

费率单位是每百万 Token 的整数微货币单位，例如 `1000000` 表示 USD 1/百万 Token。模型标识必须与实际路由匹配。成本依赖完整 usage 分类；缺失分类不推断为零。使用整数计算并保留币种、费率版本；不同币种不相加。费率版本持久化且不可覆盖，历史配置移除不会清除已应用的费率记录。

## 实施调整和边界

- 原计划多表 generation 简化为一条 Run 原子事实，减少部分写入问题；接口合并为汇总查询和匹配 Run 分页查询。
- 历史回填启动时幂等重扫，没有持久化扫描游标。当前事实保存在单 Host 存储并建立内存索引，未实现分布式聚合和保留周期清理。
- 单次时间窗最多 30 天，最近运行窗口最多 1000 次。长 Run 的底层 Trace 对账仍需完整读取源记录。
- 未添加通用 APM、外部监控平台、告警、自动修复或业务质量评分。

## 验证证据

- 完整构建通过：`verification/observability-build-final.log`。
- 15 个测试文件、82 项定向回归通过：`verification/observability-regression-final.log`。覆盖统计分母、缺失数据、重试去重、持久化故障、重启、价格版本、客户端筛选和游标刷新。
- 浏览器 3 个测试文件、6 项测试通过，覆盖版本对比、成本、角色与工作区隔离、权限撤销和 Trace 下钻：`verification/observability-browser-verified.log`；页面截图：`verification/observability-workspace.png`。
- 10000 Run / 100000 attempt 的内存聚合测试，热运行 P95 约 117ms：`verification/observability-performance.log`。该数字不代表完整 HTTP、回填或生产负载性能。
- API、配置和持久化目录生成检查通过；新增导出文档检查通过。
- 文档检查 15/16 通过；归档检查受现有仓库嵌套路径影响，无法读取 `HEAD:.agents/notes/archived/manifest.json`，实际路径位于 `deepseek-harness-master/` 下。记录于 `verification/observability-docs-final.log`。
- 全局国际化检查仍报告既有 ResourcePicker/SharedResources 中 6 处硬编码 `v`；本次分析页面采用中英文词典，未扩大修改这些文件。

工作区原有未提交改动已保留；本次没有创建提交或部署到外部环境。
