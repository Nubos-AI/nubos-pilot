# Roadmap: Minimal Fixture

## Overview

Minimal hand-authored ROADMAP for roadmap-parser regression tests.

## Phases

- [x] **Phase 1: Foundation** - Lay the base
- [ ] **Phase 2.1: Hotfix** - Urgent insertion (INSERTED)
- [ ] **Phase 3: Core** - Main build

## Phase Details

### Phase 1: Foundation
**Goal**: Establish the scaffolding so later phases have something to build on.
**Depends on**: Nothing (first phase)
**Requirements**: F-01, F-02
**Success Criteria** (what must be TRUE):
  1. Scaffolding directory exists with README
  2. Initial ADR set is committed

**Plans**: 01-01 (complete)

### Phase 2.1: Hotfix
**Goal**: Patch the critical issue that blocked Phase 2.
**Depends on**: Phase 2
**Requirements**: F-03
**Plans**: TBD

### Phase 3: Core
**Goal**: Build the core library modules that every workflow depends on.
**Depends on**: Phase 2
**Requirements**: L-01, L-02, L-03
**Success Criteria** (what must be TRUE):
  1. Core parser exports the public surface
  2. All unit tests pass with ≥70% coverage
  3. Zero runtime dependencies added

**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 1/1 | Complete | 2026-04-14 |
| 2.1. Hotfix | 0/TBD | Not started | - |
| 3. Core | 0/TBD | Not started | - |

---
*Minimal roadmap fixture for lib/roadmap.test.cjs*
