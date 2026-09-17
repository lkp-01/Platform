# Agent Note：不可变 Agent 版本与执行归因

Status: implemented

[English](2026-09-16-agent-version-execution.md) | 中文

## 问题

可变 Registry 草稿无法识别历史执行配置，也无法支持回滚。如果 Session 可以切换模型或在运行期间解析新部署配置，仅添加版本标签会误导用户。

## 决策

[创建包](../../../../packages/business/agent-builder/README.zh.md)包含独立的 Version、Deployment 和最小 Runtime 模块。版本记录捕获完整的受支持业务配置与来源修订号。按 Agent 串行提交将序号分配和重试凭据一起持久化。部署准备先校验并挂载不可变版本 Preset，再原子记录新默认版本和激活历史。回滚复用同一操作。

Run 接受流程在调用现有 Session Controller 与 Harness Loop 前固定版本并持久化身份。一个 Run 对应一个 Session 和一个已提交任务。Session 日志在原有执行事件旁保存 `platform/run` 归因；Runtime 根据持久化轮次结束事件保存生命周期摘要，不读取当前部署；查询读取这些摘要。进程丢失后不自动重发已接受请求。

Session API 授权在新组合发布、模型切换、提示词提交和 fork 前执行。Preset 授权在选择、Remote 复制和删除前执行。这些扩展点让平台无需修改 Agent Loop 或普通 Session 行为，即可强制受管执行不可变。作用域请求监听器提供已捕获模型参数。Web 输入区域使用现有链式扩展，将版本 Run 呈现为只读执行记录。

## 考虑过的替代方案

**可变执行路径**无法同时保留新旧配置。每个保存版本拥有独立 Preset 目录。

**仅在 Session 保存版本字段**不能表达任务接受、幂等性或启动失败。Runtime 单独保存这些任务事实，引用共享的 Session 事件历史。

**新增服务与事务数据库**在没有多写入方需求时增加部署成本。现有 Storage Domain 和按 Agent 串行控制支持当前单 Host 范围；聚合记录增长及多个写入方需要后续重新设计 repository。

## 影响

保存、激活和执行是独立动作。旧 Session 保持未关联版本。依赖不可用时历史快照仍可读取；激活失败不改变原部署。Host 提示词贡献、可执行插件实现、外部记忆和远程模型/工具服务不被此配置快照冻结。实际请求头与消息仍是执行证据。共享 Host 的 actor 和 workspace 不代表企业身份或租户授权。

## 测试

[存储测试](../../../../packages/business/agent-builder/tests/versions.spec.ts)覆盖并发、去重、重启、回滚与产物完整性。[Loader 集成](../../../../packages/bundle/business-agents/tests/composition.spec.ts)在回滚时保持一个 Run 运行，并断言两个版本的实际模型、Prompt 和工具。[Web 验收](../../../../apps/web/tests/agent-version.e2e.ts)覆盖用户流程、无密钥模型请求快照，以及 Host 重启后的冷读取 Run 归因。
