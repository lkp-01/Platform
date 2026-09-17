/** Durable version validation, independent of today's model and tool catalog. */
import { resourceManifestSchema, resourcePrompt } from './resource-schema.ts'
import type { ResourceManifest } from './resource-types.ts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentSnapshot, AgentVersion, AgentVersionId, RegistryAgent, RegistryAgentId } from './types.ts'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Fixed composition inputs; credentials and external service state are excluded. */
export const snapshotSchema = z.strictObject({
  resources: resourceManifestSchema.optional(),
  harnessId: z.literal('deepseek-harness'), prompt: z.string().min(1).max(32000),
  model: z.strictObject({ provider: z.string().min(1), model: z.string().min(1) }),
  toolIds: z.array(z.string()),
  executionConfig: z.strictObject({
    rendererVersion: z.union([z.literal(1), z.literal(2)]), includeRuntimeContext: z.literal(false), businessDate: z.iso.date(),
    compaction: z.strictObject({ thresholdChars: z.number().int().positive(),
      headChars: z.number().int().nonnegative(), tailChars: z.number().int().nonnegative() }),
    modelParameters: z.strictObject({ reasoningEffort: z.string().nullable(), temperature: z.number().nullable(),
      maxTokens: z.number().int().positive().nullable(), stop: z.array(z.string()).nullable() }),
  }),
})

/** Persistent immutable row; historical tools need not remain in the catalog. */
export const versionSchema = z.strictObject({
  id: z.string().regex(/^version-[a-f0-9]{32}$/).transform(value => brandString<AgentVersionId>(value)),
  agentId: z.string().transform(value => brandString<RegistryAgentId>(value)), platformWorkspaceId: z.string(),
  versionNumber: z.number().int().positive(), sourceRevision: z.number().int().positive(),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  snapshot: snapshotSchema, configHash: z.string(), changeNote: z.string().max(2000), createdBy: z.string(), createdAt: z.iso.datetime(),
})

/** Capture every current composition default along with the draft.
 * @param draft - one detached Registry revision.
 * @param resolved - adapter-resolved model defaults, when available.
 * @param resources - resolved published dependency contents, when selected.
 * @returns canonical snapshot with the renderer matching its dependency format.
 */
export function captureSnapshot(draft: RegistryAgent, resolved?: LlmCallConfig | void, resources?: ResourceManifest): AgentSnapshot {
  resourcePrompt(draft.prompt, resources)
  return snapshotSchema.parse({ ...(resources === undefined ? {} : { resources }), harnessId: draft.harnessId,
    prompt: draft.prompt, model: draft.model, toolIds: [...draft.toolIds].sort(),
    executionConfig: { rendererVersion: resources === undefined ? 1 : 2, includeRuntimeContext: false, businessDate: '2026-09-15',
      compaction: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      modelParameters: { reasoningEffort: resolved?.reasoningEffort ?? null, temperature: resolved?.temperature ?? null,
        maxTokens: resolved?.maxTokens ?? null, stop: resolved?.stop ?? null } } })
}

/** Hash validated configuration in stable schema property order.
 * @param snapshot - saved behavior fields.
 * @returns SHA-256 digest without identity or credentials.
 */
export function snapshotHash(snapshot: AgentSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshotSchema.parse(snapshot))).digest('hex')
}

/** Reject corrupt saved configuration before preparing any execution.
 * @param version - durable version.
 */
export function verifyVersion(version: AgentVersion): void {
  if (snapshotHash(version.snapshot) !== version.configHash) throw new Error('Saved version integrity check failed')
}
