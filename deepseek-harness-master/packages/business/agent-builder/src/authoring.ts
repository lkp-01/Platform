/** Atomic, immutable Preset authoring on a single Host. */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { definitionId, parseDefinition, renderDefinition } from './definition.ts'
import type { AgentDefinition, StoredDefinition } from './types.ts'

/**
 * Publish a complete directory or return the matching prior submission.
 * @param root - Host-controlled managed Preset root.
 * @param value - validated definition with request token.
 * @returns committed definition; conflicting reuse fails.
 */
export async function publishDefinition(root: string, value: StoredDefinition): Promise<AgentDefinition> {
  const id = definitionId(value.requestToken)
  const target = join(root, id)
  const existing = async (): Promise<AgentDefinition | undefined> => {
    let contents: string
    try { contents = await readFile(join(target, 'agent.cordis.yml'), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!isDeepStrictEqual(parseDefinition(contents), value)) throw new Error('This submission token was already used for a different Agent')
    const { requestToken: _token, ...definition } = value
    return { ...definition, id, builtin: false }
  }
  const previous = await existing()
  if (previous !== undefined) return previous
  await mkdir(root, { recursive: true, mode: 0o700 })
  // Sibling staging directories cannot be discovered as Presets under root.
  const staging = await mkdtemp(`${root}.staging-`)
  try {
    await writeFile(join(staging, 'preset.yml'), JSON.stringify({ name: value.name }), { mode: 0o600 })
    await writeFile(join(staging, 'agent.cordis.yml'), renderDefinition(value), { mode: 0o600 })
    try { await rename(staging, target) }
    catch (error) {
      const raced = await existing()
      if (raced !== undefined) return raced
      throw error
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const published = await existing()
  if (published === undefined) throw new Error('Published Agent directory is no longer available')
  return published
}
