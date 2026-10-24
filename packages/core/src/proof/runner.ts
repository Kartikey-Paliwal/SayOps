/**
 * Node-only Docker proof runner. Not exported from the package index (it shells out).
 *
 * For each scenario: start a fresh, network-less, capability-reduced container from the
 * SSL sandbox image, record its state, run the generated script on the host with
 * SAYOPS_TRANSPORT=docker (so every command executes inside the container), then check the
 * container independently. The container is always removed. No real infrastructure is touched.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../schemas";
import { parseRun, type ProofCheck, type ProofRun, type ProofScenario } from "./index";

export const SANDBOX_IMAGE = "sayops-sandbox-ssl:1";
export const SANDBOX_DOMAIN = "shop.example.com";
export const SANDBOX_TOKEN = "sandbox-only-token";

export const ISOLATION = [
  "--network none",
  "--cap-drop ALL (+CHOWN DAC_OVERRIDE FOWNER SETUID SETGID NET_BIND_SERVICE KILL)",
  "--security-opt no-new-privileges",
  "--pids-limit 256",
  "--memory 256m",
  "--init",
  "removed after every scenario",
];

export interface ScenarioSpec {
  id: string;
  title: string;
  setup: string;
  expectation: string;
  env: Record<string, string>;
  expectedExit: number;
}

export const SSL_SCENARIOS: ScenarioSpec[] = [
  {
    id: "normal",
    title: "Certificate expires in 10 days",
    setup: "Sandbox cert valid for 10 days; renewal works.",
    expectation: "Backs up, renews, passes the config test, restarts nginx; the site serves the new certificate.",
    env: { SANDBOX_DAYS_LEFT: "10", SANDBOX_FAULT: "none" },
    expectedExit: 0,
  },
  {
    id: "broken-config",
    title: "Renewal produces a broken config",
    setup: "Renewal writes a private key that does not match the new certificate, so `nginx -t` fails.",
    expectation: "Stops at the config test, restores the backup, restarts nginx and verifies the site; the old certificate is served again.",
    env: { SANDBOX_DAYS_LEFT: "10", SANDBOX_FAULT: "broken-config" },
    expectedExit: 5,
  },
  {
    id: "not-expiring",
    title: "Certificate still valid for 60 days",
    setup: "Sandbox cert valid for 60 days.",
    expectation: "The spoken condition (“only renew if it's under 30 days”) skips the whole task; nothing is touched.",
    env: { SANDBOX_DAYS_LEFT: "60", SANDBOX_FAULT: "none" },
    expectedExit: 0,
  },
];

function sh(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeoutMs ?? 60_000, input: opts.input, env: opts.env ?? process.env });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Runs a command inside the sandbox and returns trimmed stdout. */
function inBox(id: string, script: string) {
  return sh("docker", ["exec", "-i", id, "bash", "-s"], { input: `set -uo pipefail\n${script}\n` });
}

export function dockerAvailable(): { ok: true; version: string } | { ok: false; reason: string } {
  const r = sh("docker", ["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"], { timeoutMs: 15_000 });
  return r.status === 0 ? { ok: true, version: r.stdout.trim() } : { ok: false, reason: (r.stderr || "docker not found").trim() };
}

export function ensureImage(sandboxDir: string): string {
  let r = sh("docker", ["image", "inspect", "--format", "{{.Id}}", SANDBOX_IMAGE]);
  if (r.status !== 0) {
    const b = sh("docker", ["build", "-q", "-t", SANDBOX_IMAGE, sandboxDir], { timeoutMs: 600_000 });
    if (b.status !== 0) throw new Error(`docker build failed: ${b.stderr}`);
    r = sh("docker", ["image", "inspect", "--format", "{{.Id}}", SANDBOX_IMAGE]);
  }
  return r.stdout.trim();
}

const STATE = `
cd /etc
tree=$( { find letsencrypt -printf '%p|%y|%m|%u|%l\\n' | LC_ALL=C sort; find letsencrypt -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum; } | sha256sum | cut -c1-16)
fp=$(openssl s_client -connect 127.0.0.1:443 -servername ${SANDBOX_DOMAIN} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 | tr -d : | cut -c1-16)
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer ${SANDBOX_TOKEN}' https://${SANDBOX_DOMAIN} || true)
pid=$(cat /run/nginx.pid 2>/dev/null || echo none)
running=$(pgrep -x nginx >/dev/null && echo yes || echo no)
valid30=$(openssl s_client -connect 127.0.0.1:443 -servername ${SANDBOX_DOMAIN} </dev/null 2>/dev/null | openssl x509 -noout -checkend 2592000 >/dev/null 2>&1 && echo yes || echo no)
backups=$(ls -d /etc/letsencrypt.sayops-bak.* 2>/dev/null | wc -l | tr -d ' ')
failed=$(ls -d /etc/letsencrypt.sayops-failed.* 2>/dev/null | wc -l | tr -d ' ')
printf 'tree=%s\\nfp=%s\\ncode=%s\\npid=%s\\nrunning=%s\\nvalid30=%s\\nbackups=%s\\nfailed=%s\\n' "$tree" "\${fp:-none}" "$code" "$pid" "$running" "$valid30" "$backups" "$failed"
`;

type State = Record<"tree" | "fp" | "code" | "pid" | "running" | "valid30" | "backups" | "failed", string>;

function snapshot(id: string): State {
  const r = inBox(id, STATE);
  return Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=", 2))) as State;
}

function check(label: string, expected: string, actual: string, ok = expected === actual): ProofCheck {
  return { label, expected, actual, ok };
}

