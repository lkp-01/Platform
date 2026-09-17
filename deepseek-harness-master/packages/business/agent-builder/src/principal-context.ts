/** Request-local identity captured only by the authenticated platform adapter. */
import { withWorkspace } from './workspace-context.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

/** A server-verified user and requested workspace; roles are always looked up live. */
export interface PlatformPrincipal { userId: string; workspaceId: string }
const principal = new AsyncLocalStorage<PlatformPrincipal>()

/** Execute a trusted request with isolated identity.
 * @param value - principal verified by the HTTP adapter.
 * @param action - request operation.
 * @returns the operation result.
 */
export function withPrincipal<T>(value: PlatformPrincipal, action: () => T): T { return withWorkspace(value.workspaceId,
  () => principal.run(value, action)) }

/** Read the current request identity.
 * @returns undefined for internal workers and single-user hosts.
 */
export function currentPrincipal(): PlatformPrincipal | undefined { return principal.getStore() }

/** Read audit attribution without assigning worker ownership to a human.
 * @returns authenticated actor or the legacy single-user identity.
 */
export function platformActor(): string { return principal.getStore()?.userId ?? 'shared-host' }
