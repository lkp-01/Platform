# Agent Note: Platform Run lifecycle around Harness

Status: implemented

English | [中文](2026-09-17-platform-run-lifecycle.zh.md)

## Problem

Version attribution alone cannot answer when a task starts, whether cancellation has settled, or what output survives a Host restart. Deriving every list row from its whole Session also makes task queries depend on transcript availability.

## Decision

[PlatformRuns](../../../../packages/business/agent-builder/src/platform-runs.ts) owns single-Host admission and a five-state persisted lifecycle. It writes PENDING and the fixed version before asynchronously preparing and invoking Session Controller. The original Harness loop remains the only execution driver. Session start/end observations flush their source before updating the Run summary; source sequence numbers make projection idempotent. A Run record stores bounded lifecycle events atomically with its state, while original model/tool messages remain in the Session.

Cancellation records intent before touching Harness. A pending task cannot submit after cancellation; a running task remains RUNNING until its ending confirms cancellation. Terminal transitions cannot be overwritten by late cancellation. Runtime disposal drains admission and launch operations before closing storage. Cold reads reconcile old admissions without resubmitting work; interruption becomes FAILED with an explicit reason and detected timing. Storage failures remain visible and do not manufacture successful completion.

## Alternatives considered

**Read-only Session projection** avoids an extra summary but cannot directly represent admission or failed preparation and scans transcripts for lists. **A separate execution service and queue** adds distribution and ownership protocols before the platform needs them. The existing plugin, Storage Domain and shared execution identifiers provide the required scope.

## Consequences

Run queries stay independent of full transcript reads after settlement. The platform retains one input and a bounded final output reference, not a second transcript. The service supports one writing Host and shared-host identity; automatic retry, resume, checkpoints, worker scheduling and reliable cross-process event delivery remain outside its scope. Cancel cannot undo completed external effects or force a non-cooperative tool to stop. A detected end time is not an exact execution duration.

## Testing

[Lifecycle tests](../../../../packages/business/agent-builder/tests/run-lifecycle.spec.ts) cover five-state transitions and cause mapping. [Real Loader tests](../../../../packages/bundle/business-agents/tests/composition.spec.ts) exercise durable admission, cancellation races, failed writes, old records and version freezing. [Web tests](../../../../apps/web/tests/agent-run.e2e.ts) exercise direct details, results, failure and confirmed cancellation with a keyless model.
