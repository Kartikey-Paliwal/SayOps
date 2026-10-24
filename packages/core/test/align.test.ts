import { describe, expect, it } from "vitest";
import { align, sslRenewEvents, toPromptLines } from "../src";

const ssl = sslRenewEvents;

describe("align", () => {
  it("attaches each narration to the command run before it", () => {
    const a = align(ssl);
    const map = Object.fromEntries(a.steps.map((s) => [s.command.seq, s.narrations.map((n) => n.seq)]));
    expect(map).toEqual({ 1: [1, 2], 2: [], 3: [3], 4: [4], 5: [5], 6: [6], 7: [7] });
  });

  it("marks a failed typo as superseded by the retry", () => {
    const a = align(ssl);
    expect(a.steps.find((s) => s.command.seq === 2)?.superseded).toBe(true);
    expect(a.steps.filter((s) => s.superseded)).toHaveLength(1);
  });

  it("treats early narrations far from the first command as context", () => {
    const a = align(ssl, { maxGapMs: 1000 });
    expect(a.context.map((n) => n.seq)).toEqual([1]);
  });

  it("honours user overrides", () => {
    const a = align(ssl, { overrides: { 4: 4, 1: null } });
    expect(a.context.map((n) => n.seq)).toEqual([1]);
    expect(a.steps.find((s) => s.command.seq === 4)?.narrations.map((n) => n.seq)).toEqual([4]);
  });

  it("ignores recorder self-commands", () => {
    const a = align([...ssl, { kind: "command", seq: 99, t: "2026-10-24T10:05:00.000Z", cmd: "sayops stop", exit: 0, ms: 1, cwd: "/" }]);
    expect(a.steps.some((s) => s.command.seq === 99)).toBe(false);
  });

  it("renders compact labelled prompt lines", () => {
    const lines = toPromptLines(align(ssl));
    expect(lines).toContain("C2 exit=127");
    expect(lines).toContain("[failed, retried below]");
    expect(lines).toContain('  N5: "Always test the config');
  });
});
