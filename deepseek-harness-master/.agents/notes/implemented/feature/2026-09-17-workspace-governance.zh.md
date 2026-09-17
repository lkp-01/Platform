# Agent Note: 围绕 Harness Runtime 的 Workspace 治理

Status: implemented

[English](2026-09-17-workspace-governance.md) | 中文

## 问题

共享 Host 的归属标签无法区分经过认证的协作者，文件系统工作区也不能授权 Agent、资源或 Run 访问。通用 Host 界面还暴露了能够绕过业务权限检查的 Session 与管理路径。

## 决策

AgentBuilder 提供可选治理模式，使用运维预置身份、持久化工作区成员关系和三个固定角色。请求级身份提供审计归属，权限检查使用当前成员关系。已有 Registry、资源存储和 Runtime 保留自己的持久化域与执行职责。启动时检查既有引用，不改写不可变版本。工作区开发者共同维护全部 Agent，普通成员调用已部署 Agent 并查看自己的结果投影。

独立治理入口通过明确白名单调用同一组 AgentBuilder 用例。通用 WebServer 增加可选的部署访问策略，以及在策略挂载前和卸载后拒绝流量的必需策略设置。现有路由注册和 Connection 的 Host token 检查无法同时关闭所有 fallback、文件和升级路径并传递用户身份，这是扩展运输层的原因。Workspace 策略留在 WebServer 外，Agent Loop 保持不变。

治理入口禁用原生 Host 路径和 WebSocket 升级。请求依次验证来源、会话身份、成员关系、操作权限、资源范围和线上输入。用户凭证是独立生成的随机值；仅保存摘要和有期限的浏览器会话。登录替换同一用户已有的会话。用户停用和凭证轮换在配置重新加载后使会话失效。队列派发、模型步骤、工具和恢复检查当前 Run 权限，不改变原创建者，也不抹除未知的外部执行结果。

## 考虑过的替代方案

只过滤现有 UI 会留下可访问的原生 Session 和管理路径。为所有通用 Host 功能补充租户语义，会让首版超出 Workspace 和固定角色的范围。每个工作区独立进程或数据库可以提供更强的物理隔离，但会增加运维工作。治理入口明确限定访问范围，未启用治理时保留单用户 Host 界面。

## 影响

这是一套单写入进程上的应用层隔离，不是操作系统沙箱或企业 IAM。管理员使用已经安装的模型和业务工具适配器；注册工作区不会安装代码，也不会授权不受限制的文件访问。共享底层适配器仍由运维管理。已发出的远程调用无法收回。治理入口轮询已授权的 Run 查询，不转发全局事件。工作区初始化属于运维职责，成员和资源管理属于工作区职责。

成员变更及其审计条目在同一持久化工作区记录中提交。成功的业务变更随后追加治理审计；审计失败时业务变更可能已提交，因此客户端重试应保留原幂等 token。没有另建执行记录器。历史 shared-host 任务保留原身份，不能以任意管理员身份恢复。

## 验证

[治理测试](../../../../packages/business/agent-builder/tests/governance.spec.ts)覆盖凭证失效、角色隔离、初始成员移除、成员修订复用和并发保护最后一个管理员。[归属测试](../../../../packages/business/agent-builder/tests/workspace-isolation.spec.ts)在保留旧身份、hash 与部署的同时拒绝外区资源。[Runtime 测试](../../../../packages/business/agent-builder/tests/runtime-recovery.spec.ts)拒绝撤权后的恢复与外部重试。[WebServer 测试](../../../../packages/host/webserver/tests/webserver.spec.ts)通过真实 Loader 验证必需策略启动、升级拒绝与卸载。[浏览器测试](../../../../apps/web/tests/workspace-governance.e2e.ts)使用完整 Web 组合、独立用户凭证、真实 API 和浏览器角色流程，包括工作区切换与 Agent 创建。
