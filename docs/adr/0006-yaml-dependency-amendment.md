# ADR-0006: Accept yaml@^2.8 as First Runtime Dependency (Amendment to ADR-0002)

* Status: Accepted
* Date: 2026-04-15
* Supersedes: None
* Amends: [ADR-0002](0002-zero-runtime-dependencies.md)

## Context and Problem Statement

Phase 4 introduces `.nubos-pilot/roadmap.yaml` as the canonical source-of-truth for roadmap data (Phase-4 D-16..D-20). The schema contains nested sequences, mixed scalar types, and per-phase `plans` sub-objects that go well beyond what a hand-rolled regex parser can robustly handle. `lib/frontmatter.cjs` (the hand-rolled parser) already hits its design ceiling on Task-Frontmatter multiline sequences — extending it further to parse the full roadmap YAML would reimplement a real YAML 1.2 parser in-repo, which is strictly worse than vendoring a 50KB battle-tested library.

ADR-0002 §"Escape hatch for future exceptions" explicitly foresees this: "if a concrete future feature genuinely requires a runtime dep that builtins cannot satisfy, the exception is introduced by a new ADR […] that either supersedes ADR-0002 wholesale or amends it narrowly with a name-scoped exemption." This ADR is the first exercise of that escape hatch.

## Scope

* This amendment permits **EXACTLY ONE** additional runtime dependency: `yaml@^2.8`.
* `package.json.dependencies` is limited to `{"yaml": "^2.8.0"}` — no other key permitted.
* **No further runtime deps** may be added without a new ADR amendment that either supersedes ADR-0002 again, or amends it with a second narrowly-scoped exemption. The bureaucratic step is deliberate — the escape hatch is load-bearing on the "just add a dep" reflex never becoming the default answer.
* `devDependencies` remain unconstrained by this amendment (same as ADR-0002 §Scope).

## Decision Drivers

* **Concrete need** — Phase-4 D-16..D-20 ship `roadmap.yaml` with nested sequences (milestones → phases → plans) that the hand-rolled regex parser cannot express.
* **Pre-sanctioned by CLAUDE.md** — the project's tech-stack document explicitly identifies `yaml@^2.8` as the acceptable escape-hatch dependency under "Supporting Libraries" / "When to Use Alternative".
* **Install-footprint minimal** — `yaml@^2.8` has zero transitive dependencies and ships ~50KB of JS. This does not re-open the dep-tree floodgate ADR-0002 guards against.
* **Type safety** — `YAML.parse` yields typed scalars (number, string, boolean, null, arrays of same) — no ad-hoc type coercion needed in callers.
* **Round-trip support** — `yaml@^2.8` supports CST-preserving `YAML.parseDocument` for future phases that need to edit YAML while preserving comments.

## Considered Options

* **Option A — Keep regex parser, extend it to handle nested sequences.** Reject: every step along this road lands in a hand-rolled YAML 1.2 implementation. `lib/frontmatter.cjs` already has edge-cases around stack-demotion and inline vs block arrays; adding plans-objects-inside-phases-inside-milestones is not tenable.
* **Option B — Write a minimal purpose-built YAML subset parser.** Reject: the effort to correctly support nested sequences + mixed-scalar-types exceeds the install-surface cost of vendoring `yaml@^2.8`. Writing a new parser is also a test-surface multiplier (we'd need the fuzz-corpus `yaml@^2.8` already passes).
* **Option C — Accept `yaml@^2.8` as the first and only additional runtime dependency.** Chosen: demonstrable concrete need, pre-sanctioned, zero transitive deps, narrow scope preserves ADR-0002's spirit.
* **Option D — Move the roadmap source-of-truth back to Markdown.** Reject: Phase-4 D-16..D-20 lock roadmap.yaml as source-of-truth specifically because Markdown cannot express the structured plan-object data the downstream renderer/workflows need.

## Decision Outcome

Chosen: **Option C — accept `yaml@^2.8` as the first runtime dependency**, because the concrete need is documented in Phase-4 decisions D-16..D-20, CLAUDE.md pre-sanctions this specific dep, and the narrow name-scoped amendment preserves ADR-0002's forcing function against "just add a dep" drift.

**Audit rule:** Any PR that adds a key to `package.json.dependencies` beyond `yaml` MUST be blocked unless it ships with a new ADR amendment that supersedes this one or adds a second narrowly-scoped exemption. Phase 1's CI-gate enforcement note (ADR-0002 closing paragraph) applies here verbatim — human PR review is the current enforcement, CI-gate is deferred to a later phase.

### Consequences

* Good, because roadmap.yaml parsing is now robust across nested sequences and YAML 1.2's full scalar type system.
* Good, because future phases that need structured YAML (e.g. Phase 5 plan-diff, Phase 9 model-profile config) can reuse `yaml@^2.8` without another amendment.
* Good, because the install-footprint remains effectively flat — `yaml@^2.8` has zero transitive dependencies (confirm with `npm ls --all`).
* Bad, because `npx nubos-pilot` now performs one actual download at install time on a fresh machine. ADR-0002's "zero-deps ≈ zero failure modes" property is slightly weakened — but only by the thinnest possible amount.
* Bad, because the escape-hatch is no longer purely theoretical — future PR authors have a concrete precedent to cite. Mitigation: the Scope clause pins this to EXACTLY ONE dep, and the audit rule makes a second exemption equally bureaucratic.
* Neutral, because Pattern S-1 (atomic write + file lock), S-2 (NubosPilotError envelope), S-5 (sandboxed tests), and S-6 (CJS module footer) remain unchanged — no workflow pattern changes with this amendment.

## More Information

* **Amended ADR:** [ADR-0002](0002-zero-runtime-dependencies.md) — this amendment exercises the escape hatch documented in §"Escape hatch for future exceptions" (line 37 of ADR-0002).
* **CLAUDE.md:** §"Supporting Libraries" → row "yaml `^2.8.0`" pre-sanctions this dependency with the condition "Only adopt if a concrete workflow produces frontmatter that the hand-rolled regex parser can't handle (multiline arrays, anchors). Default answer is still 'no'." The Phase-4 roadmap.yaml schema satisfies that concrete-workflow condition.
* **Phase-4 Context:** `.planning/phases/04-base-workflows-state-schemas/04-CONTEXT.md` D-16..D-20 (roadmap.yaml source-of-truth decisions).
* **Upstream:** [`yaml` npm package](https://www.npmjs.com/package/yaml) — maintained by Eemeli Aro, version 2.x is YAML 1.2 compliant, zero transitive deps.

---

*This ADR does not describe CI enforcement. The dep-growth block (PR blocker on any new `dependencies` key beyond `yaml`) is deferred to a later deploy/CI phase per ROADMAP.md, identical to ADR-0002's deferral. Enforcement in the source-only phases is human PR review with this ADR as the authoritative reference.*