/** Independent checks per scenario: what must be true inside the sandbox, whatever the script said. */
function checksFor(spec: ScenarioSpec, before: State, after: State, parsed: ReturnType<typeof parseRun>): ProofCheck[] {
  const site = check("Site answers over HTTPS with the test token", "200", after.code);
  const nginx = check("nginx is running", "yes", after.running);
  if (spec.id === "normal") {
    return [
      site, nginx,
      check("Served certificate was replaced", `≠ ${before.fp}`, after.fp, after.fp !== before.fp && after.fp !== "none"),
      check("Served certificate is valid for 30+ more days", "yes", after.valid30),
      check("Backup of /etc/letsencrypt was made", "1", after.backups),
      check("No failed state was left behind", "0", after.failed),
    ];
  }
  if (spec.id === "broken-config") {
    const s5 = parsed.steps.find((s) => s.command === "sudo nginx -t");
    return [
      check("The config test caught the broken renewal", "failed", s5?.status ?? "not_run"),
      check("Script reported recovery only after its checks passed", "verified", parsed.recovery ?? "none"),
      site, nginx,
      check("The original certificate is served again", before.fp, after.fp),
      check("/etc/letsencrypt is identical to before the run", before.tree, after.tree),
      check("The failed state was kept for inspection", "1", after.failed),
    ];
  }
  return [
    check("The whole task was skipped by the spoken condition", "S1", parsed.skippedAll ?? "none"),
    site,
    check("nginx was never restarted (same process)", before.pid, after.pid),
    check("/etc/letsencrypt is unchanged", before.tree, after.tree),
    check("No backup was made (nothing to protect)", "0", after.backups),
  ];
}

export function runScenario(plan: Plan, script: string, spec: ScenarioSpec, hostParams: string[]): ProofScenario {
  const run = sh("docker", [
    "run", "-d", "--rm", "--init", "--network", "none",
    "--add-host", `${SANDBOX_DOMAIN}:127.0.0.1`,
    "--cap-drop", "ALL", ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "NET_BIND_SERVICE", "KILL"].flatMap((c) => ["--cap-add", c]),
    "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "256m",
    "--label", "sayops.proof=1",
    ...Object.entries({ SANDBOX_DOMAIN, ...spec.env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    SANDBOX_IMAGE,
  ]);
  if (run.status !== 0) throw new Error(`could not start sandbox: ${run.stderr}`);
  const id = run.stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), "sayops-proof-"));
  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      ready = sh("docker", ["exec", id, "test", "-f", "/run/sayops-sandbox-ready"]).status === 0;
      if (!ready) spawnSync("sleep", ["0.2"]);
    }
    if (!ready) throw new Error(`sandbox did not become ready: ${sh("docker", ["logs", id]).stderr}`);

    const before = snapshot(id);
    const scriptPath = join(dir, "task.sh");
    const eventsPath = join(dir, "events.log");
    writeFileSync(scriptPath, script);
    writeFileSync(eventsPath, "");
    const t0 = Date.now();
    // stdout and stderr share one pipe so the recorded log keeps the real order.
    const r = sh("/bin/bash", ["-c", 'exec /bin/bash "$0" "$@" 2>&1', scriptPath, ...hostParams], {
      timeoutMs: 180_000,
      env: {
        PATH: process.env.PATH ?? "",
        SAYOPS_TRANSPORT: "docker",
        SAYOPS_DOCKER_CONTAINER: id,
        SAYOPS_EVENTS: eventsPath,
        SAYOPS_RUN_ID: `proof-${spec.id}`,
        AUTH_TOKEN: SANDBOX_TOKEN,
      },
    });
    const durationMs = Date.now() - t0;
    const after = snapshot(id);
    const events = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
    const output = r.stdout.replaceAll(SANDBOX_TOKEN, "<sandbox token>").replace(/\s+$/, "");
    const parsed = parseRun(plan, events, output);
    const checks = checksFor(spec, before, after, parsed);
    return {
      id: spec.id,
      title: spec.title,
      setup: spec.setup,
      expectation: spec.expectation,
      expectedExit: spec.expectedExit,
      exitCode: r.status,
      durationMs,
      skippedAll: parsed.skippedAll,
      steps: parsed.steps,
      rollback: parsed.rollback,
      recovery: parsed.recovery,
      verify: parsed.verify,
      checks,
      passed: r.status === spec.expectedExit && checks.every((c) => c.ok),
      log: output.split("\n"),
    };
  } finally {
    sh("docker", ["rm", "-f", id]);
    rmSync(dir, { recursive: true, force: true });
  }
}

export function runProof(input: {
  plan: Plan;
  script: string;
  sessionId: string;
  sandboxDir: string;
  scenarios?: ScenarioSpec[];
}): ProofRun {
  const docker = dockerAvailable();
  if (!docker.ok) throw new Error(`Docker is not available: ${docker.reason}`);
  const imageId = ensureImage(input.sandboxDir);
  const host = input.plan.remote_host ?? "HOST";
  const params: Record<string, string> = { [host]: "sandbox-web", DOMAIN: SANDBOX_DOMAIN, AUTH_TOKEN: "<sandbox token, masked>" };
  const hostParams = ["--host", "sandbox-web", "--domain", SANDBOX_DOMAIN];
  return {
    generatedAt: new Date().toISOString(),
    sessionId: input.sessionId,
    planTitle: input.plan.title,
    scriptSha256: createHash("sha256").update(input.script).digest("hex"),
    environment: { docker: docker.version, image: SANDBOX_IMAGE, imageId: imageId.replace(/^sha256:/, "").slice(0, 12), isolation: ISOLATION },
    params,
    scenarios: (input.scenarios ?? SSL_SCENARIOS).map((s) => runScenario(input.plan, input.script, s, hostParams)),
  };
}
