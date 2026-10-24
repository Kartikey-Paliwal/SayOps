import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { align, redactEvents, renderScript, sourceTexts, sslRenewEvents, sslRenewPlan } from "../src";
import { dockerAvailable, runProof } from "../src/proof/runner";

// Real containers. Opt-in so `npm test` stays fast: SAYOPS_DOCKER_TESTS=1 npm test
const enabled = process.env.SAYOPS_DOCKER_TESTS === "1";
const docker = enabled ? dockerAvailable() : { ok: false as const, reason: "set SAYOPS_DOCKER_TESTS=1 to run" };
if (!docker.ok) console.warn(`docker proof tests skipped: ${docker.reason}`);

describe.skipIf(!docker.ok)("sandbox proof (Docker)", () => {
  it("proves normal renewal, broken-config rollback and the skip condition", () => {
    const session = align(redactEvents(sslRenewEvents).events);
    const script = renderScript(sslRenewPlan, { sessionId: "ssl-renew", version: 1, sources: sourceTexts(session) });
    const run = runProof({ plan: sslRenewPlan, script, sessionId: "ssl-renew", sandboxDir: fileURLToPath(new URL("../../../sandbox/ssl", import.meta.url)) });
    const by = Object.fromEntries(run.scenarios.map((s) => [s.id, s]));

    expect(by.normal.exitCode).toBe(0);
    expect(by["broken-config"].exitCode).toBe(5);
    expect(by["broken-config"].steps.find((s) => s.id === "S5")?.status).toBe("failed");
    expect(by["broken-config"].recovery).toBe("verified");
    expect(by["not-expiring"].skippedAll).toBe("S1");
    for (const s of run.scenarios) {
      expect(s.checks.filter((c) => !c.ok), s.id).toEqual([]);
      expect(s.passed).toBe(true);
    }
  }, 300_000);
});
