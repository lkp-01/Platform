import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BusinessRecord } from './index.ts'

/**
 * Bounded nonempty model input.
 * @param value - raw model input.
 * @param field - field name for validation errors.
 * @param limit - maximum character count.
 * @returns trimmed input.
 */
export function text(value: string, field: string, limit = 2000): string {
  const result = value.trim()
  if (result.length === 0 || result.length > limit) throw new Error(`${field} must contain 1–${limit} characters`)
  return result
}

/** Fixed JSON presentation shared by the business tools and generic Web cards. */
export const jsonOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/**
 * Return an idempotent simulated write; the loop commits it through tool/result.
 * @param ctx - tool registration scope.
 * @param exec - current tool execution.
 * @param kind - business record category.
 * @param requestKey - Session-local idempotency key.
 * @param payload - validated business fields.
 * @param maxRecords - per-Session record limit.
 * @returns an existing or proposed simulated record.
 */
export function createRecord(
  ctx: Context, exec: ToolExecution, kind: BusinessRecord['kind'],
  requestKey: string, payload: JsonValue, maxRecords: number,
): BusinessRecord {
  exec.signal.throwIfAborted()
  if (!exec.agent) throw new Error('A business write requires an owning session')
  const session = exec.agent.session
  const key = text(requestKey, 'requestKey', 120)
  const records = ctx.sessionProjections.stateOf(session, 'businessRecords')
  if (records === undefined) throw new Error('Business record projection must be mounted on the host')
  const existing = records.find(item => item.sessionId === session.id && item.kind === kind && item.requestKey === key)
  if (existing) {
    if (!isDeepStrictEqual(existing.payload, payload)) throw new Error('requestKey already used with different input')
    return existing
  }
  if (records.length >= maxRecords) throw new Error('Demo session record limit reached; start a new session')
  const suffix = createHash('sha256').update(`${session.id}\0${kind}\0${key}`).digest('hex').slice(0, 16)
  return { id: `${kind}-${suffix}`, kind, requestKey: key, sessionId: session.id, mock: true, payload }
}

/** Preserve the business record as committed result metadata. */
export const recordOutput = {
  ...jsonOutput,
  presentationMeta: (_args: unknown, value: JsonValue) => value,
}

/**
 * Mask current host tools without masking preset tools inherited by sessions.
 * @param ctx - preset registration scope.
 */
export function isolateTools(ctx: Context): void {
  const deny = ctx.tools.schemas().map(tool => tool.name)
  ctx.effect(() => ctx.tools.restrict({ deny }), 'business-tools.inherited-tools')
}
