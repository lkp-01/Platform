import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { publishDefinition } from '../src/authoring.ts'
import { definitionId, inputSchema, parseDefinition, renderDefinition } from '../src/definition.ts'
import type { StoredDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const value = (): StoredDefinition => ({ name: '订单助手', prompt: '原文\n{{user}} !!js "quoted"', model: { provider: 'demo', model: 'one' }, toolIds: ['order_query', 'calendar_query'], requestToken: randomUUID() })

describe('immutable Agent authoring', () => {
  it('round trips arbitrary prompt text without composition interpolation', () => {
    const input = value()
    expect(parseDefinition(renderDefinition(input))).toEqual(input)
    expect(definitionId(input.requestToken)).toMatch(/^agent-[a-f0-9]{32}$/)
  })
  it('rejects unknown tools, extra settings and blank fields', () => {
    const { requestToken: _token, ...input } = value()
    expect(inputSchema.safeParse({ ...input, toolIds: ['shell'] }).success).toBe(false)
    expect(inputSchema.safeParse({ ...input, toolIds: ['order_query', 'order_query'] }).success).toBe(false)
    expect(inputSchema.safeParse({ ...input, permission: 'admin' }).success).toBe(false)
    expect(inputSchema.safeParse({ ...input, prompt: '  ' }).success).toBe(false)
    expect(inputSchema.safeParse({ ...input, toolIds: [] }).success).toBe(true)
  })
  it('rejects executable rows added to a saved composition', () => {
    const text = renderDefinition(value()).replace('@deepseek-ai/dsh-persona', 'untrusted-plugin')
    expect(() => parseDefinition(text)).toThrow('differs')
  })
  it('publishes once across concurrent writers, retries and disk rereads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-builder-authoring-'))
    roots.push(dir)
    const root = join(dir, 'managed')
    const input = value()
    const results = await Promise.all(Array.from({ length: 4 }, () => publishDefinition(root, input)))
    expect(new Set(results.map(result => result.id)).size).toBe(1)
    expect(await readdir(root)).toEqual([results[0]!.id])
    expect(await readdir(dir)).toEqual(['managed'])
    expect(parseDefinition(await readFile(join(root, results[0]!.id, 'agent.cordis.yml'), 'utf8'))).toEqual(input)
    expect(await publishDefinition(root, input)).toEqual(results[0])
    await expect(publishDefinition(root, { ...input, prompt: 'different' })).rejects.toThrow('different Agent')
    expect(await readdir(dir)).toEqual(['managed'])
  })
})
