# Security Policy

## Reporting a Vulnerability

If you discover a security issue in nubos-pilot, **do not open a public issue**.
Email **security@nubos.ai** with:

- A description of the issue and its impact.
- Steps to reproduce (PoC if possible).
- The affected version (`npx nubos-pilot --version` or check `package.json`).
- Your preferred contact channel for follow-up.

We will acknowledge receipt within **3 business days** and provide a
resolution plan within **14 business days**. Fixes are released as patch
versions and announced in `CHANGELOG.md`.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.0.x   | ✅ active |
| < 0.0   | ❌ end of life |

Only the latest minor on the current major (0.x) receives security patches.

## Threat Model

nubos-pilot is a **local CLI** distributed via npm to developer workstations
and CI. It is **not** a hosted service. The threat surface and assumptions:

| What nubos-pilot reads | What it writes | What it executes |
|---|---|---|
| `.nubos-pilot/`, project source for context | `.nubos-pilot/` state, `~/.codex/`, `~/.claude/` config (install only) | `git`, `claude`/`codex` headless via `child_process.spawn` |

**Trust boundaries:**

- **Project source code** — untrusted in the sense that agent-authored
  files (`PLAN.md`, `RESEARCH.md` etc.) may contain hostile YAML. nubos-pilot
  rejects prototype-pollution keys, refuses symlink-escape via `safe-path`,
  caps message bodies, and whitelists ML model identifiers.
- **`.nubos-pilot/messages/`** — multi-agent inbox; entries are written
  atomically with `O_CREAT|O_EXCL|O_NOFOLLOW` (POSIX) so a pre-planted
  symlink cannot redirect writes.
- **Subprocess spawn** — `claude`/`codex` are invoked via `spawnSync` (no
  shell). The binary path is overridable via `NUBOS_PILOT_CLAUDE_BIN` /
  `NUBOS_PILOT_CODEX_BIN`; treat operators who can set those env vars as
  trusted.
- **`workflow.commit_artifacts`** flag controls whether `.nubos-pilot/`
  artifacts are committed to git. Default is `true`; downstream projects
  that consider artifacts sensitive should set it to `false`.
- **Repository content fed to the security reviewer** — the in-session review
  puts the turn diff, untracked file bodies and `security.guidance_path` into a
  reviewer prompt. That content is untrusted: it is fenced in
  `<untrusted_diff>` / `<untrusted_guidance>`, closing fences inside it are
  neutralized so it cannot escape into the instruction layer, and a
  deterministic pre-check flags instruction-shaped text as a Prompt Injection
  finding. Treat a prompt-injection bypass here as in scope.
- **The bundled advisory snapshot** (`~/.nubos-pilot/advisory-db/<version>/`,
  [ADR-0031](https://pilot.nubos.cloud/v1/adr/0031-native-dependency-and-misconfig-scanner))
  is redistributed third-party data. Every shard is verified against a
  SHA-256 recorded in its manifest **before** it is decompressed, and a
  mismatch refuses the vulnerability verdict entirely rather than answering
  from suspect data — a tampered store would report vulnerabilities as absent,
  which is worse than having no store. `npx nubos-pilot doctor` reports a
  digest mismatch at **error** severity. Treat a path that yields a
  vulnerability verdict from an unverified shard as in scope.
- **Scan scope** — the scanner refuses a home directory or a filesystem root as
  a scan target, so a mis-resolved root cannot walk a developer's whole home
  directory. Secret findings never carry the matched value.

## What is Out of Scope

- Vulnerabilities in `@huggingface/transformers`, `usearch`, or the
  `yaml` package — report those upstream.
- Operator-controlled config (`config.json`) that the operator themselves
  wrote — config is trusted input from the project owner.
- DoS from running nubos-pilot in obviously bad conditions
  (no disk space, no Node 22+, broken `git`).
