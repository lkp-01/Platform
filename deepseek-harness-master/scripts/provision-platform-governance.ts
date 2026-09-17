/** Generate a private operator bootstrap directory; never prints credentials. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { out: { type: 'string' }, port: { type: 'string', default: '3000' } } })
if (values.out === undefined) throw new Error('Provide --out <new-private-directory>')
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535')
const root = resolve(values.out)
// Exclusive directory creation prevents overwriting a deployed identity set.
await mkdir(root, { mode: 0o700 })
const accounts = ([
  ['sales-admin', 'Sales administrator'], ['sales-developer', 'Sales developer'], ['sales-user', 'Sales user'],
  ['operations-admin', 'Operations administrator'], ['finance-admin', 'Finance administrator'],
] as const).map(([id, displayName]) => ({ id, displayName, token: randomBytes(32).toString('base64url') }))
const configPath = join(root, 'governance.json')
await writeFile(configPath, JSON.stringify({
  users: accounts.map(({ token, ...user }) => ({ ...user, tokenHash: createHash('sha256').update(token).digest('hex') })),
  workspaces: [
    { id: 'shared', name: 'Sales', adminId: 'sales-admin' },
    { id: 'operations', name: 'Operations', adminId: 'operations-admin' },
    { id: 'finance', name: 'Finance', adminId: 'finance-admin' },
  ], sessionHours: 8,
}, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
await writeFile(join(root, 'credentials.txt'), accounts.map(user => `${user.id}\t${user.token}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
await writeFile(join(root, 'governance.patch.yml'), [
  '- id: webserver', '  config:', "    host: '127.0.0.1'", `    port: ${port}`, '    requireAccessPolicy: true',
  '- id: agent-builder', '  inject: [businessAgentPaths]', '  config:',
  '    root: !!js businessAgentPaths.managedRoot', `    governanceFile: ${JSON.stringify(configPath)}`, '',
].join('\n'), { mode: 0o600, flag: 'wx' })
console.log(`Created governance.json, governance.patch.yml and private credentials.txt in ${root}`)
