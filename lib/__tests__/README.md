Shared fixtures for tests that need temporary repositories and task plans.

`fixtures.cjs` exports:

- `makeTempDir(prefix)` creates a directory and registers cleanup after the test file.
- `makeRepo()` creates an isolated Git repository on `main` with a local test identity and an initial commit.
- `seedTask(root, taskId, { status, files })` writes a minimal task plan and returns its path. Defaults: `done`, no modified files.
- `captureOutput()` returns `{ stub, get }` for command stdout capture.

Keep scenario-specific state and assertions in each test. The fixtures deliberately
write their own input rather than calling the production task constructors, so a
bug in those constructors cannot silently change the test setup too.
