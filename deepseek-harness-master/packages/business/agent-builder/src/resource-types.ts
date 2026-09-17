/** Shared resource metadata and immutable execution inputs
    never contains credentials. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { McpDescriptor } from '@deepseek-ai/dsh-mcp-client/types'
import type { MemoryBindingPolicy } from './memory-types.ts'

/** Stable workspace-owned resource identity. */
export type SharedResourceId = string & Branded<'SharedResourceId'>
/** Identity of one immutable published resource configuration. */
export type SharedResourceVersionId = string & Branded<'SharedResourceVersionId'>
/** Mutable availability, independent of published configuration. */
export type ResourceStatus = 'active' | 'deprecated' | 'disabled' | 'archived'
/** Demo adapters support installed model routes, business operations and instruction skills. */
export type ResourceSpec =
  | { kind: 'model'
    provider: string
    model: string }
  | { kind: 'tool'
    operation: string
    server?: ResourceRef | undefined
    parameters?: Record<string, JsonValue> | undefined
    descriptor?: McpDescriptor | undefined }
  | { kind: 'skill'
    content: string }
  | { kind: 'mcp-server'
    url?: string | undefined
    transport?: 'streamable-http' | 'stdio' | undefined
    launchProfile?: string | undefined
    credential?: ResourceRef | undefined }
  | { kind: 'credential'
    alias: string }
  | { kind: 'memory-store'
    adapter: 'local' }
  | { kind: 'eval-dataset'
    adapter: 'local' }
/** Editable display metadata and typed adapter configuration. */
export interface ResourceInput {
  name: string
  description: string
  ownerTeamId: string
  spec: ResourceSpec
}
/** Published configuration retained for historical Agent bindings. */
export interface ResourceVersion {
  id: SharedResourceVersionId
  resourceId: SharedResourceId
  versionNumber: number
  spec: ResourceSpec
  specHash: string
  createdAt: string
}
/** Public resource draft, availability and publication history. */
export interface SharedResource extends ResourceInput {
  createdBy?: string | undefined
  updatedBy?: string | undefined
  id: SharedResourceId
  workspaceId: string
  status: ResourceStatus
  revision: number
  versions: ResourceVersion[]
  createdAt: string
  updatedAt: string
}
/** Exact resource-version reference
    never a floating latest alias. */
export interface ResourceRef { resourceId: SharedResourceId
  versionId: SharedResourceVersionId }
/** Immutable MemoryStore policy selected by an Agent draft. */
export interface MemoryBinding extends ResourceRef, MemoryBindingPolicy {}
/** Explicit capabilities selected by one Agent draft. */
export interface AgentResources {
  model: ResourceRef
  tools: ResourceRef[]
  skills: ResourceRef[]
  memoryStores?: ResourceRef[] | undefined
  memoryBindings?: MemoryBinding[] | undefined
}
/** Captured published contents make history readable even after a resource is disabled. */
export interface ResourceBinding extends ResourceVersion { name: string }
/** Pinned MemoryStore contents and the policy that selected it. */
export interface MemoryManifestBinding extends ResourceBinding, MemoryBindingPolicy {}
/** Published contents captured with an immutable Agent version. */
export interface ResourceManifest {
  model: ResourceBinding
  tools: ResourceBinding[]
  skills: ResourceBinding[]
  memoryStores?: ResourceBinding[] | undefined
  memoryBindings?: MemoryManifestBinding[] | undefined
}
/** Agent draft or saved version consuming a resource. */
export interface ResourceUsage {
  agentId: string
  agentName: string
  versionId: string | null
  versionNumber: number | null
  deployed: boolean
}
