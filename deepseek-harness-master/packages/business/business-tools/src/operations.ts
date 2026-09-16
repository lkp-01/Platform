/** Local project/calendar queries and simulated task/message writes. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRecord, isolateTools, jsonOutput, recordOutput, text } from './shared.ts'

export const name = 'business-operations'
export const inject = ['tools', 'sessionProjections']
/** Operations fixture, reference date and simulated-record limit. */
export interface Config { enabledTools?: ('project_query' | 'calendar_query' | 'task_create' | 'message_send')[]; fixturePath: string; businessDate: string; maxRecords: number }
export const Config: s<Config> = s.object({
  enabledTools: s.array(s.union(['project_query','calendar_query','task_create','message_send'] as const)).default(['project_query','calendar_query','task_create','message_send']),
  fixturePath: s.string().default(fileURLToPath(new URL('../fixtures/operations.json', import.meta.url))),
  businessDate: s.string().required(), maxRecords: s.number().min(1).max(1000).default(100),
})
const date = z.iso.date()
const fixtureSchema = z.object({
  owners: z.array(z.object({ id: z.string(), name: z.string() })),
  projects: z.array(z.object({
    id: z.string(), name: z.string(), ownerId: z.string(), dueDate: date, status: z.string(), progress: z.string(),
  })),
  calendar: z.array(z.object({ ownerId: z.string(), date, start: z.string(), end: z.string(), title: z.string() })),
})

/** Register operations tools without network integrations. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  date.parse(config.businessDate)
  const data = fixtureSchema.parse(JSON.parse(await readFile(config.fixturePath, 'utf8')))
  for (const project of data.projects) {
    if (!data.owners.some(owner => owner.id === project.ownerId)) throw new Error(`Unknown project owner: ${project.ownerId}`)
  }
  isolateTools(ctx)
  if (config.enabledTools === undefined || config.enabledTools.includes('project_query')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_query', description: 'List demo projects, owners and progress. overdueOnly selects unfinished projects due before businessDate.',
    parameters: { overdueOnly: { type: 'boolean', required: true } },
    output: jsonOutput, isConcurrencySafe: () => true,
    execute({ overdueOnly }, exec) {
      exec.signal.throwIfAborted()
      return Promise.resolve({ mock: true, businessDate: config.businessDate, timezone: 'Asia/Singapore', owners: data.owners,
        projects: data.projects.filter(project => !overdueOnly || (project.status !== 'completed' && project.dueDate < config.businessDate)) })
    },
  })), 'operations.projects')
  if (config.enabledTools === undefined || config.enabledTools.includes('calendar_query')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'calendar_query', description: 'List a demo owner’s scheduled events on a date. Times are Asia/Singapore. Empty events do not establish working hours.',
    parameters: { ownerId: { type: 'string', required: true }, date: { type: 'string', required: true } },
    output: jsonOutput, isConcurrencySafe: () => true,
    execute(args, exec) {
      exec.signal.throwIfAborted()
      date.parse(args.date)
      if (!data.owners.some(owner => owner.id === args.ownerId)) throw new Error('Unknown ownerId')
      return Promise.resolve({ mock: true, timezone: 'Asia/Singapore', events: data.calendar.filter(event => event.ownerId === args.ownerId && event.date === args.date) })
    },
  })), 'operations.calendar')
  if (config.enabledTools === undefined || config.enabledTools.includes('task_create')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_create', description: 'Create a simulated follow-up task for a project’s assigned owner. Preserve requestKey when retrying identical input.',
    parameters: {
      projectId: { type: 'string', required: true }, ownerId: { type: 'string', required: true },
      title: { type: 'string', required: true }, dueDate: { type: 'string', required: true }, requestKey: { type: 'string', required: true },
    }, output: recordOutput,
    execute(args, exec) {
      const project = data.projects.find(item => item.id === args.projectId)
      if (!project || project.ownerId !== args.ownerId) throw new Error('projectId and assigned ownerId must match')
      date.parse(args.dueDate)
      return Promise.resolve(createRecord(ctx, exec, 'task', args.requestKey, {
        projectId: args.projectId, ownerId: args.ownerId, title: text(args.title, 'title', 300), dueDate: args.dueDate, status: 'open',
      }, config.maxRecords))
    },
  })), 'operations.task')
  if (config.enabledTools === undefined || config.enabledTools.includes('message_send')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'message_send', description: 'Register a simulated notification for a task created in this session. This writes only a demo outbox; nothing is sent externally.',
    parameters: {
      ownerId: { type: 'string', required: true }, taskId: { type: 'string', required: true },
      message: { type: 'string', required: true }, requestKey: { type: 'string', required: true },
    }, output: recordOutput,
    execute(args, exec) {
      if (!exec.agent) throw new Error('A notification requires an owning session')
      const session = exec.agent.session
      const records = ctx.sessionProjections.stateOf(session, 'businessRecords')
      if (records === undefined) throw new Error('Business record projection must be mounted on the host')
      const task = records.find(item => item.id === args.taskId && item.kind === 'task' && item.sessionId === session.id)
      if (!task || typeof task.payload !== 'object' || task.payload === null || Array.isArray(task.payload)
        || task.payload.ownerId !== args.ownerId) throw new Error('taskId must belong to this session and ownerId')
      return Promise.resolve(createRecord(ctx, exec, 'message', args.requestKey, {
        ownerId: args.ownerId, taskId: args.taskId, message: text(args.message, 'message'), status: 'mock_sent',
      }, config.maxRecords))
    },
  })), 'operations.message')
}
