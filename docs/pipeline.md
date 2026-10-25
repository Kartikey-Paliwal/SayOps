# Pipeline: GitHub CI + Vercel

```
change → git push (branch) → pull request ─┬─ GitHub Actions CI: tests, lint, build, Docker sandbox proof
                                           └─ Vercel: preview deployment with its own link
merge to main ─────────────────────────────── Vercel: production deployment (the link judges open)
```

No keys or tokens are stored in GitHub: CI needs none, and Vercel deploys through its GitHub app.
(GitHub OIDC would only be needed if a workflow had to log in to a cloud such as AWS; this one doesn't.)

## What CI checks (`.github/workflows/ci.yml`)

On every push to `main`, every pull request, and on demand:

| Job | Runs |
|---|---|
| Tests, lint and build | `npm ci` · actionlint on all workflows · shellcheck on the sandbox and task scripts · TypeScript (core, cli) · `npm test` (core + CLI, including the real-zsh hook tests) · `next build` · web types · eslint |
| Sandbox proof (Docker) | Builds the SSL sandbox image and runs the generated script in throwaway, network-less containers: normal renewal, broken config (must roll back and verify recovery), not expiring (must skip). Fails if any container is left behind. |

## One-time setup

### 1. Vercel (about 5 minutes)
1. Go to vercel.com → sign in **with GitHub**.
2. **Add New… → Project → Import** `Kartikey-Paliwal/SayOps` (grant the Vercel app access to that repo only).
3. Settings on the import screen:
   - **Root Directory:** `web`  (click *Edit*, pick `web`)
   - **Framework Preset:** Next.js (auto-detected)
   - Build / install commands: leave the defaults
   - **Environment variables: none.** The public site shows the seeded demo and the recorded example
     correction; it never calls the AI. Do **not** add `GROQ_API_KEY` there.
4. **Deploy.** The production link (e.g. `sayops.vercel.app`) is what goes in the submission.

From then on every push to `main` redeploys production automatically, and every pull request gets a
preview link in a comment on the PR.

### 2. GitHub: make CI a gate (recommended)
Repo → **Settings → Rules → Rulesets → New branch ruleset**:
- Target: `main`
- Enable **Require a pull request before merging** (0 approvals needed — you're solo)
- Enable **Require status checks to pass** → add `Tests, lint and build` and `Sandbox proof (Docker)`
- Enable **Block force pushes**

Now nothing reaches `main` (and production) unless CI is green.

## Day-to-day: changing a feature smoothly

```bash
git switch -c feature/short-name          # 1. new branch
# … make the change, run `npm test` locally …
git add -A && git commit -m "<dictate with Wispr>"
git push -u origin feature/short-name     # 2. push the branch
```

3. GitHub shows **Compare & pull request** → open the PR.
4. Wait for both CI checks ✓ and open the Vercel **preview link** from the PR to try it.
5. **Merge** → production updates in about a minute. Then locally:

```bash
git switch main && git pull
```

If CI fails, click the red ✗ → the failing step shows the exact error. Fix, commit, push again to the
same branch; the PR re-runs automatically.

## Running the same checks locally

```bash
npm test                                             # core + CLI
SAYOPS_DOCKER_TESTS=1 npm test -w @sayops/core       # + real Docker sandbox proof
npm run build -w web && (cd web && npx eslint app)   # web
```
