# Contributing to nubos-pilot

## Setup

```sh
node --version   # must be >= 22
npm install
npm test         # 1900+ tests; runs in ~13s
```

## Code Conventions

The tool ships its own doctrines in `templates/COMPLETENESS.md`. The two
mechanically enforced rules:

- **`bin/check-completeness.cjs`** — every agent file (`agents/*.md`) and
  workflow file (`workflows/*.md`) must declare a Completeness block.
- **`bin/check-workflows.cjs`** — every workflow's referenced agents must
  exist; every workflow step that spawns an agent must use the visual
  `# ACTION CONTRACT` block convention, not prose.

Run both before pushing:

```sh
node bin/check-completeness.cjs
node bin/check-workflows.cjs
```

## Architecture Decisions

The full ADR set lives in the VitePress at
[`knowledge/libraries/nubos-pilot/v1/adr/`](https://pilot.nubos.cloud/v1/adr/).
The load-bearing ones for contributors:

| ADR | What it pins |
|---|---|
| 0004 | `workflow.commit_artifacts` controls whether `.nubos-pilot/` is committed |
| 0010 | Nubosloop — researcher → executor → critic-schwarm is mandatory in `/np:execute-phase` |
| 0012 | Completeness doctrine (12 rules in `templates/COMPLETENESS.md`) |
| 0013 | Learnings store schema evolution |
| 0017 | Strict output-schema enforcement |
| 0019 | Plan-side trust layer (`lib/plan-lint.cjs`) |

## Commit Convention

Task-scoped commits use the form:

```
task(M001-S001-T0001): one-line description (≤200 chars, no newlines)
```

Doc commits:

```
docs(M001): research milestone M001-S001 (light mode)
```

ADR commits:

```
adr(0019): plan-side trust layer
```

Never pass `--no-verify`, `--force`, or `git reset --hard` in nubos-pilot
workflows. Pre-commit hooks (secret scanners, lint, signing) are a security
boundary, not a speed bump.

## Testing

```sh
npm test                  # full suite
node --test lib/foo.test.cjs   # single module
npm run test:coverage     # coverage report
npm run check-coverage    # gate
```

Every new `lib/*.cjs` module needs a sibling `lib/*.test.cjs`. Every
new `bin/np-tools/*.cjs` command needs a sibling test. The dispatcher
in `np-tools.cjs` and the registry in `bin/np-tools/_commands.cjs` are
the two surfaces a new command must touch — keep them in sync.

## Reporting Issues

- **Security issues** — see [`SECURITY.md`](./SECURITY.md), do not file
  publicly.
- **Bugs and feature requests** — `gh issue create` or the issue tracker.
  Include `node --version`, `npx nubos-pilot --version`, and the output of
  `node np-tools.cjs doctor` if relevant.

## Pull Requests

1. Fork + feature branch.
2. Run `npm test && node bin/check-completeness.cjs && node bin/check-workflows.cjs`.
3. Open MR. CI runs the same gates plus VitePress build.
4. Squash-merge after review.
