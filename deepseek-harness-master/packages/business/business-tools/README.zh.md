---
description: "用于隔离业务 Agent 的本地知识、销售分析和模拟业务操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-business-tools

[English](README.md) | 中文

## 概述

根据本地政策回答客户问题，通过只读 SQLite 分析销售 CSV，并创建模拟运营记录。业务 Preset 仅选择需要的工具入口。返回记录明确标注为 mock 数据，不连接外部系统。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

使用现成的[业务 bundle](../../bundle/business-agents/README.zh.md)，它会挂载 Host 投影以及正确的工具入口。

在 Host 挂载一次 `@deepseek-ai/dsh-business-tools`。在各 Preset 内挂载对应子入口（`/customer-service`、`/data-analysis` 或 `/operations`）。不要在全局挂载三个工具入口。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabledTools` | 此插件的全部工具 | 仅注册所选工具；空数组不注册工具 |
| `fixturePath` | 包内资源 | 本地 JSON 或固定列 CSV |
| `maxResults` | 5 | 客服知识命中数量 |
| `maxRecords` | 100 | 每个 Session 的客服或运营记录上限 |
| `businessDate` | 必填 | 运营查询的参考日期 |
| `maxRows` | 100 | 数据结果行数上限 |
| `maxResultBytes` | 32768 | 完整数据结果字节上限 |
| `queryTimeoutMs` | 3000 | 查询 Worker 的截止时限 |

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

工具通过官方 `ctx.tools` effect 注册。SQL 子进程 使用 SQLite 授权、固定表、函数白名单、行数与字节限制、取消和终止机制。它不能附加数据库或执行写入。数值分析提供有界的求和、变化和比率运算。

模拟写入使用普通 `tool/result` 元数据。Session 投影从已提交事件重建业务记录。幂等键按 Session 与记录类型隔离，冲突复用会失败。不引入第二份持久化日志或 Agent Loop。

参见[源码](src/index.ts)、[查询 Worker](runtime/query.mjs)和[查询测试](tests/query.spec.ts)。本包不发布独立运行时不变量检查：工具与投影由注册表清理，每次查询结束都会等待子进程退出。

固定 Node 辅助进程通过 IPC 通信，使用官方清理后的环境变量，不暴露命令输入。超时或取消会终止进程并等待退出，因此能够停止同步原生 SQLite 查询。

</details>

<a id="model-experience"></a>
## 模型体验

### 作用域工具与结果

#### 模型看到什么

选定插件暴露工具名称、参数 Schema 和描述。`knowledge_search` 返回来源标识；`sql_query` 返回有界行数据与截断状态。模拟写入结果包括 `mock: true`、记录 id 和业务数据。结果使用原有 JSON 工具展示。

#### Token 影响

每份定义包含三至四个 Schema。查询与预览结果受限；其他结果取决于可信演示数据的大小。已提交结果留在会话历史中，直到原有上下文管理移除或压缩它们。

#### KV Cache 影响

工具 Schema 在 Session 内保持稳定。工具结果追加任务相关上下文，不重写先前消息；切换 Preset 会改变 Schema 前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

工具能力边界保持有限。

- 知识搜索匹配本地关键词，并非向量检索。接入真实 RAG 时替换工具插件。
- SQLite 需要 Node 24.12 或更高版本。CSV 使用固定表头，不支持带引号字段解析。分析仅提供命名数值操作，不执行任意代码。
- 隔离机制屏蔽 Preset 激活时继承的工具。此部署不要动态挂载额外全局工具；这不是多租户授权边界。
- 工单、任务和消息都是模拟数据，隔离于各自 Session，并从已提交工具结果派生。不提供外部发送或持久化跨系统事务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
