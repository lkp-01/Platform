/** Request-local namespace selection, independent of authenticated identity. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PlatformWorkspaceId } from './platform-workspaces.ts'
const scope = new AsyncLocalStorage<PlatformWorkspaceId>()
/** Select a syntactically valid scope; the resource owner still checks existence and authorization.
 * @param workspaceId - request namespace ID.
 * @param action - isolated operation.
 * @returns operation result.
 */
export function withWorkspace<T>(workspaceId: string, action: () => T): T {
  return scope.run(brandString<PlatformWorkspaceId>(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).parse(workspaceId)), action)
}
/** Read the operation's namespace, absent for background workers.
 * @returns request namespace if present.
 */
export function currentWorkspace(): PlatformWorkspaceId | undefined { return scope.getStore() }
