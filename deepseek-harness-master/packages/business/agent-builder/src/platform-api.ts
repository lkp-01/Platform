/** Explicit public API allowlist; no raw Harness RPC or Session access is exposed. */
import { z } from 'zod'
import type AgentBuilder from './index.ts'
import { Governance, GovernanceError, type WorkspaceAction } from './governance.ts'
import { withWorkspace } from './workspace-context.ts'
import { withPrincipal } from './principal-context.ts'
import { registryInputSchema } from './registry.ts'
import { resourceInputSchema, resourceStatusSchema, resourceRefSchema } from './resource-schema.ts'
import { tokenSchema } from './definition.ts'
import { observationQuerySchema } from './observability-schema.ts'
import { memoryScopeSchema } from './memory-schema.ts'

const text = z.string().min(1).max(200)
const revision = z.number().int().nonnegative()
const actions: Record<string, WorkspaceAction> = {
  mcpDiscover: 'admin', mcpImport: 'admin',
  readResourceData: 'edit', putResourceData: 'admin', catalog: 'edit', agents: 'read', agent: 'edit', createAgent: 'edit', updateAgent: 'edit', archiveAgent: 'edit',
  versions: 'edit', version: 'edit', saveVersion: 'edit', deployment: 'read', deployments: 'edit', deploy: 'edit',
  resources: 'edit', createResource: 'admin', updateResource: 'admin', publishResource: 'admin', resourceStatus: 'admin',
  resourceUsage: 'edit', seedResources: 'admin', start: 'run', runs: 'read', run: 'read', cancel: 'read', trace: 'edit',
  traceEvents: 'edit', resolve: 'admin',
  memoryListItems: 'edit', memoryGetItem: 'edit', memoryCreateItem: 'admin', memoryDeleteItem: 'admin',
  memoryMigrateLegacyItem: 'admin', memoryGetWriteback: 'read', memoryRetryWriteback: 'admin',
  observability: 'edit', observabilityRuns: 'edit',
}

/** Dispatch validated business requests under server-established identity.
 * @param builder - existing platform use cases.
 * @param governance - membership authority.
 * @param actor - authenticated user ID, never decoded from request JSON.
 * @param workspace - target scope selected by the user.
 * @param operation - explicit platform operation.
 * @param args - wire values validated before calling trusted use cases.
 * @returns authorized result.
 */
