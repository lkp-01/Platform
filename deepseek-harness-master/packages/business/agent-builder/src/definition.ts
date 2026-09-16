/** Restricted authoring schema and deterministic Preset serialization. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentDefinitionId, AgentToolChoice, StoredDefinition } from './types.ts'

/** Selectable tools; package names are chosen only by the Host. */
export const TOOL_CHOICES: AgentToolChoice[] = [
  { id: 'knowledge_search', group: 'customer-service', description: 'Search product knowledge and policies / 搜索产品知识与政策', simulatedWrite: false },
  { id: 'order_query', group: 'customer-service', description: 'Look up a demo order by ID / 按编号查询演示订单', simulatedWrite: false },
  { id: 'ticket_create', group: 'customer-service', description: 'Create a simulated ticket for a known order / 为已知订单创建模拟工单', simulatedWrite: true },
  { id: 'data_catalog', group: 'data-analysis', description: 'Discover sales data and field definitions / 查看销售数据及字段口径', simulatedWrite: false },
  { id: 'sql_query', group: 'data-analysis', description: 'Run read-only SQL on the sales dataset / 对销售数据执行只读 SQL', simulatedWrite: false },
  { id: 'dataset_read', group: 'data-analysis', description: 'Preview rows from the sales dataset / 预览销售数据', simulatedWrite: false },
  { id: 'data_analyze', group: 'data-analysis', description: 'Calculate sums, changes and rates / 计算合计、变化和比率', simulatedWrite: false },
  { id: 'project_query', group: 'operations', description: 'Query demo projects and owners / 查询演示项目与负责人', simulatedWrite: false },
  { id: 'calendar_query', group: 'operations', description: 'Query a known owner’s calendar / 查询已知负责人的日程', simulatedWrite: false },
  { id: 'task_create', group: 'operations', description: 'Create a simulated project task / 创建模拟项目任务', simulatedWrite: true },
  { id: 'message_send', group: 'operations', description: 'Record a simulated task notification / 记录模拟任务通知', simulatedWrite: true },
]

/** Wire and disk validation for immutable definitions. */
export const inputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  prompt: z.string().min(1).max(32000).refine(value => value.trim().length > 0, 'Prompt is required'),
  model: z.strictObject({ provider: z.string().min(1).max(200), model: z.string().min(1).max(200) }),
  toolIds: z.array(z.string()).max(11).refine(ids => new Set(ids).size === ids.length, 'Duplicate tools')
    .refine(ids => ids.every(id => TOOL_CHOICES.some(tool => tool.id === id)), 'Unknown tool'),
})

/** Persistent idempotency token, generated once per browser submission. */
export const tokenSchema = z.uuid()

/** Saved payload, also validated before the composition is mounted. */
export const storedSchema = inputSchema.extend({ requestToken: tokenSchema })

/**
 * Derive an opaque, path-safe identity from a validated submission token.
 * @param token - UUID from the submitted request.
 * @returns stable id across retries and Host restarts.
 */
export function definitionId(token: string): AgentDefinitionId {
  return brandString<AgentDefinitionId>(`agent-${createHash('sha256').update(tokenSchema.parse(token)).digest('hex').slice(0, 32)}`)
}

/**
 * Serialize data into a fixed plugin composition; JSON is a YAML subset.
 * @param value - validated definition and submission identity.
 * @returns composition text with no caller-owned plugin paths or expressions.
 */
export function renderDefinition(value: StoredDefinition): string {
  const groups = ['customer-service', 'data-analysis', 'operations']
  return JSON.stringify([
    { id: 'agent-definition', name: '@deepseek-ai/dsh-agent-builder/prompt', config: value },
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '{{platform_agent_prompt}}', includeRuntimeContext: false } },
    ...groups.flatMap((group) => {
      const enabledTools = value.toolIds.filter(id => TOOL_CHOICES.some(tool => tool.id === id && tool.group === group))
      return enabledTools.length === 0 ? [] : [{ id: `tools-${group}`, name: `@deepseek-ai/dsh-business-tools/${group}`,
        config: { enabledTools, ...(group === 'operations' ? { businessDate: '2026-09-15' } : {}) } }]
    }),
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true }, config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    ] },
  ], null, 2) + '\n'
}

/**
 * Read only the fixed authoring format, rejecting modified executable rows.
 * @param text - persisted composition text.
 * @returns validated saved fields.
 */
export function parseDefinition(text: string): StoredDefinition {
  const rows: unknown = JSON.parse(text)
  const [first] = z.tuple([z.looseObject({ config: z.unknown() })]).rest(z.unknown()).parse(rows)
  const value = storedSchema.parse(first.config)
  if (JSON.stringify(rows) !== JSON.stringify(JSON.parse(renderDefinition(value)))) throw new Error('Agent composition differs from its saved definition')
  return value
}
