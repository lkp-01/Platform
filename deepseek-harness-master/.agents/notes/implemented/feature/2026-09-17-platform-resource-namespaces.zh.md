# Agent Note: 独立于认证的平台资源命名空间

Status: implemented

English | [中文](2026-09-17-platform-resource-namespaces.md)

## 问题

目录 Workspace 对本地项目和 Session 分组。平台资源需要独立的稳定身份，而且在没有用户登录时也必须约束引用解析。Tool 可以通过其服务或凭证依赖间接跨越这个边界。

## 决策

[PlatformWorkspaces](../../../../packages/business/agent-builder/src/platform-workspaces.ts) 持有已有治理 Domain，可选的 Governance 复用同一 owner。Demo 记录不伪造成员。运维显式初始化可为这些记录指定管理员，不改变 ID，也不恢复已移除的治理成员。请求级工作区 scope 与认证 principal 分离。Demo 和治理门户是互斥的部署模式，两者都要求现有的 WebServer 路由封闭策略。

资源目录将 MCP Server、MemoryStore、Eval Dataset 和凭证别名元数据与 Model、Tool、Skill 一起保存。不可变引用在配置阶段和执行阶段分别检查。Tool 到服务再到凭证的解析，在副作用发生前逐跳检查工作区归属。本地条目键包含工作区和资源身份。Run admission 复制 Agent 工作区，Trace 对照 Run 验证存储归属。既有字段名和版本 hash 保持不变。

Platform 在恢复和模型执行前准备已绑定工具，再把原生定义注册到 Agent scope。Schema 组装和调用分发都约束不可变选择。现有 `dsh-mcp-client` 负责传输、发现、Schema 转换和结果展示。发现操作导入包含完整描述的 Tool 草稿；发布固定该描述和服务版本。选择服务会展开为具体的已发布 Tool 引用。远端新增工具不扩大既有版本权限，所选工具描述改变则阻止执行。

凭证按操作解析。每个 Run/服务串行建立短连接，在发现或调用后关闭；取消也会中止准备过程。HTTP 和 Host 批准的 stdio 配置复用同一适配器。命令、工作目录和凭证环境变量名仅由 Host 指定。Platform 不实现另一套 Agent Loop 或 ToolRuntime。现有 Trace 事件增加 Tool 与 MCP 资源版本身份。

## 考虑过的替代方案

**复用目录 Workspace ID** 会混淆文件系统分组和业务归属，让目录成为平台资源的权限依据。

**仅在启用登录时检查命名空间** 会让 Demo 和内部调用绕过引用检查，因此范围检查先于可选的角色授权。

**在 AgentVersion Preset 中序列化带凭证的 mcp-client 配置** 会保存密钥，也无法逐操作更新凭证。平台将凭证解析到临时适配器配置。暂缓连接池：接受重复连接和发现的开销，以简化归属、轮换和清理。

## 影响

隔离位于单写入进程的应用层。命名空间 Demo 在本地运行且无认证，不能代替成员授权。模型路由仍是显式绑定的工作区资源，底层由 Host provider 提供。本地 Memory 和 Dataset 适配器保存有限条目，不实现向量检索或评测评分。旧的手工 MCP Tool 资源需重新发现并发布后才能执行。MCP 协议的 Resources 与 Prompts 不在本功能范围内。不可变配置不保证远端实现不变。

## 验证

[目录测试](../../../../packages/business/agent-builder/tests/platform-workspaces.spec.ts) 覆盖持久化、重试、并发 scope 和显式转入治理。[Runtime 适配器测试](../../../../packages/business/agent-builder/tests/workspace-runtime.spec.ts) 使用真实本地存储与 HTTP 传输，验证凭证轮换、跨区拒绝，以及存储错误引用被拒绝且不调用外区 provider。[浏览器测试](../../../../apps/web/tests/platform-workspace.e2e.ts) 启动真实 Loader，无登录创建和切换命名空间，通过 Harness 执行 Memory，并验证 Run/Trace 归属固定。原有治理、版本、恢复和目录 Workspace 测试继续承担回归验证。

[托管适配器测试](../../../../packages/mcp/mcp-client/tests/managed.spec.ts) 验证描述漂移、取消和凭证刷新。[MCP 浏览器验收](../../../../apps/web/tests/platform-mcp.e2e.ts) 验证 Workspace A/B 同时运行时的 Schema、外区调用拒绝、新增工具不扩权和 Trace 归属。适配器 stdio fixture 验证真实子进程调用；Redis 和 GitHub 浏览器场景使用本地 MCP 测试服务。
