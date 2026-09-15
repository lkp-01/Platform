# Project: Agent Platform based on DeepSeek Harness

## 1. Project Goal

This project extends DeepSeek Harness into a small internal Agent Platform.

Target users:
- AI development teams of roughly 20-50 developers
- multiple teams building multiple business Agents

The platform should allow business teams to focus mainly on:
- business goals
- prompt / instructions
- model
- tools
- memory requirements
- evaluation criteria

Shared engineering capabilities are provided by the platform.

## 2. Core Architecture

DeepSeek Harness is the Agent execution core.

Its existing Agent Loop should remain the foundation:

LLM -> Tool -> LLM -> Tool -> Final

The Platform adds shared capabilities around it:

1. Runtime
   - session
   - task
   - retry
   - checkpoint
   - resume
   - cancel
   - concurrency

2. Tool Platform
   - tool registration
   - gateway
   - MCP / API adapters
   - authentication
   - timeout / retry
   - audit

3. Memory
   - session memory
   - user memory
   - agent/team memory
   - namespace isolation

4. Observability
   - run
   - trace
   - span
   - LLM calls
   - tool calls
   - memory operations
   - latency / errors

5. Evaluation
   - datasets
   - replay
   - regression tests
   - version comparison

6. Control Plane
   - workspace
   - team
   - user
   - permissions
   - agent config
   - agent version
   - deployment

## 3. Architectural Principles

### Preserve DeepSeek Harness

Prefer:
- plugins
- hooks
- adapters
- external services

Avoid modifying DeepSeek Harness core behavior unless necessary.

Before changing Harness core code:
1. inspect the existing extension mechanism;
2. check whether the feature can be implemented as a plugin or adapter;
3. explain why a core modification is required.

### Clear responsibility boundary

DeepSeek Harness owns:
- Agent Loop
- model interaction
- tool-calling loop
- plugin execution

Platform Runtime owns:
- task lifecycle
- reliability
- persistence
- retry / resume
- concurrency

Do not implement another independent Agent Loop in Platform Runtime.

## 4. Shared Execution Model

Platform capabilities should observe the same execution lifecycle.

Prefer a common execution event / trace model:

Runtime
  -> Execution Events
      -> Observability
      -> Evaluation

Avoid building separate execution-recording systems for each module.

## 5. Coding Rules

- Keep changes small and focused.
- Avoid unrelated refactors.
- Reuse existing DeepSeek Harness abstractions where possible.
- Preserve existing Harness behavior unless the task explicitly requires changing it.
- Add abstractions only when there is a concrete platform requirement.
- Do not introduce infrastructure merely because AWS AgentCore has it.
- Never commit API keys, passwords, tokens, or credentials.
- Add tests for important platform behavior.

## 6. Before Implementing a Feature

Before coding, identify:

1. What product problem does this feature solve?
2. Which layer owns it?
3. Does DeepSeek Harness already provide part of it?
4. Can it be implemented through the existing plugin architecture?
5. What is the minimum implementation required for the current stage?

If architectural ownership is unclear, stop and explain the alternatives before making a large change.

## 7. Definition of Done

A task is complete when:

- the requested behavior works;
- existing relevant behavior still works;
- relevant tests pass;
- the implementation respects the architecture boundaries above;
- no unrelated large-scale refactoring was introduced.