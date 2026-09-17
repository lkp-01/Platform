/** Shared resource metadata and immutable execution inputs; never contains credentials. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable workspace-owned resource identity. */
export type SharedResourceId = string & Branded<'SharedResourceId'>
/** Identity of one immutable published resource configuration. */
export type SharedResourceVersionId = string & Branded<'SharedResourceVersionId'>
/** Mutable availability, independent of published configuration. */
export type ResourceStatus = 'active' | 'deprecated' | 'disabled' | 'archived'
/** Demo adapters support installed model routes, business operations and instruction skills. */
export type ResourceSpec =
  | { kind: 'model'; provider: string; model: string }
  | { kind: 'tool'; operation: string }
  | { kind: 'skill'; content: string }
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
/** Exact resource-version reference; never a floating latest alias. */
export interface ResourceRef { resourceId: SharedResourceId; versionId: SharedResourceVersionId }
/** Explicit capabilities selected by one Agent draft. */
export interface AgentResources { model: ResourceRef; tools: ResourceRef[]; skills: ResourceRef[] }
/** Captured published contents make history readable even after a resource is disabled. */
export interface ResourceBinding extends ResourceVersion { name: string }
/** Published contents captured with an immutable Agent version. */
export interface ResourceManifest { model: ResourceBinding; tools: ResourceBinding[]; skills: ResourceBinding[] }
/** Agent draft or saved version consuming a resource. */
export interface ResourceUsage {
  agentId: string
  agentName: string
  versionId: string | null
  versionNumber: number | null
  deployed: boolean
}
