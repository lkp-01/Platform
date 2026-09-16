# 自助创建 Agent：交付与验收

日期：2026-09-16。

## 已实现

- Agent 工作台显示三个原有业务 Agent 和用户创建的 Agent。
- 创建表单仅包含名称、Prompt、Model、Tools；支持不勾选工具。
- 三个原有 Agent 可直接运行，也可用作新 Agent 的模板。
- Create Agent 保存定义，Start Chat 按定义创建独立会话。
- 新会话使用保存的模型；模型不会覆盖 Host 默认设置，已有会话保留自己的模型选择。
- 运行时仅注册所选业务工具，并拒绝未选工具的执行请求。
- Prompt 中的 `{{customer}}` 等字面文本不会被二次模板展开。
- 原子发布和提交标识确保重复点击、并发提交、失败重试不会产生重复定义。
- 页面刷新与 Host 重启后仍可发现保存的定义。

## 使用

本地服务端口为 **3210**。打开认证页面，连接工作区，点击 **Agent 工作台 / Agent library**，再点击 **Create Agent**。填写配置并保存后，点击 **Start Chat** 开始对话。

手动启动：

```powershell
cd D:\developer\Platform\deepseek-harness-master
$env:DSH_HOME = 'D:\developer\Platform\.business-runtime'
pnpm dsh --profile web --patch ./packages/bundle/business-agents/cordis.patch.yml --port 3210
```

自建定义保存于 `.business-runtime/business-agents/`。创建后无需改源码或重启服务。密钥仍由平台已有模型配置提供，不放在 Agent 定义中。

## 架构与范围

新增业务层 `agent-builder` 服务，使用受限表单生成 Harness Preset。复用原有 Preset 发现、工具注册、Session Controller、模型配置及官方 Agent Loop。没有修改 Core，也没有新增执行循环。

本阶段为同一 Host 内共享 Agent 列表。模型来自已配置的 Provider，工具来自现有 11 个业务工具。演示写工具仍为模拟操作。未增加记忆、权限、部署、版本管理或任意自定义工具上传。已保存定义保持不可变，需要调整时用作模板创建新定义。

## 验证记录

- 完整构建：通过，见 [构建日志](verification/agent-builder-build-final.log)。
- 相关单元与集成回归：**207 项通过**，见 [回归日志](verification/agent-builder-regression.log)。
- 打包调整后的业务组合与创建持久化复验：**14 项通过**，见 [复验日志](verification/agent-builder-packaging-regression.log)。
- 新功能与原 Preset 选择器浏览器验证：**10 项通过**，覆盖创建、模板、刷新、模型与工具应用、Host 重启，见 [浏览器日志](verification/agent-builder-browser-final.log)。
- 真实 DeepSeek 验证：**2 项通过**，包括页面创建后查询订单与重启恢复，见 [日志](verification/agent-builder-live.log)及[脱离凭证的执行记录](verification/agent-builder-live.json)。
- 全仓库 lint 曾完整通过；最终改动定向 lint 见 [日志](verification/agent-builder-lint-final.log)。
- 双语文档：**814 对通过**，见 [翻译检查](verification/agent-builder-translations.log)。

仓库通用检查仍有已有环境问题：Windows 符号链接权限导致部分消费者和文档站点检查失败；归档 Note 检查遇到 Git 根目录与源码目录不同；原 ACP 测试配置未通过 Loader 数组校验。原 Preset 文件复制浏览器快照也有 Windows 路径分隔符差异。上述失败未计为通过，也没有修改基线校验来掩盖它们。

完整记录：[文档同步](verification/agent-builder-doc-sync-final.log)、[hygiene](verification/agent-builder-hygiene.log)。其中本次引入的包文件清单、README、图表与翻译问题已单独修复并复验。

页面截图：[创建表单](verification/agent-builder-form.png)、[Agent 列表](verification/agent-builder-library.png)。测试产物和本地运行目录均被 Git 忽略。
