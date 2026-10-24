import type { Plan, SessionEvent, SessionMeta } from "../schemas";
import { sslRenewEvents, sslRenewMeta } from "./ssl-renew";
import { sslRenewPlan } from "./ssl-renew.plan";
import { sslRenewProof } from "./ssl-renew.proof";
import type { ProofRun } from "../proof";

export interface Seed {
  id: string;
  meta: SessionMeta;
  /** raw events, before redaction (redaction runs exactly as it would on upload) */
  events: SessionEvent[];
  /** cached plan, so the demo needs no LLM key; the live compiler is tested against it */
  plan: Plan;
  summary: string;
  /** recorded sandbox proof of the generated script, or null if it has not been run */
  proof: ProofRun | null;
}

export const SEEDS: Seed[] = [
  {
    id: "ssl-renew",
    meta: sslRenewMeta,
    events: sslRenewEvents,
    plan: sslRenewPlan,
    summary: "Renew an expiring certificate on a web server: stop nginx, renew, test the config, start, check the site.",
    proof: sslRenewProof,
  },
];

export function getSeed(id: string): Seed | undefined {
  return SEEDS.find((s) => s.id === id);
}
