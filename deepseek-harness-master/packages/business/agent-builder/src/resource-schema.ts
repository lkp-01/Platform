/** Validation shared by durable resource records and Agent references. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { mcpDescriptorSchema } from '@deepseek-ai/dsh-mcp-client'
import { memoryScopeSchema } from './memory-schema.ts'
import type { SharedResourceId, SharedResourceVersionId, ResourceSpec, ResourceManifest } from './resource-types.ts'

const resourceId = z.string().regex(/^shared-[a-f0-9]{32}$/).transform(value => brandString<SharedResourceId>(value))
const versionId = z.string().regex(/^rv-[a-f0-9]{32}$/).transform(value => brandString<SharedResourceVersionId>(value))
/** Path-safe opaque reference to a published resource version. */
export const resourceRefSchema = z.strictObject({ resourceId, versionId })
/** Bounded policy that makes one MemoryStore available to an Agent Version. */
export const memoryBindingSchema = resourceRefSchema.extend({
  readScopes: z.array(memoryScopeSchema).min(1).max(3),
  writeScopes: z.array(memoryScopeSchema).max(3),
  retrieval: z.strictObject({ enabled: z.boolean(), topK: z.number().int().min(1).max(10), minScore: z.number().min(-1).max(1) }),
  extraction: z.strictObject({ sessionSummary: z.boolean(), semanticFact: z.boolean() }),
}).superRefine((value, context) => {
  if (new Set(value.readScopes).size !== value.readScopes.length) context.addIssue({ code: 'custom', message: 'Memory read scopes must be unique' })
  if (new Set(value.writeScopes).size !== value.writeScopes.length) context.addIssue({ code: 'custom', message: 'Memory write scopes must be unique' })
  if (value.retrieval.enabled && value.readScopes.length === 0) context.addIssue({ code: 'custom', message: 'Memory retrieval requires a read scope' })
})

/** Only installed model routes, business operations and pure Skill instructions are accepted. */
export const resourceSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('model'), provider: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(200) }),
  z.strictObject({ kind: z.literal('tool'), operation: z.string().min(1).max(512),
    server: resourceRefSchema.optional(),
    parameters: z.record(z.string(), z.json()).optional(), descriptor: mcpDescriptorSchema.optional() })
    .refine(value => value.descriptor === undefined || (value.server !== undefined && value.descriptor.name === value.operation),
      'MCP description must match the bound operation'),
  z.strictObject({ kind: z.literal('skill'), content: z.string().trim().min(1).max(16000) }),
  z.strictObject({ kind: z.literal('mcp-server'), url: z.url().max(2000).refine((value) => {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  }, 'Use an HTTP endpoint without embedded credentials').optional(), credential: resourceRefSchema.optional(),
  transport: z.enum(['streamable-http', 'stdio']).optional(), launchProfile: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional() })
    .refine(value => value.transport === 'stdio' ? value.launchProfile !== undefined && value.url === undefined
      : value.url !== undefined && value.launchProfile === undefined, 'Choose an HTTP endpoint or an approved stdio profile'),
  z.strictObject({ kind: z.literal('credential'), alias: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }),
  z.strictObject({ kind: z.literal('memory-store'), adapter: z.literal('local') }),
  z.strictObject({ kind: z.literal('eval-dataset'), adapter: z.literal('local') }),
])
/** Editable resource fields, excluding server-owned identity and availability. */
export const resourceInputSchema = z.strictObject({ name: z.string().trim().min(1).max(100), description: z.string().max(2000),
  ownerTeamId: z.string().trim().min(1).max(100), spec: resourceSpecSchema })
/** Supported lifecycle transitions retain published history. */
export const resourceStatusSchema = z.enum(['active', 'deprecated', 'disabled', 'archived'])
/** Bounded model, tool and Skill selections for an Agent. */
export const agentResourcesSchema = z.strictObject({ model: resourceRefSchema,
  tools: z.array(resourceRefSchema), skills: z.array(resourceRefSchema).max(10),
  memoryStores: z.array(resourceRefSchema).max(10).optional(), memoryBindings: z.array(memoryBindingSchema).max(10).optional() })
/** Durable published configuration and its content digest. */
export const resourceVersionSchema = z.strictObject({ id: versionId, resourceId, versionNumber: z.number().int().positive(),
  spec: resourceSpecSchema, specHash: z.string(), createdAt: z.iso.datetime() })
const bindingSchema = resourceVersionSchema.extend({ name: z.string() })
/** Resolved MemoryStore configuration retained by an immutable Agent version. */
export const memoryManifestBindingSchema = bindingSchema.extend({
  readScopes: z.array(memoryScopeSchema).min(1).max(3),
  writeScopes: z.array(memoryScopeSchema).max(3),
  retrieval: z.strictObject({ enabled: z.boolean(), topK: z.number().int().min(1).max(10), minScore: z.number().min(-1).max(1) }),
  extraction: z.strictObject({ sessionSummary: z.boolean(), semanticFact: z.boolean() }),
})
/** Captured dependency contents for version-two Agent snapshots. */
export const resourceManifestSchema = z.strictObject({ model: bindingSchema, tools: z.array(bindingSchema),
  skills: z.array(bindingSchema), memoryStores: z.array(bindingSchema).optional(), memoryBindings: z.array(memoryManifestBindingSchema).optional() })
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
