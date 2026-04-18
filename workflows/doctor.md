# np:doctor

Run a 5-check integrity scan of the nubos-pilot install (manifest integrity,
version mismatch, missing hooks, trapped Codex `[features]`, askUser broken).
Use `--fix` to apply auto-safe fixes; anything touching user files outside the
manifest will prompt via `askUser()` (SC-5).

```bash
node np-tools.cjs doctor "$@"
```