export async function platformDispatch(builder: AgentBuilder, governance: Governance | undefined, actor: string, workspace: string,
  operation: string, args: unknown[]): Promise<unknown> {
  if (governance === undefined && operation === 'me') { z.tuple([]).parse(args); return { demo: true, user: { displayName: 'Demo' }, workspaces: builder.demoWorkspaces() } }
  if (governance === undefined && operation === 'createWorkspace') return builder.demoCreateWorkspace(...z.tuple([text, tokenSchema]).parse(args))
  if (governance === undefined && ['members', 'audit', 'member', 'workspace'].includes(operation)) throw new GovernanceError(404, 'Operation not found')
  if (governance !== undefined) {
    if (operation === 'me') { z.tuple([]).parse(args); return { user: governance.user(actor), workspaces: governance.list(actor) } }
    if (operation === 'members') { z.tuple([]).parse(args); return governance.members(actor, workspace) }
    if (operation === 'audit') { z.tuple([]).parse(args); return governance.audit(actor, workspace) }
    if (operation === 'member') {
      const [user, role, rev] = z.tuple([text, z.enum(['admin', 'developer', 'user']).nullable(), revision]).parse(args)
      return governance.setMember(actor, workspace, user, role, rev)
    }
    if (operation === 'workspace') {
      const [rev, name, status] = z.tuple([revision, text, z.enum(['active', 'archived'])]).parse(args)
      return governance.updateWorkspace(actor, workspace, rev, name, status)
    }
  }
  const action = Object.hasOwn(actions, operation) ? actions[operation] : undefined
  if (action === undefined) throw new GovernanceError(404, 'Operation not found')
  const dispatch = async () => {
    if (action === 'admin' && governance !== undefined && governance.workspace(workspace).status !== 'active') throw new GovernanceError(403, 'Workspace is archived')
    switch (operation) {
      case 'observability': return builder.observabilityQuery(workspace, ...z.tuple([observationQuerySchema]).parse(args))
      case 'observabilityRuns': return builder.observabilityRuns(workspace, ...z.tuple([observationQuerySchema, text.optional(), z.number().int().min(1).max(100).optional()]).parse(args))
      case 'readResourceData': return builder.readResourceData(...z.tuple([resourceRefSchema, z.enum(['memory-store', 'eval-dataset']), text]).parse(args))
      case 'putResourceData': return builder.putResourceData(...z.tuple([resourceRefSchema, z.enum(['memory-store', 'eval-dataset']), text, z.string().max(32000)]).parse(args))
      case 'catalog': z.tuple([]).parse(args); return builder.registryCatalog()
      case 'agents': {
        const [query] = z.tuple([z.strictObject({ query: z.string().max(200).optional(), cursor: text.optional(),
          lifecycle: z.enum(['active', 'archived', 'all']).optional(), limit: z.number().int().min(1).max(100).optional() })]).parse(args)
        return builder.registryList({ workspaceId: workspace,
          ...(query.query === undefined ? {} : { query: query.query }), ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.lifecycle === undefined ? {} : { lifecycle: query.lifecycle }),
          ...(query.limit === undefined ? {} : { limit: query.limit }) })
      }
      case 'agent': return builder.registryGet(workspace, ...z.tuple([text]).parse(args))
      case 'createAgent': return builder.registryCreate(workspace, ...z.tuple([registryInputSchema, tokenSchema]).parse(args))
      case 'updateAgent': return builder.registryUpdate(workspace, ...z.tuple([text, revision, registryInputSchema]).parse(args))
      case 'archiveAgent': return builder.registryArchive(workspace, ...z.tuple([text, revision, z.boolean()]).parse(args))
      case 'versions': return builder.versionList(workspace, ...z.tuple([text, revision]).parse(args))
      case 'version': return builder.versionGet(workspace, ...z.tuple([text, text]).parse(args))
      case 'saveVersion': return builder.versionCreate(workspace, ...z.tuple([text, revision, tokenSchema, z.string().max(2000)]).parse(args))
      case 'deployment': return builder.deploymentGet(workspace, ...z.tuple([text]).parse(args))
      case 'deployments': return builder.deploymentHistory(workspace, ...z.tuple([text, revision]).parse(args))
      case 'deploy': return builder.deploymentActivate(workspace, ...z.tuple([text, text, revision, tokenSchema, z.enum(['deploy', 'rollback'])]).parse(args))
      case 'resources': z.tuple([]).parse(args); return builder.resourceList()
      case 'mcpDiscover': return builder.mcpDiscover(...z.tuple([resourceRefSchema]).parse(args))
      case 'mcpImport': return builder.mcpImport(...z.tuple([resourceRefSchema, z.string().min(1).max(512), tokenSchema]).parse(args))
      case 'createResource': return builder.resourceCreate(...z.tuple([resourceInputSchema, tokenSchema]).parse(args))
      case 'updateResource': return builder.resourceUpdate(...z.tuple([text, revision, resourceInputSchema]).parse(args))
      case 'publishResource': return builder.resourcePublish(...z.tuple([text, revision, tokenSchema]).parse(args))
      case 'resourceStatus': return builder.resourceStatus(...z.tuple([text, revision, resourceStatusSchema]).parse(args))
      case 'resourceUsage': return builder.resourceUsage(...z.tuple([text]).parse(args))
      case 'memoryListItems': return builder.memoryListItems(...z.tuple([text, memoryScopeSchema, text.optional(),
        z.number().int().min(1).max(100).optional()]).parse(args))
      case 'memoryGetItem': return builder.memoryGetItem(...z.tuple([text, memoryScopeSchema, text.optional(), text]).parse(args))
      case 'memoryCreateItem': return builder.memoryCreateItem(...z.tuple([text, memoryScopeSchema, text.optional(),
        z.string().trim().min(1).max(32000), z.string().trim().min(1).max(1000), z.string().min(1).max(160)]).parse(args))
      case 'memoryDeleteItem': return builder.memoryDeleteItem(...z.tuple([text, memoryScopeSchema, text.optional(), text,
        z.number().int().positive(), z.string().trim().min(1).max(1000)]).parse(args))
      case 'memoryMigrateLegacyItem': return builder.memoryMigrateLegacyItem(...z.tuple([text, text, memoryScopeSchema,
        text.optional()]).parse(args))
      case 'memoryGetWriteback': return builder.memoryGetWriteback(workspace, ...z.tuple([text, text]).parse(args))
      case 'memoryRetryWriteback': return builder.memoryRetryWriteback(workspace, ...z.tuple([text, text, text]).parse(args))
      case 'seedResources': z.tuple([]).parse(args); return builder.seedWorkspaceResources()
      case 'start': return builder.runStart(workspace, ...z.tuple([text, z.string().min(1).max(32000), tokenSchema,
        z.string().regex(/^conversation-[a-f0-9]{32}$/).optional()]).parse(args))
      case 'runs': return builder.runList(workspace, ...z.tuple([text, revision]).parse(args))
      case 'run': return builder.runGet(workspace, ...z.tuple([text, text]).parse(args))
      case 'cancel': return builder.runCancel(workspace, ...z.tuple([text, text]).parse(args))
      case 'trace': return builder.runTraceGet(workspace, ...z.tuple([text, text]).parse(args))
      case 'traceEvents': return builder.runTraceEvents(workspace, ...z.tuple([text, text, text.optional(), z.number().int().min(1).max(100).optional()]).parse(args))
      case 'resolve': return builder.runResolve(workspace, ...z.tuple([text, text, text, z.enum(['completed', 'not-executed']),
        z.string().min(1).max(4000), tokenSchema]).parse(args))
      default: throw new GovernanceError(404, 'Operation not found')
    }
  }
  if (governance === undefined) {
    builder.demoWorkspaces()
    return withWorkspace(workspace, dispatch)
  }
  return governance.perform(actor, workspace, action, () => withPrincipal({ userId: actor, workspaceId: workspace }, dispatch), ['mcpImport',
    'createAgent', 'updateAgent', 'archiveAgent', 'saveVersion', 'deploy', 'createResource', 'updateResource', 'publishResource',
    'resourceStatus', 'seedResources', 'resolve', 'memoryCreateItem', 'memoryDeleteItem', 'memoryMigrateLegacyItem',
    'memoryRetryWriteback'].includes(operation) ? operation : undefined, typeof args[0] === 'string' ? args[0] : undefined)
}
