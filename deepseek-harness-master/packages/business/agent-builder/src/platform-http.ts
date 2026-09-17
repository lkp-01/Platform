/** Governed HTTP portal with independent user sessions and no raw Harness routes. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { z, ZodError } from 'zod'
import type AgentBuilder from './index.ts'
import { Governance, GovernanceError } from './governance.ts'
import { platformDispatch } from './platform-api.ts'
import { platformPage, platformScript, platformStyle } from './platform-page.ts'

const COOKIE = 'platform_session'
const requestSchema = z.strictObject({ workspaceId: z.string().max(80), operation: z.string().max(80), args: z.array(z.unknown()).max(10) })
const allowedPaths = new Set(['/platform', '/platform/', '/platform/app.js', '/platform/style.css', '/platform/login', '/platform/logout', '/platform/api'])

function sessionToken(req: IncomingMessage): string {
  return (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ''
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new GovernanceError(403, 'JSON required')
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.byteLength
    if (size > 131072) throw new GovernanceError(403, 'Request too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value ?? null))
}

/** Mount a fail-closed deployment policy and the only publicly accessible platform routes.
 * @param ctx - platform plugin context with a required-policy WebServer.
 * @param builder - existing platform use cases.
 * @param governance - initialized membership and identity authority.
 */
export function mountPlatformHttp(ctx: Context, builder: AgentBuilder, governance: Governance): void {
  const server = ctx.get('webServer')
  if (server === undefined || !server.requiresAccessPolicy) throw new Error('Governance requires webServer.requireAccessPolicy=true')
  const origins = governance.config.publicOrigin === undefined
    ? [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`] : [governance.config.publicOrigin]
  ctx.effect(() => server.registerAccessPolicy((req, upgrade) => {
    if (!origins.some(origin => new URL(origin).host === req.headers.host)) return 403
    if (upgrade) return 403
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (!allowedPaths.has(path)) return 404
    if (req.method !== 'GET' && req.method !== 'POST') return 405
    // Browser cookies are accepted only on same-origin JSON writes; no forwarded identity headers.
    if (req.method === 'POST') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return 403
      const origin = req.headers.origin
      if (origin === undefined) return 403
      try { if (new URL(origin).host !== req.headers.host || !origins.includes(origin)) return 403 }
      catch { return 403 }
    }
    return undefined
  }), 'platform.http-policy')
  ctx.effect(() => server.register({ kind: 'prefix', path: '/platform', handler: async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    try {
      if (req.method === 'GET') {
        if (path === '/platform' || path === '/platform/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(platformPage); return }
        if (path === '/platform/app.js') { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(platformScript); return }
        if (path === '/platform/style.css') { res.setHeader('content-type', 'text/css; charset=utf-8'); res.end(platformStyle); return }
        send(res, 405, { error: 'POST required' }); return
      }
      const input = await body(req)
      if (path === '/platform/login') {
        const { token } = z.strictObject({ token: z.string().min(32).max(256) }).parse(input)
        const session = await governance.login(token)
        const secure = req.headers.origin?.startsWith('https://') === true ? '; Secure' : ''
        res.setHeader('set-cookie', `${COOKIE}=${session.token}; Path=/platform; HttpOnly; SameSite=Strict; Max-Age=${governance.config.sessionHours * 3600}${secure}`)
        send(res, 200, { expiresAt: session.expiresAt }); return
      }
      const token = sessionToken(req)
      const actor = governance.authenticate(token)
      if (actor === undefined) throw new GovernanceError(401, 'Authentication required')
      if (path === '/platform/logout') {
        z.strictObject({}).parse(input)
        await governance.logout(token)
        res.setHeader('set-cookie', `${COOKIE}=; Path=/platform; HttpOnly; SameSite=Strict; Max-Age=0`)
        send(res, 200, null); return
      }
      if (path !== '/platform/api') throw new GovernanceError(404, 'Operation not found')
      const request = requestSchema.parse(input)
      const result = await platformDispatch(builder, governance, actor, request.workspaceId, request.operation, request.args)
      send(res, 200, result)
    } catch (error) {
      if (error instanceof GovernanceError) { send(res, error.status, { error: error.message }); return }
      if (error instanceof ZodError || error instanceof SyntaxError) { send(res, 400, { error: 'Invalid request' }); return }
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (code.includes('not-found')) { send(res, 404, { error: 'Resource not found' }); return }
      if (code.includes('conflict') || code.includes('archived')) { send(res, 409, { error: 'Resource changed or unavailable; reload' }); return }
      if (code.includes('validation') || code.includes('owner-invalid')) { send(res, 400, { error: 'Invalid resource configuration' }); return }
      ctx.logger.warn('Platform request failed: %s', error instanceof Error ? error.message : String(error))
      send(res, 500, { error: 'Operation failed' })
    }
  } }), 'platform.http-route')
}
