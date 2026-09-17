# Agent Note: Analysis from shared execution facts

Status: implemented

English | [中文](2026-09-17-agent-observability.zh.md)

## Problem

A Run timeline explains an individual execution but does not expose shared dependency failures or version-level changes. Summing delivery notifications duplicates retries, and task success does not establish answer correctness.

## Decision

AgentBuilder derives compact per-Run analysis records from the existing Trace projection and Runtime lifecycle. Tool journal attempts supply actual dispatch, outcome and error codes; Session results do not count the same attempt again. Runtime records operator attribution and intervention links. The Harness Agent Loop remains unchanged. This extends the [Run Trace decision](../architecture/2026-09-17-run-trace.md), which remains the owner of source recording and timeline publication.

One atomic Storage Domain row contains each Run's analysis facts. Publication replaces that row after persistence; readers consume immutable published records. Startup queues historical Runs, background notifications queue changed records, and failed writes remain pending for another pass. Shutdown stops Runtime producers while keeping storage readable, drains observers, and then closes storage. This avoids partially published multi-table generations at the current single-Host scale.

Queries select an explicit Run cohort or attempt-time window. Success rates preserve numerator and denominator, cancellations and unknown timing are separate, and percentiles use known samples. Model usage retains cache categories. Versioned operator prices produce currency-specific estimates, with missing prices or usage excluded from priced coverage. Rebuilding preserves an already applied price when the original usage and routing are unchanged.

## Alternatives considered

Scanning every Session on each dashboard request ties query latency to transcript size. An independent telemetry collector duplicates lifecycle recording. A distributed analytics database adds operational responsibilities before the single-Host workload requires it. Compact derived records keep ordinary reads independent of Session logs and allow deterministic rebuilding.

## Consequences

Agent-scoped analysis requires edit permission and workspace-wide analysis requires administrator permission. Membership is checked on every request and cursor read. The governed portal and optional Host client consume the same use cases. There is no implicit global administrator or team ACL based on owner labels.

Task failure classification uses recorded codes, not the last nearby tool error as a guessed root cause. Run success and live version comparisons do not constitute business-quality evaluation. Old data can lack dispatch evidence, cache usage, resource versions and intervention attribution. Historical reconstruction reports these gaps. Backfill is idempotent and restarts its scan after process restart; there is no durable scan cursor or multi-Host coordinator.

## Verification

[Projection tests](../../../../packages/business/agent-builder/tests/observability-projection.spec.ts) cover attempts, operator-confirmed unknown outcomes and privacy-minimal records. [Accounting tests](../../../../packages/business/agent-builder/tests/observability-metrics.spec.ts) cover denominators, explicit error codes and versioned cost. [Composition tests](../../../../packages/bundle/business-agents/tests/composition.spec.ts) exercise unread traces, storage faults and reload. [Browser tests](../../../../apps/web/tests/agent-observability.e2e.ts) cover permission checks, version comparison, price coverage and Trace drill-down through the shipped portal. [Capacity tests](../../../../packages/business/agent-builder/tests/observability-performance.spec.ts) measure core aggregation separately from HTTP and rendering.
