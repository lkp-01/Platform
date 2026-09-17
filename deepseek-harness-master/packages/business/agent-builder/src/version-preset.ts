/** Materialize immutable per-version compositions without reusing legacy Agent IDs. */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { renderDefinition } from './definition.ts'
import { verifyVersion } from './version-schema.ts'
import { resourcePrompt } from './resource-schema.ts'
import type { AgentVersion } from './types.ts'

/** Render legacy or resource-bound compositions exclusively from captured configuration.
 * @param version - immutable saved behavior.
 * @returns JSON/YAML composition with explicit frozen inputs.
 */
export function renderVersion(version: AgentVersion): string {
  verifyVersion(version)
  const { snapshot } = version
  const rows = z.array(z.looseObject({ id: z.string(), name: z.string(), config: z.unknown() })).parse(JSON.parse(renderDefinition({
    name: version.id, prompt: resourcePrompt(snapshot.prompt, snapshot.resources), model: snapshot.model, toolIds: snapshot.toolIds,
    requestToken: '00000000-0000-4000-8000-000000000000',
  })))
  for (const row of rows) {
    if (row.id === 'persona') row.config = { prefix: '{{platform_agent_prompt}}', includeRuntimeContext: snapshot.executionConfig.includeRuntimeContext }
    if (row.id === 'tools-operations') row.config = { enabledTools: snapshot.toolIds.filter(id => ['project_query', 'calendar_query', 'task_create', 'message_send'].includes(id)), businessDate: snapshot.executionConfig.businessDate }
    if (row.id === 'compaction') {
      const children = z.array(z.object({ id: z.string(), name: z.string(), config: z.unknown().optional() })).parse(row.config)
      for (const child of children) if (child.id === 'tool-result-pruner') child.config = snapshot.executionConfig.compaction
      row.config = children
    }
  }
  return JSON.stringify(rows, null, 2) + '\n'
}

/** Publish one complete version directory; existing bytes must match exactly.
 * @param root - Host-owned Preset root.
 * @param version - validated saved version.
 * @returns stable version Preset ID.
 */
export async function prepareVersionPreset(root: string, version: AgentVersion): Promise<string> {
  z.string().regex(/^version-[a-f0-9]{32}$/).parse(version.id)
  const contents = renderVersion(version)
  const target = join(root, version.id)
  const existing = async () => {
    let stored: string
    try { stored = await readFile(join(target, 'agent.cordis.yml'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    if (stored !== contents) throw new Error('Version execution artifact was modified or uses an incompatible renderer')
    return true
  }
  if (await existing()) return version.id
  await mkdir(root, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(`${root}.version-staging-`)
  try {
    await writeFile(join(staging, 'preset.yml'), JSON.stringify({ name: `${version.agentId} / v${version.versionNumber}` }), { mode: 0o600 })
    await writeFile(join(staging, 'agent.cordis.yml'), contents, { mode: 0o600 })
    try { await rename(staging, target) }
    catch (error) { if (!(await existing())) throw error }
  } finally { await rm(staging, { recursive: true, force: true }) }
  return version.id
}
