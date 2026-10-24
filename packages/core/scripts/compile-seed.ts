/**
 * Live compile of the SSL seed against Groq.
 *   npm run compile:seed -w @sayops/core
 * Reads GROQ_API_KEY (and optional LLM_MODEL) from the repo-root .env or web/.env.local.
 */
import { fileURLToPath } from "node:url";
import { align, compile, CompileError, groq, redactEvents, sslRenewEvents, sslRenewMeta, sslRenewPlan } from "../src";

for (const f of ["../../../.env", "../../../web/.env.local"]) {
  try { process.loadEnvFile(fileURLToPath(new URL(f, import.meta.url))); } catch { /* optional */ }
}
const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("GROQ_API_KEY is not set. Add it to sayops/.env (git-ignored).");
  process.exit(1);
}

const { events, count } = redactEvents(sslRenewEvents);
const session = align(events);
const t0 = Date.now();
try {
  const r = await compile(groq({ apiKey, model: process.env.LLM_MODEL || undefined }), { title: sslRenewMeta.title, session });
  console.log(JSON.stringify(r.plan, null, 2));
  console.error(`\n✔ ${r.model} · ${r.attempts} attempt(s) · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${count} redacted`);
  console.error(`  tokens: ${r.usage.map((u) => u.total_tokens).join(" + ")}`);
  console.error(`  radar: ${JSON.stringify(r.radarHits)}`);

  // Compare the things the demo depends on with the reference plan.
  const gap = r.plan.findings.find((f) => f.type === "said_not_done");
  const guard = r.plan.steps.find((s) => /nginx -t/.test(s.run));
  const checks: [string, boolean][] = [
    ["said-not-done backup finding", !!gap && /back ?up/i.test(gap.detail)],
    ["added backup step", r.plan.steps.some((s) => s.added && /cp -a|backup|bak/i.test(s.run))],
    ["nginx -t guard aborts", !!guard && guard.on_fail !== "continue"],
    ["30-day skip condition", r.plan.steps.some((s) => s.condition?.why === "N2")],
    ["rollback present", r.plan.rollback.length > 0],
    ["verify present", r.plan.verify.length > 0],
    ["HOST/DOMAIN params", ["web-1", "shop.example.com"].every((v) => r.plan.params.some((p) => p.from === v))],
    ["same step count as reference", r.plan.steps.length === sslRenewPlan.steps.length],
  ];
  for (const [name, ok] of checks) console.error(`  ${ok ? "✔" : "✖"} ${name}`);
} catch (e) {
  if (e instanceof CompileError) console.error(`✖ ${e.message}\n- ${e.errors.join("\n- ")}`);
  else console.error(e);
  process.exit(1);
}
