---
name: np-accessibility-audit
description: "Quality bar for changes that add or modify any UI surface — components, pages, forms, or markup (.tsx/.jsx/.vue/.svelte, views/components/pages). Triggered for executor work on user-facing rendering; encodes a WCAG 2.x AA checklist the change MUST satisfy before commit, not an audit document to author. Language- and framework-agnostic."
user-invocable: false
---

# Accessibility Audit

Any UI you build or touch must be usable with a keyboard, a screen reader, and at low vision. This is a bar to meet, not a report to write. Automated checkers catch only part of WCAG — reason about the rest.

## Before editing
- Read existing conventions: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "accessibility component conventions" --task $TASK_ID`.

## Semantics first
- Use real elements: `button` for actions, `a[href]` for navigation, `nav`/`main`/`header`/`footer` landmarks, real list and table markup. Never a `div`/`span` with a click handler when an element exists.
- One `h1` per page; headings descend in order (no skipped levels) and describe structure, not styling.
- Reach for ARIA only to fill a gap native HTML cannot. Wrong or redundant ARIA is worse than none — no `role="button"` on a `button`, no `aria-label` that contradicts visible text.

## Keyboard and focus
- Everything interactive is reachable and operable by keyboard alone, in a logical tab order; no keyboard trap.
- Focus is always visible — never strip the outline without an equal-or-better replacement.
- Custom widgets implement their expected keys (Esc closes, arrows move within a group, Enter/Space activate).
- Manage focus on change: move focus into an opened modal and restore it on close; move focus on route change so it doesn't sit on stale content.

## Names, contrast, and signal
- Every input has a programmatically associated label (`label[for]` or wrapping). Icon-only controls get an accessible name.
- Meaningful images have descriptive `alt`; decorative images have empty `alt=""`. Use `aria-label` only when there is no visible text to name the element.
- Text contrast meets AA: 4.5:1 normal, 3:1 large text and UI/graphical boundaries.
- Never use color as the only carrier of meaning — pair it with text, icon, or shape (errors, status, required fields).

## Dynamic and motion
- Form errors are associated with their field (`aria-describedby`) and announced; do not signal validity by color alone.
- Asynchronous updates (toasts, async results, validation) are announced via a live region.
- Respect `prefers-reduced-motion`: gate non-essential animation and avoid motion that could trigger vestibular issues.

## Verification bar (must hold before commit)
- The full flow is operable with keyboard only — tab order is logical, focus stays visible, nothing is trapped.
- Run an automated checker (axe/Lighthouse or equivalent) with zero violations, then manually confirm what it cannot: semantics, focus order, names, and meaningful contrast.
- Every control and image has an accessible name; no information is conveyed by color alone.
- Modal/route/async transitions manage focus and announce updates correctly.
- Cross-check visual choices against [np-web-design-guidelines] and [np-frontend-design]; accessibility constrains, never contradicts, them.
