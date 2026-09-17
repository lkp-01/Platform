import { SharedResourcesPanel, type ResourceActions } from './SharedResources.tsx'
/** Register the optional platform resource panel through existing layout slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AgentRegistryPanel, RegistryIcon, type RegistryActions } from './AgentRegistry.tsx'
import { registryEn, registryZh, type RegistryKey } from './registry-locales.ts'
import { VersionRunComposer } from './VersionRunComposer.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Resource management copy. */ agentRegistry: RegistryKey }
}

/** Mount Registry navigation only when its optional Host API is available.
 * @param ctx - client plugin scope; registrations dispose with it.
 */
export function mountRegistry(ctx: Context): void {
  ctx.inject(['layout', 'remote.agentBuilder', 'uiWorkspace'], (scope) => {
    let alive = true
    let mounted = false
    const canMount = () => alive && !mounted
    scope.effect(() => () => { alive = false }, 'agent-registry.availability')
    const enable = async () => {
      if (!canMount()) return
      const probe = await scope.remote.agentBuilder.registryCatalog().catch(() => undefined)
      if (probe?.ok !== true || !canMount()) return
      mounted = true
      const panelId = brandString<MainPanelId>('agents')
      const actions: RegistryActions = {
        observabilityQuery: async (...args) => {
          const result = await scope.remote.agentBuilder.observabilityQuery(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        observabilityRuns: async (...args) => {
          const result = await scope.remote.agentBuilder.observabilityRuns(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        versionCreate: async (...args) => {
          const result = await scope.remote.agentBuilder.versionCreate(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        versionList: async (...args) => {
          const result = await scope.remote.agentBuilder.versionList(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        versionGet: async (...args) => {
          const result = await scope.remote.agentBuilder.versionGet(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        deploymentGet: async (...args) => {
          const result = await scope.remote.agentBuilder.deploymentGet(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        deploymentHistory: async (...args) => {
          const result = await scope.remote.agentBuilder.deploymentHistory(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        deploymentActivate: async (...args) => {
          const result = await scope.remote.agentBuilder.deploymentActivate(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        runStart: async (...args) => {
          const result = await scope.remote.agentBuilder.runStart(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        runResolve: async (...args) => {
          const result = await scope.remote.agentBuilder.runResolve(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        runList: async (...args) => {
          const result = await scope.remote.agentBuilder.runList(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        runGet: async (...args) => {
          const result = await scope.remote.agentBuilder.runGet(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        runCancel: async (...args) => {
          const result = await scope.remote.agentBuilder.runCancel(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        runTraceEvents: async (workspace, id, runId, cursor, limit) => {
          const result = await scope.remote.agentBuilder.runTraceEvents(workspace, id, runId, cursor, limit)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        openRun: (run) => { scope.uiWorkspace.openSession(run.sessionId) },
        catalog: async () => {
          const result = await scope.remote.agentBuilder.registryCatalog()
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        list: async (query) => {
          const result = await scope.remote.agentBuilder.registryList(query)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        get: async (workspace, id) => {
          const result = await scope.remote.agentBuilder.registryGet(workspace, id)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        create: async (workspace, input, token) => {
          const result = await scope.remote.agentBuilder.registryCreate(workspace, input, token)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        update: async (workspace, id, revision, input) => {
          const result = await scope.remote.agentBuilder.registryUpdate(workspace, id, revision, input)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        archive: async (workspace, id, revision, archived) => {
          const result = await scope.remote.agentBuilder.registryArchive(workspace, id, revision, archived)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
      }
      const resourceActions: ResourceActions = {
        catalog: () => actions.catalog(),
        resourceList: async (...args) => {
          const result = await scope.remote.agentBuilder.resourceList(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        resourceCreate: async (...args) => {
          const result = await scope.remote.agentBuilder.resourceCreate(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        resourceUpdate: async (...args) => {
          const result = await scope.remote.agentBuilder.resourceUpdate(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        resourcePublish: async (...args) => {
          const result = await scope.remote.agentBuilder.resourcePublish(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        resourceStatus: async (...args) => {
          const result = await scope.remote.agentBuilder.resourceStatus(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        resourceUsage: async (...args) => {
          const result = await scope.remote.agentBuilder.resourceUsage(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        mcpDiscover: async (...args) => {
          const result = await scope.remote.agentBuilder.mcpDiscover(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        mcpImport: async (...args) => {
          const result = await scope.remote.agentBuilder.mcpImport(...args)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
      }
      scope.effect(() => scope.locale.register('agentRegistry', { en: registryEn, zh: registryZh }), 'agent-registry.locale')
      scope.slots.inject('conversation.composer', () => scope.slots.register({
        name: 'conversation.composer', priority: -20, locale: 'agentRegistry',
        select: owner => owner.sessionId?.startsWith('session-run-') ? { managed: true } : null,
        inject: sessionId => ({ cancelRun: async () => {
          const found = await scope.remote.agentBuilder.runForSession(sessionId)
          if (!found.ok) throw new Error(found.error.message)
          const run = found.value
          const result = await scope.remote.agentBuilder.runCancel(run.platformWorkspaceId, run.agentId, run.id)
          if (!result.ok) throw new Error(result.error.message)
        } }),
      }, VersionRunComposer))
      scope.slots.inject('main', () => {
        const dispose = scope.slots.register({ name: 'main', key: 'agents', locale: 'agentRegistry', inject: () => actions }, AgentRegistryPanel)
        const openLink = () => { if (/^#agents(?:\/|$)/.test(window.location.hash)) scope.layout.selectPanel(panelId) }
        window.addEventListener('hashchange', openLink)
        openLink()
        return () => { window.removeEventListener('hashchange', openLink); dispose() }
      })
      scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: 'resources', locale: 'agentRegistry', inject: () => resourceActions }, SharedResourcesPanel))
      scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: 'resources', order: -19,
        label: () => scope.locale.bind('agentRegistry')('resourcesTitle'),
      }, RegistryIcon))
      scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: 'agents', order: -20,
        label: () => scope.locale.bind('agentRegistry')('title'),
      }, RegistryIcon))
    }
    scope.on('connection/reset', () => { void enable() })
    void enable()
  })
}
