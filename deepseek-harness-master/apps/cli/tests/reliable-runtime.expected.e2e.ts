/** Hard process loss, distinct from cooperative Host disposal. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const driver = join(repo, 'packages/business/agent-builder/tests/fixtures/runtime-process.ts')
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function spawn(root: string, mode: string) {
  return execa(process.execPath, ['--import', 'tsx/esm', driver, root, mode], { cwd: repo, reject: false,
    env: { TSX_TSCONFIG_PATH: join(repo, 'tsconfig.base.json') }, timeout: 30000, killSignal: 'SIGKILL' })
}

async function crash(root: string, mode: string): Promise<void> {
  const child = spawn(root, mode)
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
    if (output.includes(`RUNTIME {"phase":"${mode}"}`)) child.kill('SIGKILL')
  })
  const result = await child
  expect(result.stdout, result.stderr).toContain(`RUNTIME {"phase":"${mode}"}`)
  expect(result.exitCode).not.toBe(0)
}

async function resume(root: string, mode = 'resume') {
  const result = await spawn(root, mode)
  expect(result.exitCode, result.stderr).toBe(0)
  const line = result.stdout.split('\n').find(value => value.startsWith('RUNTIME '))
  return JSON.parse(line!.slice(8)) as { status: string; result: string; attempt: number }
}

describe('reliable runtime survives hard process termination', () => {
  it.each(['admitted', 'model'])('recovers after loss at %s without a new submission', async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-hard-crash-')); roots.push(root)
    await crash(root, phase)
    expect(await resume(root)).toMatchObject({ status: 'SUCCEEDED', result: 'Recovered task' })
  }, 60000)

  it('does not repeat an external mutation after losing its result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-hard-write-')); roots.push(root)
    await crash(root, 'tool')
    expect(await resume(root)).toMatchObject({ status: 'BLOCKED' })
    expect(await resume(root, 'resolve')).toMatchObject({ status: 'SUCCEEDED' })
    expect(await readFile(join(root, 'external-effects.txt'), 'utf8')).toBe('committed\n')
  }, 90000)

  it('executes a durably requested but undispatched write exactly once on recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-before-dispatch-')); roots.push(root)
    await crash(root, 'unstarted')
    expect(await resume(root)).toMatchObject({ status: 'SUCCEEDED' })
    expect(await readFile(join(root, 'external-effects.txt'), 'utf8')).toBe('committed\n')
  }, 60000)

  it('reconciles a durable final answer without another model request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-final-gap-')); roots.push(root)
    await crash(root, 'completion')
    expect(await resume(root)).toMatchObject({ status: 'SUCCEEDED', result: 'Recovered task' })
    expect(await readFile(join(root, 'model-requests.txt'), 'utf8')).toBe('request\n')
  }, 60000)
})
