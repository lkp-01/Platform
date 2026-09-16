import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'

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
