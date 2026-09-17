# Agent Note: Reliable single-Host Runtime

Status: implemented

English | [中文](2026-09-17-reliable-runtime.zh.md)

## Problem

Run records explained past execution but did not ensure accepted tasks survived process loss. Retrying a write after losing its result could repeat an external effect.

## Decision

AgentBuilder owns durable admission, bounded in-process workers, captured budgets, cooperative cancellation and recovery. The existing JSONL kernel-backed write lease is exported and reused for exclusive Host ownership. Harness plugins provide tool dispatch barriers, canonical result observation and pre-step persistence. The original Harness Agent Loop is unchanged.

A tool journal records intent before dispatch and stores results before further execution. Recovery preserves call identities and re-enters the complete tool pipeline. Explicitly declared safe operations can retry with durable backoff; uncertain writes block until an operator records verified evidence. Run events and journal attempts feed the existing Trace projection. Checkpoints do not trigger heartbeat-only Trace rebuilds.

## Alternatives considered

A separate Agent Loop would duplicate Harness semantics. TTL-only ownership could let a paused writer resume after another worker acquired the task. The current single-Host kernel lock gives a smaller, testable ownership boundary. Treating every pending tool as safe to retry would duplicate writes. Repeated middleware next calls would skip consumed policy handlers; maintenance recovery instead enters Tools again.

## Consequences

This is single-machine execution with in-process worker concurrency, not distributed scheduling. Cancellation cannot retract remote effects. Nested uncertain tool calls remain blocked. Storage and external idempotency contracts determine durability and side-effect guarantees. Legacy tasks are not silently replayed. Long tasks have bounded execution policy and periodic checkpoints; Trace still folds full execution history on relevant facts, so fully incremental projection and retention remain deferred.

## Testing

[Runtime tests](../../../../packages/business/agent-builder/tests/runtime-recovery.spec.ts) exercise admission, provider readiness, cancellation, bounded concurrency, restart, exclusive ownership, tool guards and operator reconciliation. [Hard-crash tests](../../../../apps/cli/tests/reliable-runtime.expected.e2e.ts) kill real child processes at admission, model, dispatch and final-state boundaries, using real Harness execution and file persistence. The child driver substitutes API composition only. [Web tests](../../../../apps/web/tests/agent-run.e2e.ts) cover the shipped Loader composition and operator recovery UI with a keyless model.
