---
phase: {{phase}}
generated: {{timestamp}}
generator: np:ui-phase
---

# Phase {{phase}} — UI Spec

This document is the UI design contract for Phase {{phase}}. It locks the
six visual pillars BEFORE the planner creates tasks so execution stays
consistent with brand and system. Re-read this file in full before any
task that modifies user-facing surface.

## 1. Spacing

Spacing scale, layout grid, vertical rhythm, and breakpoint math.

{{spacing_rules}}

## 2. Typography

Type scale, font stacks, weights, line-heights, and letter-spacing.
Include usage rules (headings vs body, emphasis, numeric alignment).

{{typography_scale}}

## 3. Color

Palette with token names, contrast contracts (WCAG AA/AAA evidence), and
semantic intent (danger, warning, info, success, neutral). Include
dark/light variants if applicable.

{{color_palette}}

## 4. Copywriting

Voice, tone, persona. Reusable microcopy patterns (CTAs, empty states,
errors, confirmations). Include profanity / tone guardrails.

{{voice_and_tone}}

## 5. Design System

Component inventory from the chosen design system (shadcn/ui, Radix,
Material, bespoke). Which components are already-wired vs TODO. Which
design-tokens map to which Tailwind/CSS-variable name.

{{design_system_components}}

## 6. Components

Phase-specific component contracts: prop signature, accessibility
contract (ARIA roles/labels, keyboard nav), state machine, edge cases.

{{component_inventory}}

## Checklist

- [ ] Spacing scale defined with evidence (Section 1)
- [ ] Typography scale + font-stack pinned (Section 2)
- [ ] Color palette with contrast contract (Section 3)
- [ ] Voice and microcopy patterns captured (Section 4)
- [ ] Design-system inventory with token map (Section 5)
- [ ] Component contracts per phase (Section 6)
