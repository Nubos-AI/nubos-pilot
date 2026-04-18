const COMMANDS = [
  { name: 'next',     category: 'Utility', description: 'Print the next actionable step' },
  { name: 'progress', category: 'Utility', description: 'Report % complete across phases and plans' },
  { name: 'state',    category: 'Utility', description: 'Print the current project state snapshot' },
  { name: 'help',     category: 'Utility', description: 'List available commands' },
  { name: 'init',     category: 'Utility', description: 'Dispatcher init payload for workflows' },

  { name: 'discuss-phase',       category: 'Planning', description: 'Adaptive phase-context interview (writes CONTEXT.md)' },
  { name: 'discuss-phase-power', category: 'Planning', description: 'Bulk gray-area question file-UI (power mode)' },
  { name: 'research-phase',      category: 'Planning', description: 'Optional phase-level research (WebFetch + MCP; offline fallback)' },
  { name: 'plan-phase',          category: 'Planning', description: 'Creates PLAN.md with plan-checker verification loop' },
  { name: 'new-project',         category: 'Planning', description: 'Greenfield project init (PROJECT.md + REQUIREMENTS.md + roadmap)' },
  { name: 'new-milestone',       category: 'Planning', description: 'Append milestone + first phase to an existing project' },
  { name: 'plan-milestone-gaps', category: 'Planning', description: 'Create corrective phases from audit gaps' },
  { name: 'agent-skills',        category: 'Planning', description: 'Print agent_skills config for a given subagent' },

  { name: 'execute-phase',       category: 'Execution', description: 'Wave-based phase execution (emits per-task executor-spawn payloads)' },
  { name: 'execute-plan',        category: 'Execution', description: 'Single-plan execution (sub-case of execute-phase)' },
  { name: 'commit-task',         category: 'Execution', description: 'Atomic per-task git commit via lib/git.cjs (D-03/D-25 enforced)' },
  { name: 'checkpoint',          category: 'Execution', description: 'Per-task crash-safety checkpoint CRUD (start/transition/touch/show)' },
  { name: 'autonomous',          category: 'Execution', description: 'In-session gate snapshot for auto-advance loop (ADR-0001, no daemon)' },
  { name: 'verify-work',         category: 'Execution', description: 'Two-pass goal-backward verification (D-21/D-22 VERIFICATION.md render/record)' },
  { name: 'add-tests',           category: 'Execution', description: 'Persist VERIFICATION Pass-cases as node:test UAT (Sentinel-preserving)' },
  { name: 'pause-work',          category: 'Execution', description: 'Stamp STATE.session.stopped_at + resume_file for explicit handoff' },
  { name: 'resume-work',         category: 'Execution', description: 'Classify session state (resume | orphan | clean) from STATE + checkpoints' },

  { name: 'undo',                category: 'Execution', description: 'Revert all task commits of a phase or plan via git revert (no history rewrite)' },
  { name: 'undo-task',           category: 'Execution', description: 'Revert a single task commit and reset task status to pending' },
  { name: 'reset-slice',         category: 'Execution', description: 'Restore working-tree files of the in-flight task and clear current_task (no commit)' },
  { name: 'skip',                category: 'Execution', description: 'Mark task status skipped (lifecycle CRUD)' },
  { name: 'park',                category: 'Execution', description: 'Mark task status parked (lifecycle CRUD)' },
  { name: 'unpark',              category: 'Execution', description: 'Return a parked task to pending (lifecycle CRUD)' },

  { name: 'doctor',              category: 'Install', description: '5-check install-integrity scan (--fix for auto-safe fixes)' },
  { name: 'dispatch',            category: 'Install', description: 'State-router: computes next action and delegates via Skill()' },
  { name: 'queue',               category: 'Install', description: 'Unified queue across todos/backlog/UAT/unplanned phases' },
  { name: 'triage',              category: 'Install', description: 'Interactive per-item triage loop (promote/keep/drop)' },

  { name: 'resolve-model',       category: 'Utility', description: 'Resolve agent/tier to model alias or id (Tier×Profile matrix; consulted at Task-spawn sites by workflows)' },

  { name: 'metrics',             category: 'Utility', description: 'Record JSONL metrics entry (record | now | start-timestamp | end-timestamp)' },

  { name: 'plan-diff',           category: 'Planning', description: 'Render two-part PLAN.md diff (semantic + git) or archive-rejected with reason' },

  { name: 'ai-integration-phase', category: 'Planning', description: 'AI-SPEC generator with framework-selector + eval-planner (spawns 4 np-agents)' },
  { name: 'ui-phase',              category: 'Planning', description: 'UI-SPEC generator with researcher + checker revision loop' },
  { name: 'ui-review',             category: 'Review', description: '6-pillar retroactive UI audit on a completed phase' },
  { name: 'eval-review',           category: 'Review', description: 'Retroactive eval-coverage audit on a completed phase' },

  { name: 'askuser',         category: 'Utility', description: 'Capability-layer prompt wrapper (reads spec JSON, returns chosen label)' },
  { name: 'commit',          category: 'Utility', description: 'Atomic git commit wrapper with gitignore-guard (D-21)' },
  { name: 'config-get',      category: 'Utility', description: 'Read value from .nubos-pilot/config.json by dotted key path' },
  { name: 'generate-slug',   category: 'Utility', description: 'Slugify text via lib/phase.cjs.phaseSlug (used by add-todo, add-backlog, thread)' },
  { name: 'phase',           category: 'Utility', description: 'Phase utilities (next-decimal <base> — used by add-backlog 999.x)' },
  { name: 'stats',           category: 'Utility', description: 'Aggregated project stats (roadmap + STATE + git + metrics JSON shape)' },

  { name: 'code-review',      category: 'Review',  description: 'Source-file review via np-code-reviewer (depth quick/standard/deep) — writes REVIEW.md sidecar' },
  { name: 'code-review-fix',  category: 'Review',  description: 'Auto-fix REVIEW.md findings via np-code-fixer (atomic commit per finding)' },
  { name: 'review',           category: 'Review',  description: 'Cross-AI peer review via 7-CLI fan-out (gemini/claude/codex/coderabbit/opencode/qwen/cursor)' },
  { name: 'secure-phase',     category: 'Review',  description: 'Threat-mitigation audit via np-security-auditor against PLAN.md threat_model' },
  { name: 'validate-phase',   category: 'Review',  description: 'Nyquist validation gap-fill via np-nyquist-auditor' },
  { name: 'add-todo',         category: 'Capture', description: 'Capture a pending todo to .nubos-pilot/todos/pending/ + increment STATE count' },
  { name: 'note',             category: 'Capture', description: 'Capture a free-form note (project default, --global writes to ~/.nubos-pilot/notes/)' },
  { name: 'add-backlog',      category: 'Capture', description: 'Append backlog item 999.x to ROADMAP.md + scaffold phase dir' },
  { name: 'thread',           category: 'Utility', description: 'Cross-session thread CRUD (create/resume under .nubos-pilot/threads/)' },
  { name: 'session-report',   category: 'Utility', description: 'Generate session report from metrics since .last-session pointer' },
  { name: 'cleanup',          category: 'Utility', description: 'Archive completed milestones to .nubos-pilot/archive/v<X.Y>/ + collapse ROADMAP <details> block' },
];

module.exports = { COMMANDS };
