"use server";

import {
  CompileError, ExplainError, explainStep, getSeed, groq, LlmError, LruCache, MAX_REASON_CHARS, Throttle, withSpokenReason,
  type NarrationKind, type Plan,
} from "@sayops/core";
import { headers } from "next/headers";

export type SayItResult =
  | { ok: true; plan: Plan; narrationSeq: number; kind: NarrationKind | null; model: string; cached: boolean }
  | { ok: false; reason: "off" | "busy" | "limit" | "invalid" | "failed"; message: string; retryAfterS?: number };

// Public endpoint on Groq's FREE tier (≈ 8K tokens/min shared by every visitor). Per-instance guards:
// a few tries per visitor, a cache for repeated sentences, and a site-wide pause after a 429.
const throttle = new Throttle({ perMinute: 3, perDay: 10 });
const cache = new LruCache<Extract<SayItResult, { ok: true }>>(100);

/**
 * "Say it yourself": a visitor adds one spoken reason to a recorded command of a seeded demo and
 * gets the recompiled plan back. Nothing is stored or logged; the result is only displayed.
 */
export async function sayItYourselfAction(seedId: string, commandSeq: number, text: string): Promise<SayItResult> {
  const seed = typeof seedId === "string" ? getSeed(seedId) : undefined;
  if (!seed) return { ok: false, reason: "invalid", message: "Unknown demo session." };
  if (!Number.isInteger(commandSeq)) return { ok: false, reason: "invalid", message: "Pick a command first." };
  const sentence = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!sentence) return { ok: false, reason: "invalid", message: "Say why this command matters, or what must be true before it runs." };
  if (sentence.length > MAX_REASON_CHARS) return { ok: false, reason: "invalid", message: `Keep it under ${MAX_REASON_CHARS} characters.` };
  try {
    withSpokenReason(seed.events, commandSeq, sentence); // cheap validation before spending any tokens
  } catch (e) {
    return { ok: false, reason: "invalid", message: e instanceof ExplainError ? capitalise(e.message) : "That command can't be explained." };
  }

  const key = `${seed.id}|${commandSeq}|${sentence.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "off", message: "Live mode is off on this site right now. Try one of the recorded examples below." };
  }
  const h = await headers();
  const visitor = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "local";
  const gate = throttle.take(visitor);
  if (!gate.ok) {
    return gate.reason === "busy"
      ? { ok: false, reason: "busy", retryAfterS: gate.retryAfterS, message: `SayOps runs on a free AI tier and is busy. Try again in ${gate.retryAfterS}s, or pick a recorded example.` }
      : { ok: false, reason: "limit", retryAfterS: gate.retryAfterS, message: gate.reason === "minute" ? `That's a few in a row. Try again in ${gate.retryAfterS}s.` : "You've reached today's live tries. The recorded examples still work." };
  }

  try {
    const r = await explainStep({
      llm: groq({ apiKey, model: process.env.LLM_MODEL || undefined }),
      title: seed.meta.title,
      events: seed.events,
      plan: seed.plan,
      commandSeq,
      text: sentence,
      rateLimitWaitS: 0,
    });
    const result = { ok: true as const, plan: r.plan, narrationSeq: r.narration.seq, kind: r.kind, model: r.model, cached: false };
    cache.set(key, result);
    return result;
  } catch (e) {
    if (e instanceof LlmError && e.status === 429) {
      const wait = e.retryAfterS ?? 20;
      throttle.markBusy(wait);
      return { ok: false, reason: "busy", retryAfterS: wait, message: `SayOps runs on a free AI tier and is busy. Try again in ${wait}s, or pick a recorded example.` };
    }
    if (e instanceof CompileError) {
      return { ok: false, reason: "failed", message: "SayOps couldn't turn that into a safe, valid plan, so nothing changed. Try saying what must be true, e.g. \"only restart if the config test passed\"." };
    }
    if (e instanceof ExplainError) return { ok: false, reason: "invalid", message: capitalise(e.message) };
    return { ok: false, reason: "failed", message: "The AI call failed, so nothing changed. Try again, or pick a recorded example." };
  }
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
