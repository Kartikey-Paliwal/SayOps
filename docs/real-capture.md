# Real capture: rotate the local dev HTTPS certificate

This is the real, recorded session for the submission. **You** run it and **you** say the reasons
with Wispr Flow. Nothing here touches a production system: everything lives in
`~/sayops-real-task/` and one local Caddy container bound to `127.0.0.1:8443`. Undo it all with
`docs/real-task/teardown.sh`.

Every command below was dry-checked on this Mac in a scratch folder (different container and port)
on 24 Oct 2026. That dry check is not the recording; the recording is what you do below.

## 0. Once: install the CLI

```bash
cd ~/Desktop/sayops && npm run build -w sayops && npm link -w sayops
```

Check it: `sayops --version` prints `0.1.0`. To uninstall later: `npm unlink -g sayops`.

## 1. Prepare the throwaway environment (not recorded)

```bash
~/Desktop/sayops/docs/real-task/prepare.sh
```

It creates `~/sayops-real-task/` with a dev certificate that **expires in 5 days**, a Caddyfile, and
starts the `sayops-devcert` container serving `https://localhost:8443`. It refuses to run if either
already exists.

## 2. Start recording

Open a **new terminal tab** (zsh) for the session, then:

```bash
cd ~/sayops-real-task
sayops start "Rotate the local dev HTTPS certificate"
eval "$(sayops hook zsh)"
```

The second line turns on capture **in this tab only**. Nothing is written to `~/.zshrc`.
From now on every command, its exit code, duration and folder are recorded (secrets redacted
before they are saved). Start a command with a space to keep it out of the recording.

## 3. Do the task, explaining as you go

After each command, type `why`, press Enter, **hold your Wispr Flow key (fn)** and say the reason in
your own words, then press Enter. The lines in *italics* are only suggestions of what to talk about.

1. ```bash
   openssl x509 -in certs/localhost.crt -noout -enddate
   ```
   `why` — *who uses this cert, and that you only rotate it when it has less than 30 days left.*

2. ```bash
   openssl x509 -in certs/localhost.crt -noout -checkend 2592000
   ```
   Expected: `Certificate will expire`, **exit 1**. That failure is the signal to rotate.
   `why` — *this is the 30-day check; a non-zero exit means it's due.*

3. ```bash
   openssl req -x509 -newkey rsa:2048 -nodes -days 90 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" -keyout certs/localhost.key -out certs/localhost.crt
   ```
   `why` — *generate the new 90-day cert. Mention your habit, e.g. that you always back up the old
   cert folder first.*
   **Said-vs-did test (optional, be honest about it):** if you say you back up first but don't run
   a backup command, SayOps should catch it. If you'd rather actually back up, run
   `cp -a certs certs.bak` *before* this step; then SayOps should find no gap. Either is a real result.

4. ```bash
   chmod 644 certs/localhost.key
   ```
   `why` — *the container needs to read the key (throwaway dev key only).*

5. ```bash
   [ "$(openssl x509 -noout -modulus -in certs/localhost.crt)" = "$(openssl rsa -noout -modulus -in certs/localhost.key)" ]
   ```
   Expected: exit 0. `why` — *always make sure the key matches the cert, or Caddy won't start.*

6. ```bash
   docker exec sayops-devcert caddy validate --config /etc/caddy/Caddyfile
   ```
   Expected: `Valid configuration`. `why` — *test the config before restarting, or the site goes down.*

7. ```bash
   docker restart sayops-devcert
   ```
   `why` — *restart so Caddy loads the new cert; if it doesn't come back, put the old cert back.*

8. ```bash
   curl -sS --cacert certs/localhost.crt https://localhost:8443
   ```
   Expected: `sayops dev site ok`. `why` — *confirm the site answers over HTTPS with the new cert.*

Made a typo? Just run the right command; SayOps keeps the retry and drops the failed typo.
Need to explain an earlier command? `why --for C3 "your reason"`.

## 4. Stop and review

```bash
sayops stop
sayops show
eval "$(sayops unhook zsh)"
```

`sayops stop` prints the session id, counts and the review link. `sayops show` prints exactly what
was stored (already redacted). The last line removes the hooks from this tab.

## 5. Compile and open

```bash
sayops compile --env-file ~/Desktop/sayops/.env
```

Then, with the web app running (`cd ~/Desktop/sayops && npm run dev -w web -- -p 3100`), open the
`http://localhost:3100/local/<id>` link it prints.

## 5b. Talk to fix it (optional, great for the video)

```bash
sayops fix --env-file ~/Desktop/sayops/.env
```

At the `fix>` prompt, hold fn and say a change, e.g. *"also print a message when it's done, and run this
every Monday at 9"*. SayOps saves plan v2 and prints exactly what changed. The same box is on the
`/local/<id>` page.

## 6. Undo the task

```bash
~/Desktop/sayops/docs/real-task/teardown.sh
```

Removes the `sayops-devcert` container and `~/sayops-real-task/`. Your recorded session stays in
`~/.sayops/sessions/<id>/` (delete that folder if you ever want it gone).

## What counts as evidence

Only what is in `~/.sayops/sessions/<id>/`: `events.jsonl` (commands, exit codes, durations,
folders, your explanations — redacted), `session.json`, `upload.json`, and after compiling
`plan.json`. Send the session id and the output of `sayops show` for review; nothing is
reconstructed or filled in afterwards.
