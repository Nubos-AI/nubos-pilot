---
phase: {{phase}}
generated: {{timestamp}}
generator: np:ai-integration-phase
---

# Phase {{phase}} — AI Integration Spec

This document is the AI design contract for Phase {{phase}}. It locks the
framework, implementation patterns, domain rubrics, evaluation strategy,
guardrails, and production monitoring plan BEFORE the planner creates
tasks. Re-read this file in full before planning or executing any task
that produces, consumes, or reasons about model output.

## 1b. Domain Context

Business domain, stakeholders, and expert rubrics. Each rubric ingredient
(Good / Bad / Stakes) grounds a downstream eval dimension (Section 5).

{{domain_rubric}}

## 2. Framework Selection

Scoring matrix (cost, fit, maturity, ecosystem, lock-in) and final pick.
Capture the rejected alternative with one-line rationale so downstream
reviewers can revisit the trade-off.

{{framework_scoring_matrix}}

**Selected:** {{selected_framework}}

**Alternative considered:** {{alternative_framework}}

**Rationale:** {{rationale}}

## 3. Implementation

Canonical entry-point pattern using the selected framework. Copy-paste
ready; the planner turns this into literal task actions ("wire the client
exactly as shown below").

```{{language}}
{{code_patterns}}
```

Pitfalls and version-specific gotchas called out inline.

## 4b. Pydantic / Typed Models

Structured output contracts (Pydantic, Zod, dataclasses — whatever the
framework ingests). Use these types everywhere the model returns data;
free-text parsing is an eval-coverage regression.

```{{language}}
{{pydantic_models}}
```

## 5. Eval Dimensions

Named rubric per dimension. Each row states **what is measured**, **how
it is scored**, and **which Section-1b rubric ingredient it anchors**.

{{eval_dimensions}}

## 6. Guardrails

Hard constraints enforced at runtime — NOT evaluated post-hoc. PII
redaction, toxicity filters, cost caps, output-format validators, timeout
bounds. Guardrail violations MUST short-circuit the response.

{{guardrails}}

## 7. Production Monitoring

Tracing, metrics, and alerting contract. Arize Phoenix or detected
equivalent is the tracing default (OpenTelemetry-compatible). Specify
dashboard panels + alert thresholds here so they ship in Phase execution,
not as a retrofit.

{{monitoring_plan}}

## Checklist

- [ ] Framework selected with rationale (Section 2)
- [ ] Domain rubric ingredients non-empty (Section 1b)
- [ ] Entry-point code block non-empty (Section 3)
- [ ] Typed output models present (Section 4b)
- [ ] At least one eval dimension defined (Section 5)
- [ ] Guardrails list or explicit N/A rationale (Section 6)
- [ ] Production-monitoring plan with tracing default (Section 7)
