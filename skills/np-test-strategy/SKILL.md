---
name: np-test-strategy
description: "Quality bar for changes that add or modify behavior and therefore need tests. Triggered for executor and verifier work on any feature, fix, or refactor that changes observable behavior. Encodes the testing checklist the change MUST satisfy before commit — not a test plan to author. Language- and framework-agnostic."
user-invocable: false
---

# Test Strategy

A change that alters behavior ships with tests that lock that behavior in. Tests exist to catch the regression a future edit would introduce — not to inflate coverage. Aim for the cheapest test that would fail if the behavior broke.

## Before editing
- Read the project's existing test conventions first: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "test conventions <area>" --task $TASK_ID`. Match the established idiom (test framework, naming, directory layout, fixture/factory style, assertion helpers). Do not introduce a new test tool or pattern.

## Test the behavior, not the implementation
- Assert on observable outcomes: return values, emitted events, persisted state, responses, side effects a caller can see. Never assert on private fields, call order of internals, or how the work is done.
- Name tests by the behavior under test and its condition, not by the method name.
- A test that has to change every time you refactor internals is testing the wrong thing — delete or rewrite it.

## Pick the right level
- Unit-test pure logic and branching in isolation; this is where edge cases are cheapest to cover.
- Integration-test the seams: real DB, real serialization, real wiring between collaborators that unit tests stub away.
- Reserve e2e/end-to-end for a thin layer of critical user journeys — slow and flaky if overused.
- Push each assertion to the lowest level that can still observe the behavior.

## Cover the full surface
- Happy path, boundary/edge inputs (empty, max, zero, null, unicode, duplicate), and failure/error paths all get a test.
- Error paths assert the right error surfaces and nothing is half-committed — see [np-error-handling].
- A bug fix gets a regression test that fails before the fix and passes after; verify it actually fails on the unpatched code first.
- A refactor adds characterization tests for any untested behavior it touches before the change — see [np-refactoring].

## Mock only true externals
- Mock network, clock, randomness, filesystem, and third-party services — nothing else. Mocking your own collaborators couples tests to structure and hides integration bugs.
- Prefer real in-memory fakes (e.g. in-memory store) over mocks that merely re-assert the call you wrote.

## Determinism and speed
- No real sleeps, wall-clock reads, network calls, or reliance on test execution order. Inject the clock, freeze time, seed randomness.
- Each test sets up and tears down its own state; tests pass in isolation and in any order.
- Fast by default — a slow suite stops being run.

## Verification bar (must hold before commit)
- New or changed behavior has a test asserting its observable outcome; the test fails if the behavior is reverted.
- Happy path, at least one boundary case, and the failure/error path are each covered.
- Bug fixes include a regression test confirmed to fail before the fix.
- Tests are deterministic (no sleeps/real clock/network/order-dependence) and run at the lowest sufficient level.
- Mocks cover only true externals; no assertions on private internals.
- Suite is green and matches the project's existing test idiom; error-path coverage aligns with [np-error-handling].
