/** Workspace-owned MCP configuration and native Harness adapter preparation. */
import type { Context } from '@deepseek-ai/cordis'
import { discoverMcpServer, prepareMcpTools, type Config as McpConfig, type McpDescriptor, type McpSelection } from '@deepseek-ai/dsh-mcp-client'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { RegistryError } from './registry.ts'
import { SharedResources, toolOperation } from './shared-resources.ts'
import type { ResourceManifest, ResourceRef } from './resource-types.ts'

/** Operator-owned workspace-to-alias mapping. */
export type CredentialBindings = Record<string, Record<string, string>>
/** Host-approved stdio launch configuration; secret environment names never come from Agent input. */
export type McpLaunchProfile = {
  /** Executable approved by the Host operator. */
  command: string
  /** Fixed command arguments; never supplied by the Agent. */
  args: string[]
  /** Working directory for the isolated child process. */
  cwd: string
  /** Environment variable receiving the resolved credential when present. */
  credentialEnv?: string
}
/** Host launch profiles keyed first by workspace, then profile name. */
export type McpLaunchProfiles = Record<string, Record<string, McpLaunchProfile>>
/** Platform-owned adapter limits and secret references. */
export interface McpRuntimeOptions { timeoutMs: number; credentials: CredentialBindings; launchProfiles: McpLaunchProfiles }

function secretValues(config: McpConfig): string[] {
  return (config.transport === 'stdio' ? Object.values(config.env) : Object.values(config.headers).map(value => value.replace(/^Bearer /, '')))
    .filter(value => value.length > 0)
}
function containsSecret(value: unknown, secrets: Iterable<string>): boolean {
  const text = JSON.stringify(value)
  return [...secrets].some(secret => text.includes(JSON.stringify(secret).slice(1, -1)))
}

/** Resolve a credential only in its recorded workspace.
 * @param ctx - Host credential provider context.
 * @param resources - workspace-bound resource directory.
 * @param ref - pinned credential metadata.
 * @param bindings - operator-provisioned aliases.
 * @returns current secret for transient transport use.
 */
export async function resolveWorkspaceCredential(ctx: Context, resources: SharedResources, ref: ResourceRef,
  bindings: CredentialBindings): Promise<string> {
  const credential = resources.binding(ref, 'credential', true)
  if (credential.spec.kind !== 'credential') throw new RegistryError('conflict', 'Credential required')
  const workspace = Object.hasOwn(bindings, resources.workspaceId) ? bindings[resources.workspaceId] : undefined
  const alias = credential.spec.alias
  const reference = workspace !== undefined && Object.hasOwn(workspace, alias) ? workspace[alias] : undefined
  if (reference === undefined) throw new RegistryError('conflict', 'Credential alias is not provisioned in this workspace')
  const provider = ctx.get('credentials')
  if (provider === undefined) throw new RegistryError('conflict', 'Credential provider unavailable')
  const resolved = await provider.resolve(credentialRef(reference))
  resources.binding(ref, 'credential', true)
  if (resolved === undefined) throw new RegistryError('conflict', 'Credential unavailable')
  return resolved.value
}

/** Resolve a complete server dependency chain before opening a transport.
 * @param ctx - credential provider context.
 * @param resources - authoritative workspace directory.
 * @param ref - exact server version.
 * @param options - Host-managed connection policy.
 * @returns transient adapter configuration; never persist this object.
 */
