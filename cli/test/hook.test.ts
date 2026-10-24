import { readEvents, readSession } from "@sayops/core/store";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Real zsh, real built CLI (dist/sayops.mjs is built by `npm test` before vitest runs).
const BIN = join(__dirname, "..", "dist", "sayops.mjs");
const ZSH = ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"].find((p) => existsSync(p));
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sayops-hook-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Feeds lines to an interactive zsh (no rc files), exactly as if typed. */
function zsh(lines: string[], { exit = true } = {}) {
  const r = spawnSync(ZSH!, ["-f", "-i"], {
    input: `${lines.join("\n")}\n${exit ? "exit\n" : ""}`,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, SAYOPS_HOME: home, PS1: "$ " },
    timeout: 60_000,
  });
  return { status: r.status, all: `${r.stdout}${r.stderr}` };
}
const sayops = `node '${BIN}'`;
const only = () => readdirSync(join(home, "sessions"))[0];

describe.skipIf(!ZSH || !existsSync(BIN))("zsh hook (real shell)", () => {
  it("records commands with their exit codes, attaches why, skips private and sayops commands", () => {
    const r = zsh([
      `${sayops} start "hook test"`,
      `eval "$(${sayops} hook zsh)"`,
      "echo ok",
      "false",
      `why "I expected that to fail"`,
      " echo private-command",
      `${sayops} status`,
      "printf '%s\\n' \"it's quoted\" | cat",
      `${sayops} stop`,
    ]);
    expect(r.all).toContain("↳ N1 explains C2: false");
    const id = only();
    const { events } = readEvents(home, id);
    const cmds = events.flatMap((e) => (e.kind === "command" ? [[e.seq, e.cmd, e.exit]] : []));
    expect(cmds).toEqual([[1, "echo ok", 0], [2, "false", 1], [3, "printf '%s\\n' \"it's quoted\" | cat", 0]]);
    expect(JSON.stringify(events)).not.toContain("private-command");
    expect(cmds.some(([, c]) => String(c).includes("sayops"))).toBe(false);
    expect(readSession(home, id)).toMatchObject({ status: "stopped", overrides: { "1": 2 }, summary: { commands: 3, failed: 1, lost: 0 } });
  });

  it("records nothing while idle, and why explains how to start", () => {
    const r = zsh([`eval "$(${sayops} hook zsh)"`, "echo idle", "why"]);
    expect(r.all).toContain("no session is recording");
    expect(existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []).toEqual([]);
  });

  it("unhook removes the hooks and the why function", () => {
    const r = zsh([
      `${sayops} start "unhook test"`,
      `eval "$(${sayops} hook zsh)"`,
      "echo before",
      `eval "$(${sayops} unhook zsh)"`,
      "echo after",
      "whence -w why _sayops_precmd || echo gone",
      `${sayops} stop`,
    ]);
    expect(r.all).toContain("gone");
    const cmds = readEvents(home, only()).events.filter((e) => e.kind === "command");
    expect(cmds.map((e) => e.kind === "command" && e.cmd)).toEqual(["echo before"]);
  });

  it("a cancelled why (Ctrl-D at the prompt) records nothing", () => {
    const r = zsh([`${sayops} start "cancel"`, `eval "$(${sayops} hook zsh)"`, "echo x", "why"], { exit: false }); // input ends at the why> prompt
    expect(r.all).toContain("cancelled, nothing recorded");
    expect(readEvents(home, only()).events.filter((e) => e.kind === "narration")).toEqual([]);
  });

  it("the built CLI runs on its own", () => {
    const r = spawnSync("node", [BIN, "--version"], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("0.1.0");
  });
});
