# sayops CLI

Record an ops chore once, with the spoken reasons, and turn it into guarded, tested automation.

```bash
npm run build -w sayops && npm link -w sayops   # install (undo: npm unlink -g sayops)
sayops start "what you're about to do"
eval "$(sayops hook zsh)"                        # capture in THIS shell only; nothing written to ~/.zshrc
# … run commands; after one, type `why` and dictate the reason with Wispr Flow …
sayops stop
eval "$(sayops unhook zsh)"                      # remove the hooks (or close the terminal)
sayops show && sayops compile --env-file ~/Desktop/sayops/.env
sayops fix --env-file ~/Desktop/sayops/.env       # talk-to-fix: dictate a correction at fix>, get plan v2 + what changed
```

Talk-to-fix keeps every plan version (`~/.sayops/sessions/<id>/plans/v<N>.json`) and every correction
(`corrections.json`, redacted). A correction that fails validation is recorded as failed and the previous
version stays the latest. Anything a correction adds must be reviewed before the plan is "ready".
In the local web app (`/local/<id>`) the same correction box works live when `web/.env.local` has `GROQ_API_KEY`.

- Data: `$SAYOPS_HOME` (default `~/.sayops`), folders 0700, files 0600.
- Commands and explanations are redacted before they are written; raw text is never stored.
  Environment variables are never captured.
- A leading space keeps a command out of the recording; `why`/`sayops` commands are never recorded.
- zsh only for now (bash capture is not supported yet).
- Exit codes: 0 ok · 1 error · 2 bad usage. The background `_cmd` used by the hook never fails loudly.

Full walkthrough with a real task: `docs/real-capture.md`.