export async function resolveMcpConfig(ctx: Context, resources: SharedResources, ref: ResourceRef,
  options: McpRuntimeOptions): Promise<McpConfig> {
  const server = resources.binding(ref, 'mcp-server', true)
  if (server.spec.kind !== 'mcp-server') throw new RegistryError('conflict', 'MCP Server required')
  const spec = server.spec
  const profiles = Object.hasOwn(options.launchProfiles, resources.workspaceId) ? options.launchProfiles[resources.workspaceId] : undefined
  const profile = spec.launchProfile !== undefined && profiles !== undefined && Object.hasOwn(profiles, spec.launchProfile)
    ? profiles[spec.launchProfile] : undefined
  if (spec.transport === 'stdio' && profile === undefined)
    throw new RegistryError('conflict', 'MCP launch profile unavailable in this workspace')
  const secret = spec.credential === undefined ? undefined
    : await resolveWorkspaceCredential(ctx, resources, spec.credential, options.credentials)
  resources.binding(ref, 'mcp-server', true)
  const base = { serverName: server.resourceId.slice(-32), toolCallTimeoutMs: options.timeoutMs,
    failOnStartupError: true, reconnect: { enabled: false } }
  if (spec.transport === 'stdio' && profile !== undefined) {
    if (secret !== undefined && profile.credentialEnv === undefined) throw new RegistryError('conflict', 'MCP credential environment is not configured')
    return { ...base, transport: 'stdio', command: profile.command, args: [...profile.args], cwd: profile.cwd,
      env: secret === undefined || profile.credentialEnv === undefined ? {} : { [profile.credentialEnv]: secret } }
  }
  if (spec.url === undefined) throw new RegistryError('conflict', 'MCP endpoint required')
  return { ...base, transport: 'streamable-http', url: spec.url, headers: secret === undefined ? {} : { Authorization: `Bearer ${secret}` } }
}

/** Discover via the Harness adapter without registering any tools.
 * @param ctx - Host context.
 * @param resources - selected workspace.
 * @param ref - exact server version.
 * @param options - Host connection policy.
 * @param signal - request cancellation.
 * @returns public tool descriptions after the transport closes.
 */
export async function discoverWorkspaceMcp(ctx: Context, resources: SharedResources, ref: ResourceRef,
  options: McpRuntimeOptions, signal: AbortSignal): Promise<McpDescriptor[]> {
  const config = await resolveMcpConfig(ctx, resources, ref, options)
  try {
    const tools = await discoverMcpServer(config, signal)
    if (containsSecret(tools, secretValues(config))) throw new Error('MCP description contains credentials')
    resources.binding(ref, 'mcp-server', true)
    return tools
  } catch { throw new RegistryError('conflict', 'MCP discovery failed; verify the server configuration') }
}

/** Validate all bindings and prepare only their native MCP definitions.
 * @param ctx - Host capability context.
 * @param resources - directory fixed to the Run workspace.
 * @param manifest - immutable version inputs.
 * @param options - Host connection policy.
 * @param signal - execution lifetime cancellation.
 * @returns native definitions with no additional tool execution pipeline.
 */
export async function prepareWorkspaceMcp(ctx: Context, resources: SharedResources, manifest: ResourceManifest,
  options: McpRuntimeOptions, signal: AbortSignal): Promise<ToolDefinition[]> {
  resources.assertAvailable(manifest)
  const groups = new Map<string, { ref: ResourceRef; tools: McpSelection[] }>()
  for (const tool of manifest.tools) {
    if (tool.spec.kind !== 'tool' || tool.spec.server === undefined) continue
    if (tool.spec.descriptor === undefined) throw new RegistryError('conflict', 'Discover MCP tools and publish a new Agent version before running')
    const ref = tool.spec.server
    const key = `${ref.resourceId}:${ref.versionId}`
    const group = groups.get(key) ?? { ref, tools: [] }
    group.tools.push({ ...tool.spec.descriptor, publicName: toolOperation(tool) })
    groups.set(key, group)
  }
  const definitions: ToolDefinition[] = []
  try {
    for (const group of groups.values()) {
      const secrets = new Set<string>()
      const resolve = async () => {
        resources.assertAvailable(manifest)
        const config = await resolveMcpConfig(ctx, resources, group.ref, options)
        for (const secret of secretValues(config)) secrets.add(secret)
        if (containsSecret(group.tools, secrets)) throw new Error('MCP description contains credentials')
        return config
      }
      const tools = await prepareMcpTools(ctx, group.tools, resolve, signal)
      definitions.push(...tools.map(tool => ({ ...tool, async execute(args, exec) {
        resources.assertAvailable(manifest)
        try {
          const result = await tool.execute(args, exec)
          if (containsSecret(result, secrets)) throw new Error('MCP result contains credentials')
          return result
        }
        catch { if (exec.signal.aborted) exec.signal.throwIfAborted(); throw new Error('Workspace MCP operation failed') }
      } } satisfies ToolDefinition)))
    }
    return definitions
  } catch { throw new RegistryError('conflict', 'MCP preparation failed; rediscover and verify the bound tools') }
}
