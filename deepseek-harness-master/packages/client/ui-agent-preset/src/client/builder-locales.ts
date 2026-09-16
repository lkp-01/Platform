/** Business authoring interface copy. */
export const builderEn = {
  library: 'Agent library', intro: 'Build an agent around your task. Choose its instructions, model and tools.',
  create: 'Create Agent', creating: 'Creating…', name: 'Name', nameHint: 'e.g. Order support assistant',
  prompt: 'Prompt', promptHint: 'Describe the role, goal, rules and expected output.',
  model: 'Model', tools: 'Tools', toolsHint: 'Select only the tools this agent needs. Leave all unchecked for conversation only.',
  close: 'Close', back: 'Back to agents', blank: 'Start from scratch', template: 'Use as template', start: 'Start Chat',
  builtin: 'Built-in', custom: 'Custom', refresh: 'Refresh', loading: 'Loading…', simulated: 'Simulated write',
  noModels: 'No models available. Configure a model in Settings, then refresh.',
  created: 'Agent created. Start a chat whenever you are ready.', selected: 'selected',
  customer: 'Customer service', data: 'Data analysis', operations: 'Operations',
  requirements: 'Enter a name and prompt, then select an available model.',
  saved: 'Saved agents', zero: 'Conversation only', modelFailures: 'Some model providers could not be loaded.',
}
/** Keys shared by the two authoring dictionaries. */
export type BuilderKey = keyof typeof builderEn
/** Chinese authoring interface copy. */
export const builderZh: Record<BuilderKey, string> = {
  library: 'Agent 工作台', intro: '围绕业务任务创建 Agent，填写指令、选择模型与工具。',
  create: '创建 Agent', creating: '正在创建…', name: '名称', nameHint: '例如：订单售后助手',
  prompt: 'Prompt', promptHint: '描述角色、业务目标、规则和预期输出。',
  model: '模型', tools: '工具', toolsHint: '只选择任务需要的工具。不勾选任何工具时，仅进行对话。',
  close: '关闭', back: '返回 Agent 列表', blank: '从空白创建', template: '以此为模板', start: '开始对话',
  builtin: '内置', custom: '自定义', refresh: '刷新', loading: '正在加载…', simulated: '模拟写入',
  noModels: '暂无可用模型。请在设置中配置模型，然后刷新。',
  created: 'Agent 已创建，可以开始对话。', selected: '项已选择',
  customer: '客户服务', data: '数据分析', operations: '运营协作',
  requirements: '请填写名称与 Prompt，并选择一个可用模型。',
  saved: '已保存的 Agent', zero: '纯对话', modelFailures: '部分模型提供商未能加载。',
}
