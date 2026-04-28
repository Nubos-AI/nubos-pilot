const COMMANDS = [
  { name: 'state',    category: 'Utility', description: 'Print the current project state snapshot', description_de: 'Gibt aktuellen Projekt-State-Snapshot aus' },
  { name: 'help',     category: 'Utility', description: 'List available commands', description_de: 'Listet verfügbare Commands auf' },
  { name: 'init',     category: 'Utility', description: 'Dispatcher init payload for workflows', description_de: 'Dispatcher-Init-Payload für Workflows' },

  { name: 'discuss-project',     category: 'Planning', description: 'Adaptive project-context interview (writes PROJECT.md decisions)', description_de: 'Adaptives Projekt-Kontext-Interview (schreibt PROJECT.md-Entscheidungen)' },
  { name: 'discuss-phase',       category: 'Planning', description: 'Adaptive milestone-context interview (writes M<NNN>-CONTEXT.md)', description_de: 'Adaptives Milestone-Kontext-Interview (schreibt M<NNN>-CONTEXT.md)' },
  { name: 'research-phase',      category: 'Planning', description: 'Milestone-level research (WebFetch + MCP; offline fallback)', description_de: 'Milestone-Recherche (WebFetch + MCP; Offline-Fallback)' },
  { name: 'plan-milestone',      category: 'Planning', description: 'Plan a milestone: scaffolds slices + tasks', description_de: 'Plant einen Milestone: erzeugt Slices + Tasks' },
  { name: 'new-project',         category: 'Planning', description: 'Greenfield project init (PROJECT.md + REQUIREMENTS.md + M001 milestone)', description_de: 'Greenfield-Projekt-Init (PROJECT.md + REQUIREMENTS.md + M001-Milestone)' },
  { name: 'new-milestone',       category: 'Planning', description: 'Append a new milestone (M<NNN>) to an existing project', description_de: 'Hängt einen neuen Milestone (M<NNN>) an ein bestehendes Projekt an' },
  { name: 'propose-milestones',  category: 'Planning', description: 'Re-plan all not-yet-done milestones: AI proposes add/update/remove from PROJECT.md + REQUIREMENTS.md', description_de: 'Plant offene Milestones neu: KI schlägt add/update/remove aus PROJECT.md + REQUIREMENTS.md vor' },
  { name: 'agent-skills',        category: 'Planning', description: 'Print agent_skills config for a given subagent', description_de: 'Gibt agent_skills-Konfiguration für einen Subagent aus' },

  { name: 'execute-milestone',   category: 'Execution', description: 'Wave-based milestone execution — slice by slice, tasks parallel within a slice', description_de: 'Wave-basierte Milestone-Ausführung — Slice für Slice, Tasks parallel innerhalb einer Slice' },
  { name: 'commit-task',         category: 'Execution', description: 'Atomic per-task git commit via lib/git.cjs', description_de: 'Atomarer Per-Task-Git-Commit über lib/git.cjs' },
  { name: 'checkpoint',          category: 'Execution', description: 'Per-task crash-safety checkpoint CRUD (start/transition/touch/show)', description_de: 'Per-Task-Checkpoint-CRUD für Crash-Safety (start/transition/touch/show)' },
  { name: 'verify-work',         category: 'Execution', description: 'Two-pass goal-backward verification (milestone-level VERIFICATION.md)', description_de: 'Zweistufige Goal-Backward-Verifikation (Milestone-Ebene VERIFICATION.md)' },
  { name: 'add-tests',           category: 'Execution', description: 'Persist VERIFICATION Pass-cases as node:test UAT (Sentinel-preserving)', description_de: 'Persistiert VERIFICATION-Pass-Cases als node:test-UAT (Sentinel-erhaltend)' },
  { name: 'pause-work',          category: 'Execution', description: 'Stamp STATE.session.stopped_at + resume_file for explicit handoff', description_de: 'Setzt STATE.session.stopped_at + resume_file für expliziten Handoff' },
  { name: 'resume-work',         category: 'Execution', description: 'Classify session state (resume | orphan | clean) from STATE + checkpoints', description_de: 'Klassifiziert Session-Zustand (resume | orphan | clean) aus STATE + Checkpoints' },

  { name: 'skip',                category: 'Execution', description: 'Mark task status skipped (lifecycle CRUD)', description_de: 'Markiert Task als skipped (Lifecycle-CRUD)' },
  { name: 'park',                category: 'Execution', description: 'Mark task status parked (lifecycle CRUD)', description_de: 'Markiert Task als parked (Lifecycle-CRUD)' },
  { name: 'unpark',              category: 'Execution', description: 'Return a parked task to pending (lifecycle CRUD)', description_de: 'Setzt parked Task zurück auf pending (Lifecycle-CRUD)' },

  { name: 'undo',                category: 'Execution', description: 'Revert every task commit of a milestone or slice via git revert (no history rewrite)', description_de: 'Revertiert alle Task-Commits eines Milestones oder einer Slice via git revert (kein History-Rewrite)' },
  { name: 'undo-task',           category: 'Execution', description: 'Revert a single task commit and reset task status to pending', description_de: 'Revertiert einen einzelnen Task-Commit und setzt Task-Status auf pending zurück' },
  { name: 'reset-slice',         category: 'Execution', description: 'Discard in-flight task: restore working tree from HEAD, drop checkpoint, clear STATE.current_task', description_de: 'Verwirft laufenden Task: stellt Working-Tree von HEAD wieder her, löscht Checkpoint, leert STATE.current_task' },

  { name: 'doctor',              category: 'Install', description: '5-check install-integrity scan (--fix for auto-safe fixes)', description_de: '5-Check-Install-Integritäts-Scan (--fix für auto-sichere Fixes)' },
  { name: 'scan-codebase',       category: 'Install', description: 'Initial deep codebase inventory → .nubos-pilot/codebase/ skill docs', description_de: 'Initiale tiefe Codebase-Inventur → .nubos-pilot/codebase/ Skill-Docs' },
  { name: 'update-docs',         category: 'Install', description: 'Refresh stale module docs after code changes', description_de: 'Aktualisiert veraltete Modul-Docs nach Code-Änderungen' },

  { name: 'resolve-model',       category: 'Utility', description: 'Resolve agent/tier to model alias or id (Tier×Profile matrix)', description_de: 'Löst Agent/Tier zu Model-Alias oder -ID auf (Tier×Profile-Matrix)' },
  { name: 'metrics',             category: 'Utility', description: 'Record JSONL metrics entry (record | now | start-timestamp | end-timestamp)', description_de: 'Schreibt JSONL-Metrics-Eintrag (record | now | start-timestamp | end-timestamp)' },

  { name: 'validate-phase',      category: 'Review',  description: 'Nyquist validation gap-fill via np-nyquist-auditor', description_de: 'Nyquist-Validierungs-Gap-Fill über np-nyquist-auditor' },

  { name: 'add-todo',            category: 'Capture', description: 'Capture a pending todo to .nubos-pilot/todos/pending/ + increment STATE count', description_de: 'Erfasst pending Todo nach .nubos-pilot/todos/pending/ + erhöht STATE-Counter' },
  { name: 'note',                category: 'Capture', description: 'Capture a free-form note (project default, --global writes to ~/.nubos-pilot/notes/)', description_de: 'Erfasst freiformige Notiz (Projekt-Default, --global schreibt nach ~/.nubos-pilot/notes/)' },

  { name: 'askuser',         category: 'Utility', description: 'Capability-layer prompt wrapper (reads spec JSON, returns chosen label)', description_de: 'Capability-Layer-Prompt-Wrapper (liest Spec-JSON, gibt gewähltes Label zurück)' },
  { name: 'commit',          category: 'Utility', description: 'Atomic git commit wrapper with gitignore-guard', description_de: 'Atomarer Git-Commit-Wrapper mit Gitignore-Guard' },
  { name: 'config-get',      category: 'Utility', description: 'Read value from .nubos-pilot/config.json by dotted key path', description_de: 'Liest Wert aus .nubos-pilot/config.json über Dotted-Key-Pfad' },
  { name: 'lang-directive',  category: 'Utility', description: 'Print workflow language directive from config.response_language (SSOT)', description_de: 'Gibt Workflow-Sprachdirektive aus config.response_language aus (SSOT)' },
  { name: 'text-mode',       category: 'Utility', description: 'Print whether text mode is active (config.workflow.text_mode ∨ CLAUDECODE)', description_de: 'Gibt aus, ob Text-Mode aktiv ist (config.workflow.text_mode ∨ CLAUDECODE)' },
  { name: 'generate-slug',   category: 'Utility', description: 'Slugify text via lib/layout.cjs.slugify', description_de: 'Slugifiziert Text über lib/layout.cjs.slugify' },
  { name: 'stats',           category: 'Utility', description: 'Aggregated project stats — json | bar | markdown (markdown labels follow config.response_language)', description_de: 'Aggregierte Projekt-Stats — json | bar | markdown (markdown-Labels folgen config.response_language)' },
  { name: 'detect-runtime',  category: 'Utility', description: 'Print detected runtime id (claude, codex, gemini, …) — reads config.json ∨ env ∨ default', description_de: 'Gibt erkannte Runtime-ID aus (claude, codex, gemini, …) — liest config.json ∨ env ∨ Default' },
  { name: 'template-path',   category: 'Utility', description: 'Print absolute path to a package-shipped template by name (e.g. VALIDATION, milestone/CONTEXT)', description_de: 'Gibt absoluten Pfad zu paketmitgeliefertem Template per Name aus (z.B. VALIDATION, milestone/CONTEXT)' },
  { name: 'update-phase-meta', category: 'Planning', description: 'Update roadmap.yaml phase fields (name/goal/requirements/success_criteria) via JSON patch', description_de: 'Aktualisiert roadmap.yaml-Phase-Felder (name/goal/requirements/success_criteria) via JSON-Patch' },
  { name: 'phase-meta',        category: 'Planning', description: 'Read roadmap.yaml phase fields as JSON (supports --field NAME and --length for arrays)', description_de: 'Liest roadmap.yaml-Phase-Felder als JSON (unterstützt --field NAME und --length für Arrays)' },
  { name: 'state-dir',         category: 'Utility',  description: 'Print project-state directory (.nubos-pilot) or a validated subdir via --subdir NAME', description_de: 'Gibt Projekt-State-Verzeichnis (.nubos-pilot) oder validiertes Subdir per --subdir NAME aus' },
  { name: 'render-template',   category: 'Utility',  description: 'Render a shipped template by name with --vars JSON (or --vars-file PATH)', description_de: 'Rendert mitgeliefertes Template per Name mit --vars JSON (oder --vars-file PATH)' },
  { name: 'render-todo',       category: 'Utility',  description: 'Render slice TODO.md rollup (checkbox view of task statuses) for a slice full-id', description_de: 'Rendert Slice-TODO.md-Rollup (Checkbox-Ansicht der Task-Status) für eine Slice-Full-ID' },
  { name: 'handoff-write',     category: 'Capture',  description: 'Write an agent-to-agent handoff note (milestone-scoped by default, global without --milestone)', description_de: 'Schreibt Agent-zu-Agent-Handoff-Notiz (Milestone-scoped per Default, global ohne --milestone)' },
  { name: 'handoff-read',      category: 'Capture',  description: 'Read a single handoff by id (returns frontmatter + body as JSON)', description_de: 'Liest einzelnen Handoff per ID (gibt Frontmatter + Body als JSON zurück)' },
  { name: 'handoff-list',      category: 'Capture',  description: 'List handoffs (JSON array); filter with --for AGENT, --milestone M<NNN>, --status STATUS, --global', description_de: 'Listet Handoffs (JSON-Array); filtert mit --for AGENT, --milestone M<NNN>, --status STATUS, --global' },
  { name: 'handoff-status',    category: 'Capture',  description: 'Update a handoff status (open|read|acted|archived)', description_de: 'Aktualisiert Handoff-Status (open|read|acted|archived)' },
  { name: 'worktree-create',   category: 'Execution', description: 'Create an isolated git worktree for a slice (branch np/<mid>-<sid> off current HEAD) under .nubos-pilot/worktrees/', description_de: 'Erstellt isoliertes Git-Worktree für eine Slice (Branch np/<mid>-<sid> vom aktuellen HEAD) unter .nubos-pilot/worktrees/' },
  { name: 'worktree-remove',   category: 'Execution', description: 'Remove a slice worktree + delete its branch (--force / --keep-branch)', description_de: 'Entfernt Slice-Worktree + löscht zugehörigen Branch (--force / --keep-branch)' },
  { name: 'worktree-list',     category: 'Execution', description: 'List all nubos-pilot-managed slice worktrees (np/<mid>-<sid> only) as JSON', description_de: 'Listet alle nubos-pilot-verwalteten Slice-Worktrees (nur np/<mid>-<sid>) als JSON' },
  { name: 'worktree-ff-merge', category: 'Execution', description: 'Fast-forward merge a slice branch back to its base (fails hard on non-FF)', description_de: 'Fast-Forward-Merge eines Slice-Branches zurück auf Base (bricht hart ab bei non-FF)' },
  { name: 'dashboard',         category: 'Utility',   description: 'One-shot console dashboard of milestones, slices, and tasks. Read-only; flags: --json, --no-color', description_de: 'Einmaliges Konsolen-Dashboard für Milestones, Slices und Tasks. Read-only; Flags: --json, --no-color' },
  { name: 'thread-resume',     category: 'Utility',  description: 'Bump a thread markdown on resume (status OPEN→IN_PROGRESS, refresh last_resumed) via atomic write', description_de: 'Bumpt Thread-Markdown beim Resume (Status OPEN→IN_PROGRESS, aktualisiert last_resumed) via atomic write' },
  { name: 'state-incr',        category: 'Capture',  description: 'Increment a whitelisted STATE.md counter (e.g. pending_todos) under withFileLock', description_de: 'Erhöht whitelisteten STATE.md-Counter (z.B. pending_todos) unter withFileLock' },

  { name: 'thread',           category: 'Utility', description: 'Cross-session thread CRUD (create/resume under .nubos-pilot/threads/)', description_de: 'Cross-Session-Thread-CRUD (create/resume unter .nubos-pilot/threads/)' },
  { name: 'session-aggregate',     category: 'Utility', description: 'Aggregate session metrics under withFileLock; reads pointer .last-session unless --since overrides', description_de: 'Aggregiert Session-Metriken unter withFileLock; liest Pointer .last-session, außer --since überschreibt' },
  { name: 'session-pointer-write', category: 'Utility', description: 'Atomic write of .nubos-pilot/reports/.last-session under withFileLock (ISO-8601 UTC)', description_de: 'Atomares Schreiben von .nubos-pilot/reports/.last-session unter withFileLock (ISO-8601 UTC)' },
  { name: 'workspace-scan',        category: 'Install', description: 'Scan a workspace and emit inventory JSON (full result or --summary shape for /np:new-project)', description_de: 'Scannt einen Workspace und liefert Inventar-JSON (volles Ergebnis oder --summary-Shape für /np:new-project)' },

  { name: 'knowledge-index',         category: 'Utility', description: 'Build BM25-light index over .nubos-pilot/**/*.md → .nubos-pilot/state/knowledge-index.json', description_de: 'Baut BM25-Light-Index über .nubos-pilot/**/*.md → .nubos-pilot/state/knowledge-index.json' },
  { name: 'knowledge-search',        category: 'Utility', description: 'Query the knowledge index; returns top-N JSON hits (rel_path + lines + score + preview)', description_de: 'Sucht im Knowledge-Index; liefert Top-N-JSON-Treffer (rel_path + Zeilen + Score + Preview)' },
  { name: 'knowledge-stats',         category: 'Utility', description: 'Print knowledge-index size + grouping (auto-builds if missing)', description_de: 'Gibt Knowledge-Index-Größe + Gruppierung aus (baut auto bei Fehlen)' },
  { name: 'context-stats',           category: 'Utility', description: 'Aggregated context-budget stats (file counts + bytes per group, knowledge-index size)', description_de: 'Aggregierte Context-Budget-Stats (Dateien/Bytes pro Gruppe, Knowledge-Index-Größe)' },
  { name: 'session-snapshot-write',  category: 'Utility', description: 'Capture session snapshot (current_task + recent commits + open handoffs) for resume', description_de: 'Erfasst Session-Snapshot (current_task + letzte Commits + offene Handoffs) für Resume' },
  { name: 'session-snapshot-read',   category: 'Utility', description: 'Print last session snapshot as JSON', description_de: 'Gibt letzten Session-Snapshot als JSON aus' },
];

const CATEGORY_LABELS = Object.freeze({
  en: {
    Utility:   'Utility',
    Planning:  'Planning',
    Execution: 'Execution',
    Install:   'Install',
    Review:    'Review',
    Capture:   'Capture',
  },
  de: {
    Utility:   'Werkzeuge',
    Planning:  'Planung',
    Execution: 'Ausführung',
    Install:   'Installation',
    Review:    'Review',
    Capture:   'Erfassung',
  },
});

function categoryLabel(category, language) {
  const lang = (language === 'de') ? 'de' : 'en';
  const map = CATEGORY_LABELS[lang] || CATEGORY_LABELS.en;
  return map[category] || category;
}

function localizedCommands(language) {
  const useDe = language === 'de';
  return COMMANDS.map((c) => ({
    name: c.name,
    category: c.category,
    description: useDe && c.description_de ? c.description_de : c.description,
  }));
}

module.exports = { COMMANDS, CATEGORY_LABELS, categoryLabel, localizedCommands };
