import { expect, it } from 'vitest'
import { currentPrincipal, platformActor, withPrincipal } from '../src/principal-context.ts'

it('keeps concurrent users and workspaces separate across awaited callbacks', async () => {
  const latch = Promise.withResolvers<undefined>()
  const first = withPrincipal({ userId: 'sales-user', workspaceId: 'sales' }, async () => {
    await latch.promise
    return currentPrincipal()
  })
  const second = withPrincipal({ userId: 'finance-user', workspaceId: 'finance' }, async () => {
    await Promise.resolve()
    latch.resolve(undefined)
    expect(platformActor()).toBe('finance-user')
    return currentPrincipal()
  })
  expect(await Promise.all([first, second])).toEqual([
    { userId: 'sales-user', workspaceId: 'sales' }, { userId: 'finance-user', workspaceId: 'finance' },
  ])
  expect(currentPrincipal()).toBeUndefined()
  expect(platformActor()).toBe('shared-host')
})
