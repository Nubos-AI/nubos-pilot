# Phase 5: Example Feature — Context

**Gathered:** 2026-04-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Ship a user-facing feature X that lets users do Y within the existing Z
module. This phase delivers end-to-end behaviour: data layer, API route,
UI component, and a minimal visual regression test. It does NOT cover
multi-tenant isolation, audit logging, or the admin-side moderation queue
(those are explicitly deferred to later phases).

Scope anchor: the ROADMAP entry for Phase 5 names "feature X" — anything
that reads like "feature X plus admin overlay" belongs in a future phase.
</domain>

<decisions>
## Implementation Decisions

### Presentation
- **D-01:** Card-based layout using the existing `Card` component from
  `src/components/ui/Card.tsx`. Reuses shadow/rounded variants.
- **D-02:** Content density is comfortable (48px row height) — matches the
  Messages module established in Phase 3. No "compact" variant in this release.
- **D-03:** Empty-state illustration comes from the existing `EmptyState`
  component. Copy: "No items yet — come back later."

### Loading & Pagination
- **D-04:** Infinite scroll via `useInfiniteQuery` (TanStack Query) — pattern
  locked in Phase 4. No page numbers, no "load more" button.
- **D-05:** Loading skeleton shows 3 placeholder cards while the first page
  fetches. Subsequent pages fetch transparently on scroll.

### Error Handling
- **D-06:** Network error falls through to a retry button inline with the
  error text. No full-page error takeover — the rest of the UI stays usable.
- **D-07:** On 4xx responses, log once to Sentry and surface a generic
  "Something went wrong" to the user. No leaking of backend error text.

### Mobile
- **D-08:** Pull-to-refresh on mobile (react-native gesture handler already
  wired for the Messages module). Desktop relies on browser reload.

### Claude's Discretion
- Exact copy for the loading skeleton — as long as it matches the existing
  "Messages" module voice.
- Precise number of placeholder cards (currently 3) — adjust if layout
  breaks at common viewport widths.
- Choice of date-formatting library — continue using whichever Phase 3
  settled on.

### Folded Todos
- TODO-42 "Rename `feedItems` → `feedEntries` across state slice" — folded
  into this phase because the new UI touches that state slice anyway.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope & Product
- `.planning/ROADMAP.md` §Phase 5 — goal, success criteria, requirements.
- `.planning/REQUIREMENTS.md` §FEAT-05..FEAT-09 — per-requirement acceptance.
- `docs/product/feature-x-spec.md` — product narrative referenced by the user
  during discussion ("build it like the spec says, but use our Card
  component").

### Prior-Phase Decisions
- `.planning/phases/03-messages/03-CONTEXT.md` §decisions — Card component
  patterns, comfortable density, EmptyState component usage.
- `.planning/phases/04-state-layer/04-CONTEXT.md` §decisions — useInfiniteQuery
  convention, pagination prohibition.

### Architectural Invariants
- `docs/adr/0007-no-client-side-error-text.md` — forbids surfacing raw
  backend error strings to the user.
- `docs/adr/0012-mobile-gesture-handler.md` — standardises pull-to-refresh
  implementation.

### Existing Code Surfaces
- `src/components/ui/Card.tsx` — reused for the feature's list items.
- `src/components/ui/EmptyState.tsx` — reused for zero-items state.
- `src/hooks/useInfiniteQuery.ts` — standard pagination hook.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Card` component (`src/components/ui/Card.tsx`) — shadow + rounded
  variants already match the design spec for Phase 5.
- `EmptyState` component (`src/components/ui/EmptyState.tsx`) — accepts a
  headline + body + optional CTA. Use as-is.
- `useInfiniteQuery` hook (`src/hooks/useInfiniteQuery.ts`) — thin wrapper
  over TanStack Query with our auth headers baked in.
- `formatDate` util (`src/lib/formatDate.ts`) — date formatting convention
  standardised in Phase 3; use for timestamp display.

### Established Patterns
- State lives in a Zustand slice named after the feature (`feedSlice.ts`
  precedent). Place new slice under `src/state/`.
- API routes live under `app/api/<feature>/route.ts`. Pattern set in
  Phase 2.
- Server-side data access goes through a typed client in `src/db/` — do
  NOT hand-roll SQL. Use the existing Drizzle schema under `src/db/schema/`.
- Error boundaries wrap feature subtrees at the route level, not the
  component level.

### Integration Points
- Route: `app/(main)/feed/page.tsx` already exists as a placeholder.
- Nav entry: `src/components/layout/NavBar.tsx` has a commented-out
  "Feed" link — uncomment when shipping.
- State hydration: `src/app/providers.tsx` — add the new slice there.

</code_context>

<specifics>
## Specific Ideas

- User explicitly referenced `docs/product/feature-x-spec.md` during
  discussion — "build it like that spec, but use our Card component".
- User wants the empty-state illustration from the existing `EmptyState`
  component, NOT a custom SVG.
- User called out the Messages module as the canonical example for density
  and interaction patterns — the Feed should feel like "a cousin of
  Messages", not a new design language.
- "Pull to refresh on mobile, yes; full-page spinner on desktop, no."

</specifics>

<deferred>
## Deferred Ideas

Ideas that came up but belong in other phases. Preserved here so they don't
get lost.

- **Admin moderation queue** — would let staff hide feed items. Needs its
  own phase; touches authorization + admin UI both.
- **Search / filtering** — natural next feature but is a new capability,
  not a clarification of Phase 5. Future phase.
- **Bookmarking** — user mentioned wanting to save items for later. Clear
  new capability. Deferred.
- **Multi-tenant isolation** — out of scope for Phase 5; waiting on the
  tenant-scoping infrastructure slated for Phase 8.
- **Real-time updates (websocket push)** — discussed briefly. Decided to
  ship polling first; websocket work is its own phase because the push
  infrastructure does not exist yet.

### Reviewed Todos (not folded)
- TODO-51 "Add telemetry to nav clicks" — orthogonal to Phase 5. Deferred.
- TODO-78 "Migrate auth context to React 19 `use()`" — cross-cutting
  refactor. Deferred.

</deferred>

---

*Phase: 05-example-feature*
*Context gathered: 2026-04-15*
