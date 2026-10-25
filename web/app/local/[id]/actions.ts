"use server";

import { groq } from "@sayops/core";
import { applyCorrection, CorrectionFailed, listPlanVersions, sayopsHome, SESSION_ID, StoreError } from "@sayops/core/store";
import { refresh } from "next/cache";
import { headers } from "next/headers";

export type CorrectionActionResult =
  | { ok: true; version: number; previous: number }
  | { ok: false; error: string; latest: number | null };

/** Server environment only (web/.env.local when running locally). Never from the client, never from a file path. */
function groqKey(): string | undefined {
  return process.env.GROQ_API_KEY;
}

/**
 * Talk-to-fix for a session recorded on this machine. Local only: it spends model credits and
 * writes ~/.sayops, so it refuses any request that is not addressed to localhost.
 */
export async function applyCorrectionAction(id: string, text: string): Promise<CorrectionActionResult> {
  const host = ((await headers()).get("host") ?? "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    return { ok: false, error: "Corrections can only be applied on the machine that recorded the session.", latest: null };
  }
  if (typeof id !== "string" || !SESSION_ID.test(id)) return { ok: false, error: "Not a session id.", latest: null };
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "The correction is empty: say what should change.", latest: null };
  if (text.length > 1000) return { ok: false, error: "The correction is longer than 1000 characters.", latest: null };

  const home = sayopsHome();
  const latest = () => {
    try {
      return listPlanVersions(home, id).at(-1)?.version ?? null;
    } catch {
      return null;
    }
  };
  const apiKey = groqKey();
  if (!apiKey) return { ok: false, error: "GROQ_API_KEY is not set for the web app. Put it in web/.env.local and restart the dev server, or use: sayops fix", latest: latest() };

  try {
    const r = await applyCorrection({ home, id, text, llm: groq({ apiKey, model: process.env.LLM_MODEL || undefined }) });
    refresh();
    return { ok: true, version: r.next.version, previous: r.previous.version };
  } catch (e) {
    const v = latest();
    if (e instanceof CorrectionFailed) {
      refresh(); // the failed attempt is recorded in the history
      return { ok: false, error: `Could not apply the correction, so v${v} is still the latest plan. ${e.message}`, latest: v };
    }
    if (e instanceof StoreError) return { ok: false, error: e.message, latest: v };
    return { ok: false, error: `The model call failed: ${(e as Error).message}`, latest: v };
  }
}
