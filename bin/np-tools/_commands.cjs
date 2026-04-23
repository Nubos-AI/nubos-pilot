const COMMANDS = [
  { name: 'state',    category: 'Utility', description: 'Print the current project state snapshot' },
  { name: 'help',     category: 'Utility', description: 'List available commands' },
  { name: 'init',     category: 'Utility', description: 'Dispatcher init payload for workflows' },

  { name: 'discuss-project',     category: 'Planning', description: 'Adaptive project-context interview (writes PROJECT.md decisions)' },
  { name: 'discuss-phase',       category: 'Planning', description: 'Adaptive milestone-context interview (writes M<NNN>-CONTEXT.md)' },
  { name: 'research-phase',      category: 'Planning', description: 'Milestone-level research (WebFetch + MCP; offline fallback)' },
  { name: 'plan-milestone',      category: 'Planning', description: 'Plan a milestone: scaffolds slices + tasks' },
  { name: 'new-project',         category: 'Planning', description: 'Greenfield project init (PROJECT.md + REQUIREMENTS.md + M001 milestone)' },
  { name: 'new-milestone',       category: 'Planning', description: 'Append a new milestone (M<NNN>) to an existing project' },
  { name: 'propose-milestones',  category: 'Planning', description: 'Re-plan all not-yet-done milestones: AI proposes add/update/remove from PROJECT.md + REQUIREMENTS.md' },
  { name: 'agent-skills',        category: 'Planning', description: 'Print agent_skills config for a given subagent' },

  { name: 'execute-milestone',   category: 'Execution', description: 'Wave-based milestone execution — slice by slice, tasks parallel within a slice' },
  { name: 'commit-task',         category: 'Execution', description: 'Atomic per-task git commit via lib/git.cjs' },
  { name: 'checkpoint',          category: 'Execution', description: 'Per-task crash-safety checkpoint CRUD (start/transition/touch/show)' },
  { name: 'verify-work',         category: 'Execution', description: 'Two-pass goal-backward verification (milestone-level VERIFICATION.md)' },
  { name: 'add-tests',           category: 'Execution', description: 'Persist VERIFICATION Pass-cases as node:test UAT (Sentinel-preserving)' },
  { name: 'pause-work',          category: 'Execution', description: 'Stamp STATE.session.stopped_at + resume_file for explicit handoff' },
  { name: 'resume-work',         category: 'Execution', description: 'Classify session state (resume | orphan | clean) from STATE + checkpoints' },

  { name: 'skip',                category: 'Execution', description: 'Mark task status skipped (lifecycle CRUD)' },
  { name: 'park',                category: 'Execution', description: 'Mark task status parked (lifecycle CRUD)' },
  { name: 'unpark',              category: 'Execution', description: 'Return a parked task to pending (lifecycle CRUD)' },

  { name: 'undo',                category: 'Execution', description: 'Revert every task commit of a milestone or slice via git revert (no history rewrite)' },
  { name: 'undo-task',           category: 'Execution', description: 'Revert a single task commit and reset task status to pending' },
  { name: 'reset-slice',         category: 'Execution', description: 'Discard in-flight task: restore working tree from HEAD, drop checkpoint, clear STATE.current_task' },

  { name: 'doctor',              category: 'Install', description: '5-check install-integrity scan (--fix for auto-safe fixes)' },
  { name: 'scan-codebase',       category: 'Install', description: 'Initial deep codebase inventory → .nubos-pilot/codebase/ skill docs' },
  { name: 'update-docs',         category: 'Install', description: 'Refresh stale module docs after code changes' },

  { name: 'resolve-model',       category: 'Utility', description: 'Resolve agent/tier to model alias or id (Tier×Profile matrix)' },
  { name: 'metrics',             category: 'Utility', description: 'Record JSONL metrics entry (record | now | start-timestamp | end-timestamp)' },

  { name: 'validate-phase',      category: 'Review',  description: 'Nyquist validation gap-fill via np-nyquist-auditor' },

  { name: 'add-todo',            category: 'Capture', description: 'Capture a pending todo to .nubos-pilot/todos/pending/ + increment STATE count' },
  { name: 'note',                category: 'Capture', description: 'Capture a free-form note (project default, --global writes to ~/.nubos-pilot/notes/)' },
  { name: 'add-backlog',         category: 'Capture', description: 'Append backlog item to ROADMAP.md' },

  { name: 'askuser',         category: 'Utility', description: 'Capability-layer prompt wrapper (reads spec JSON, returns chosen label)' },
  { name: 'commit',          category: 'Utility', description: 'Atomic git commit wrapper with gitignore-guard' },
  { name: 'config-get',      category: 'Utility', description: 'Read value from .nubos-pilot/config.json by dotted key path' },
  { name: 'lang-directive',  category: 'Utility', description: 'Print workflow language directive from config.response_language (SSOT)' },
  { name: 'text-mode',       category: 'Utility', description: 'Print whether text mode is active (config.workflow.text_mode ∨ CLAUDECODE)' },
  { name: 'generate-slug',   category: 'Utility', description: 'Slugify text via lib/layout.cjs.slugify' },
  { name: 'stats',           category: 'Utility', description: 'Aggregated project stats (roadmap + STATE + git + metrics JSON shape)' },
  { name: 'detect-runtime',  category: 'Utility', description: 'Print detected runtime id (claude, codex, gemini, …) — reads config.json ∨ env ∨ default' },
  { name: 'template-path',   category: 'Utility', description: 'Print absolute path to a package-shipped template by name (e.g. VALIDATION, milestone/CONTEXT)' },
  { name: 'update-phase-meta', category: 'Planning', description: 'Update roadmap.yaml phase fields (name/goal/requirements/success_criteria) via JSON patch' },
  { name: 'phase-meta',        category: 'Planning', description: 'Read roadmap.yaml phase fields as JSON (supports --field NAME and --length for arrays)' },
  { name: 'state-dir',         category: 'Utility',  description: 'Print project-state directory (.nubos-pilot) or a validated subdir via --subdir NAME' },
  { name: 'render-template',   category: 'Utility',  description: 'Render a shipped template by name with --vars JSON (or --vars-file PATH)' },
  { name: 'render-todo',       category: 'Utility',  description: 'Render slice TODO.md rollup (checkbox view of task statuses) for a slice full-id' },
  { name: 'handoff-write',     category: 'Capture',  description: 'Write an agent-to-agent handoff note (milestone-scoped by default, global without --milestone)' },
  { name: 'handoff-read',      category: 'Capture',  description: 'Read a single handoff by id (returns frontmatter + body as JSON)' },
  { name: 'handoff-list',      category: 'Capture',  description: 'List handoffs (JSON array); filter with --for AGENT, --milestone M<NNN>, --status STATUS, --global' },
  { name: 'handoff-status',    category: 'Capture',  description: 'Update a handoff status (open|read|acted|archived)' },
  { name: 'thread-resume',     category: 'Utility',  description: 'Bump a thread markdown on resume (status OPEN→IN_PROGRESS, refresh last_resumed) via atomic write' },
  { name: 'state-incr',        category: 'Capture',  description: 'Increment a whitelisted STATE.md counter (e.g. pending_todos) under withFileLock' },

  { name: 'thread',           category: 'Utility', description: 'Cross-session thread CRUD (create/resume under .nubos-pilot/threads/)' },
  { name: 'session-aggregate',     category: 'Utility', description: 'Aggregate session metrics under withFileLock; reads pointer .last-session unless --since overrides' },
  { name: 'session-pointer-write', category: 'Utility', description: 'Atomic write of .nubos-pilot/reports/.last-session under withFileLock (ISO-8601 UTC)' },
  { name: 'workspace-scan',        category: 'Install', description: 'Scan a workspace and emit inventory JSON (full result or --summary shape for /np:new-project)' },
  { name: 'cleanup',          category: 'Utility', description: 'Archive completed milestones to .nubos-pilot/archive/v<X.Y>/' },
];

module.exports = { COMMANDS };
