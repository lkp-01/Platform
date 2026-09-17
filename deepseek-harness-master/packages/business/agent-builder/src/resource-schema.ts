/** Validation shared by durable resource records and Agent references. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SharedResourceId, SharedResourceVersionId, ResourceSpec, ResourceManifest } from './resource-types.ts'

/** Only installed model routes, business operations and pure Skill instructions are accepted. */
export const resourceSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('model'), provider: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(200) }),
  z.strictObject({ kind: z.literal('tool'), operation: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal('skill'), content: z.string().trim().min(1).max(16000) }),
])
/** Editable resource fields, excluding server-owned identity and availability. */
export const resourceInputSchema = z.strictObject({ name: z.string().trim().min(1).max(100), description: z.string().max(2000),
  ownerTeamId: z.string().trim().min(1).max(100), spec: resourceSpecSchema })
/** Supported lifecycle transitions retain published history. */
export const resourceStatusSchema = z.enum(['active', 'deprecated', 'disabled', 'archived'])
const resourceId = z.string().regex(/^shared-[a-f0-9]{32}$/).transform(value => brandString<SharedResourceId>(value))
const versionId = z.string().regex(/^rv-[a-f0-9]{32}$/).transform(value => brandString<SharedResourceVersionId>(value))
/** Path-safe opaque reference to a published resource version. */
export const resourceRefSchema = z.strictObject({ resourceId, versionId })
/** Bounded model, tool and Skill selections for an Agent. */
export const agentResourcesSchema = z.strictObject({ model: resourceRefSchema,
  tools: z.array(resourceRefSchema).max(11), skills: z.array(resourceRefSchema).max(10) })
/** Durable published configuration and its content digest. */
export const resourceVersionSchema = z.strictObject({ id: versionId, resourceId, versionNumber: z.number().int().positive(),
  spec: resourceSpecSchema, specHash: z.string(), createdAt: z.iso.datetime() })
const bindingSchema = resourceVersionSchema.extend({ name: z.string() })
/** Captured dependency contents for version-two Agent snapshots. */
export const resourceManifestSchema = z.strictObject({ model: bindingSchema, tools: z.array(bindingSchema),
  skills: z.array(bindingSchema) })
/** Durable directory row including publication retry receipts. */
export const resourceRecordSchema = resourceInputSchema.extend({ id: resourceId, workspaceId: z.string(), status: resourceStatusSchema,
  revision: z.number().int().positive(), versions: z.array(resourceVersionSchema), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  createdBy: z.string().optional(), updatedBy: z.string().optional(),
  creationFingerprint: z.string(), receipts: z.record(z.string(), z.object({ fingerprint: z.string(), versionId })) })

/** Hash schema-normalized public configuration, without credentials.
 * @param spec - published adapter input.
 * @returns stable content digest.
 */
export function resourceHash(spec: ResourceSpec): string { return createHash('sha256').update(JSON.stringify(resourceSpecSchema.parse(spec))).digest('hex') }

/** Compose pinned instruction Skills using the existing literal prompt limit.
 * @param prompt - authored role instructions.
 * @param resources - optional version-two resource manifest.
 * @returns complete literal instructions accepted by the Preset prompt plugin.
 */
export function resourcePrompt(prompt: string, resources?: ResourceManifest): string {
  const result = resources === undefined ? prompt : [prompt, ...resources.skills.map(skill =>
    skill.spec.kind === 'skill' ? `Shared Skill: ${skill.name} (v${skill.versionNumber})\n${skill.spec.content}` : '')].join('\n\n')
  return z.string().max(32000, 'Prompt and selected Skills exceed the 32000-character limit').parse(result)
}
