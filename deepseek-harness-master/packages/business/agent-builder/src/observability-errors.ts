/** Explicit adapter codes, never error-message substring guesses. */
import type { ErrorCategory } from './observability-types.ts'

/** Classify a recorded code without inferring causality from nearby failures.
 * @param code - original adapter or Runtime code.
 * @param origin - owner of the failed operation.
 * @returns stable, mutually exclusive category, including unknown.
 */
export function classifyError(code: string | null, origin: 'tool' | 'model' | 'runtime'): ErrorCategory {
  if (['ETIMEDOUT', 'TIMEOUT', 'TOOL_TIMEOUT', 'MODEL_TIMEOUT', 'REQUEST_TIMEOUT'].includes(code ?? '')) {
    return origin === 'tool' ? 'tool_timeout' : origin === 'model' ? 'model_timeout' : 'runtime_error'
  }
  if (['INVALID_ARGS', 'INVALID_PARAMS', 'INVALID_ARGUMENTS', 'TOOL_INVALID_ARGUMENTS', 'VALIDATION_ERROR'].includes(code ?? '')) return 'invalid_params'
  if (['429', 'RATE_LIMITED', 'RATE_LIMIT', 'RATE_LIMIT_EXCEEDED'].includes(code ?? '')) return 'rate_limited'
  if (['403', '401', 'PERMISSION_DENIED', 'AUTHORIZATION_REVOKED'].includes(code ?? '')) return 'permission_denied'
  if (['TOOL_ERROR', 'ECONNRESET', 'EAI_AGAIN'].includes(code ?? '') && origin === 'tool') return 'tool_error'
  if (['HTTP', 'MODEL_UNAVAILABLE', 'MODEL_ERROR', 'ECONNRESET', 'EAI_AGAIN'].includes(code ?? '') && origin === 'model') return 'model_error'
  if (['EXECUTION_INTERRUPTED', 'EXECUTION_FAILED', 'EXECUTION_STOPPED', 'RECOVERY_FAILED', 'ATTEMPTS_EXHAUSTED', 'DEADLINE_EXCEEDED'].includes(code ?? '')) return 'runtime_error'
  return 'unknown'
}
