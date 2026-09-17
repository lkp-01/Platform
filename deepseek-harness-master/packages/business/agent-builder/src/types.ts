import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Platform task attribution shared by execution history and evaluations. */
    'platform/run': { runId: string; agentId: string; agentVersionId: string; platformWorkspaceId: string; configHash: string; deploymentRevision: number }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'agent-registry/not-found': Record<string, never>
    'agent-registry/conflict': Record<string, never>
    'agent-registry/archived': Record<string, never>
    'agent-registry/owner-invalid': Record<string, never>
    'agent-registry/validation': Record<string, never>
    'agent-version/invalid': Record<string, never>
  }
}

/** Stable identity of a saved Agent definition. */
export type AgentDefinitionId = string & Branded<'AgentDefinitionId'>

/** Business-owned creation fields; model credentials stay on the Host. */
export interface AgentDefinitionInput {
  name: string
  prompt: string
  model: ModelSelection
  toolIds: string[]
}

/** One immutable definition projected from its Preset directory. */
export interface AgentDefinition extends AgentDefinitionInput {
  id: AgentDefinitionId
  builtin: boolean
}

/** Display metadata for a selectable business tool. */
export interface AgentToolChoice {
  id: string
  group: string
  description: string
  simulatedWrite: boolean
}

/** Authoring data without starting a Session or calling a model. */
export interface AgentBuilderCatalog {
  models: ModelCatalog
  tools: AgentToolChoice[]
  agents: AgentDefinition[]
}

/** Stored authoring request inside the fixed composition plugin. */
export interface StoredDefinition extends AgentDefinitionInput {
  requestToken: string
}

/** Stable platform identity, independent of a Harness Session or directory. */
export type RegistryAgentId = string & Branded<'RegistryAgentId'>

/** Editable resource fields; only the current draft is retained. */
export interface RegistryAgentInput extends AgentDefinitionInput {
  description: string
  ownerTeamId: string
  harnessId: 'deepseek-harness'
  tags: string[]
}

/** Durable platform resource; revision is an edit lock, not a published version. */
export interface RegistryAgent extends RegistryAgentInput {
  id: RegistryAgentId
  platformWorkspaceId: string
  lifecycle: 'active' | 'archived'
  revision: number
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  legacyPresetId: string | null
}

/** List projection deliberately excludes Prompt and complete tool configuration. */
export interface RegistryAgentSummary {
  id: RegistryAgentId
  name: string
  description: string
  ownerTeamId: string
  harnessId: 'deepseek-harness'
  lifecycle: 'active' | 'archived'
  model: ModelSelection
  toolCount: number
  updatedAt: string
}

/** Bounded resource query within the configured organization workspace. */
export interface RegistryQuery {
  workspaceId: string
  query?: string
  lifecycle?: 'active' | 'archived' | 'all'
  ownerTeamId?: string
  cursor?: string
  limit?: number
}

/** Resource page with an opaque next-page cursor. */
export interface RegistryPage {
  items: RegistryAgentSummary[]
  nextCursor: string | null
  total: number
}

/** Explicit shared-Host scope; this is not an authenticated team directory. */
export interface RegistryWorkspace {
  id: string
  name: string
  ownerTeamId: string
  ownerTeamName: string
  accessMode: 'shared-host'
}

/** Authoring choices and migration diagnostics, independent of execution history. */
export interface RegistryCatalog extends AgentBuilderCatalog {
  workspace: RegistryWorkspace
  importErrors: string[]
}

/** Immutable configuration identity, distinct from a Registry edit revision. */
export type AgentVersionId = string & Branded<'AgentVersionId'>
/** One accepted platform task, distinct from its Harness Session. */
export type PlatformRunId = string & Branded<'PlatformRunId'>

/** Frozen behavior supported by the first versioned composition format. */
export interface AgentSnapshot {
  harnessId: 'deepseek-harness'
  prompt: string
  model: ModelSelection
  toolIds: string[]
  executionConfig: {
    rendererVersion: 1
    includeRuntimeContext: false
    businessDate: string
    compaction: { thresholdChars: number; headChars: number; tailChars: number }
    modelParameters: { reasoningEffort: string | null; temperature: number | null; maxTokens: number | null; stop: string[] | null }
  }
}

/** Saved configuration; no update or deletion API is provided. */
export interface AgentVersion {
  id: AgentVersionId
  agentId: RegistryAgentId
  platformWorkspaceId: string
  versionNumber: number
  sourceRevision: number
  schemaVersion: 1
  snapshot: AgentSnapshot
  configHash: string
  changeNote: string
  createdBy: string
  createdAt: string
}

/** List metadata without Prompt or executable composition. */
export type AgentVersionSummary = Omit<AgentVersion, 'snapshot'> & { model: ModelSelection; toolCount: number }

/** One atomic activation, also retained in deployment history. */
export interface AgentDeployment {
  agentId: RegistryAgentId
  platformWorkspaceId: string
  target: 'default'
  versionId: AgentVersionId
  previousVersionId: AgentVersionId | null
  revision: number
  action: 'deploy' | 'rollback'
  updatedBy: string
  updatedAt: string
}

/** Platform task lifecycle, independent of individual LLM and tool calls. */
export type RunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'

/** Durable lifecycle fact shared by execution consumers. */
export interface RunLifecycleEvent {
  eventId: string
  runId: PlatformRunId
  agentId: RegistryAgentId
  agentVersionId: AgentVersionId
  sessionId: SessionId
  type: 'run.created' | 'run.started' | 'run.succeeded' | 'run.failed' | 'run.cancelled'
  occurredAt: string
}

/** Persisted task attribution, lifecycle and bounded output reference. */
export interface PlatformRun {
  id: PlatformRunId
  agentId: RegistryAgentId
  agentVersionId: AgentVersionId
  versionNumber: number
  platformWorkspaceId: string
  configHash: string
  deploymentRevision: number
  sessionId: SessionId
  createdAt: string
  createdBy: string
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  finishTimeSource: 'execution' | 'detected' | null
  cancelRequestedAt: string | null
  input: { prompt: string } | null
  result: { textPreview: string | null; sessionId: SessionId; finalMessageSeq: number | null } | null
  error: { code: string; message: string } | null
  events: RunLifecycleEvent[]
}

/** Bounded page shared by version, deployment and Run queries. */
export interface AgentHistoryPage<T> {
  items: T[]
  nextCursor: number | null
}
export type { TraceEventType, TraceEvent, TracePreview, TraceUsage, RunTrace, RunTracePage } from './trace-types.ts'
