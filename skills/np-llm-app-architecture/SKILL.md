---
name: np-llm-app-architecture
description: "Quality bar for any change that designs or modifies an LLM-backed feature — a prompt, an agent loop, tool/function calling, structured-output extraction, an LLM-as-judge, or any path where model output flows into the system. Triggered for researcher, architect, and executor work on LLM/agent/prompt/tool-use/AI features. Encodes the design rules the change MUST satisfy before commit, not a design document to author. Provider- and framework-agnostic."
user-invocable: false
---

# LLM Application Architecture

A language model is a non-deterministic, fallible component you do not control. Designing around one is not prompt-tweaking — it is building a system that stays correct, safe, and affordable when the model is wrong, slow, or adversarially steered. Apply this bar to the LLM feature you are about to commit.

## Before editing

- Read the project's existing LLM conventions first: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "llm feature conventions" --task $TASK_ID`. Match the established prompt structure, output-validation idiom, and provider client. Do not introduce a second one.
- For the current model lineup, context windows, and API specifics, consult the project's own up-to-date reference — never hardcode model names or limits from memory.

## Eval before build

- Define what "correct" means before writing the prompt. A capability check (does it do the task on representative cases) plus a regression set (does a prompt/model change break what worked) — not vibes, not a single happy-path demo.
- Wire the eval into the project's verify step so a prompt or model change that regresses output fails the gate, the same as a code change.

## Treat output as untrusted

- The model's output is hostile input until validated. Never pipe raw output into a sink — a query, a shell, a file path, a render, a downstream call — without parsing and checking it.
- Constrain the shape: schema / structured-output / function-call form, not free-text you regex after the fact. Validate against the schema; reject and retry on a miss, never best-effort-parse.

## Context is a budget, not a dump

- Decide deliberately what enters the prompt. Token budget is finite and cost/latency scale with it — relevance beats volume.
- Have an explicit truncation/selection strategy for oversized context (rank, summarize, window) — never silently drop the tail and hope.

## Tools & injection are trust boundaries

- A tool/function call crosses the same trust boundary as any external input: authorize the call and validate every argument before executing. The model proposing a tool call is not authorization.
- Prompt injection is real: untrusted content in the prompt must not be able to escalate. Separate instructions from data, and grant tools least privilege so a hijacked prompt cannot reach what it should not.

## Failure & cost are design inputs

- Plan for timeouts, rate limits, refusals, and malformed output as expected states, not exceptions. Define retries (with backoff), fallbacks, and a degraded path.
- Route by task complexity and cache where safe — cost and latency are design constraints, not afterthoughts.
- Never put secrets or PII into prompts or logs. Prompts and completions are frequently logged; treat them as such.

## Verification bar (must hold before commit)

- An eval (capability + regression) exists and is wired into the project's verify step — pair with the project's verify gate.
- No model output reaches a sink unvalidated; output is schema-constrained and parse failures are handled.
- Context entering the prompt is bounded with a deliberate truncation strategy; no unbounded dump.
- Every tool call is authorized and its arguments validated; tools run at least privilege — pair with [np-secure-code-review] for prompt-injection and tool-trust handling.
- Timeouts, rate limits, refusals, and malformed output have defined retry/fallback behavior — pair with [np-error-handling] for failure modes.
- No secret or PII enters any prompt or log.
- If the feature retrieves context from a corpus, the retrieval design itself meets [np-rag-design].
