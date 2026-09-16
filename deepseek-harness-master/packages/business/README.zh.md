---
description: "共享 Harness Agent 的业务演示包。"
kind: "package-group"
---

# business/ — 业务演示

[English](README.md) | 中文

## 概述

使用本地业务工具演示共享同一 Harness 核心的不同 Agent。客服、数据和运营工具位于同一包的不同入口中。可选业务 bundle 将其组合为具名 Preset。外部系统不在本组范围内。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

本包提供分别限定作用域的工具入口。

| 包 | 职责 |
|---|---|
| [agent-builder](agent-builder/README.zh.md) | 通过表单创建可复用业务 Agent |
| [business-tools](business-tools/README.zh.md) | 知识、数据查询和模拟运营操作 |

<a id="related-documentation"></a>
## 相关文档

- [业务 bundle](../bundle/business-agents/README.zh.md) — 可运行的 Agent 定义。

- [工具子系统](../../docs/subsystems/tools.zh.md) — 共享工具执行。

<a id="dev-note"></a>
## 开发备注

无。
