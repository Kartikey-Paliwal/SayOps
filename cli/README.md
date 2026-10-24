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
```

- Data: `$SAYOPS_HOME` (default `~/.sayops`), folders 0700, files 0600.
- Commands and explanations are redacted before they are written; raw text is never stored.
  Environment variables are never captured.
- A leading space keeps a command out of the recording; `why`/`sayops` commands are never recorded.
- zsh only for now (bash capture is not supported yet).
- Exit codes: 0 ok · 1 error · 2 bad usage. The background `_cmd` used by the hook never fails loudly.

Full walkthrough with a real task: `docs/real-capture.md`.
