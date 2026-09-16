/** Read-only execution record with cancellation for the current Harness task. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './AgentRegistry.module.css'

type Props = PropsRuntime<'conversation.composer'> & PropsLocale<'agentRegistry'> & { cancelRun: () => Promise<void> }

/** Replace task input and model selection on version-bound execution records.
 * @param props - framework Session state and scoped cancel callback.
 * @returns read-only explanation and active-task cancellation.
 */
export function VersionRunComposer({ t, useSession, cancelRun }: Props) {
  const running = useSession(state => state.running)
  const [error, setError] = useState<string | null>(null)
  return <div className={css.notice}><p>{t('runReadOnly')}</p>
    {running && <Button variant="outline" onClick={() => { void cancelRun().catch((failure: unknown) => { setError(String(failure)) }) }}>{t('cancelRun')}</Button>}
    {error !== null && <p role="alert">{error}</p>}</div>
}
