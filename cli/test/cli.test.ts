import { align, SessionUpload } from "@sayops/core";
import { alignOverrides, readEvents, readSession } from "@sayops/core/store";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/main";
import type { Ctx } from "../src/commands";

let home: string;
let out: string[];
let err: string[];
let clock: number;

function ctx(stdin = ""): Ctx {
  return {
    home,
    env: { SHELL: "/bin/zsh" },
    now: () => new Date((clock += 1000)),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdin: () => stdin,
    sleep: () => {},
  };
}
const cli = (args: string[], stdin = "") => run(args, ctx(stdin));
const current = () => readFileSync(join(home, "current"), "utf8").trim();
/** What the shell hook would do after a command finishes. */
const cmd = (seq: number, text: string, exit = 0) =>
  cli(["_cmd", "--session", current(), "--seq", String(seq), "--exit", String(exit), "--start", String(clock / 1000 + seq), "--ms", "12", "--cwd", "/tmp/work"], text);
const sessionFiles = (id: string) => readdirSync(join(home, "sessions", id)).map((f) => readFileSync(join(home, "sessions", id, f), "utf8")).join("\n");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sayops-cli-"));
  out = [];
  err = [];
  clock = Date.UTC(2026, 9, 24, 10, 0, 0);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("session lifecycle", () => {
  it("start → status → stop", async () => {
    expect(await cli(["start", "rotate", "the", "dev", "cert"])).toBe(0);
    const id = current();
    expect(id).toMatch(/^so_[a-z0-9]+$/);
    expect(readSession(home, id)).toMatchObject({ title: "rotate the dev cert", status: "recording", shell: "zsh", endedAt: null });
    await cli(["status"]);
    expect(out.at(-1)).toContain(id);
    expect(await cli(["stop"])).toBe(0);
    expect(existsSync(join(home, "current"))).toBe(false);
    expect(readSession(home, id)).toMatchObject({ status: "stopped", summary: { commands: 0, narrations: 0 } });
    await cli(["status"]);
    expect(out.at(-1)).toBe("No session is recording.");
  });

  it("refuses a second start while recording, and --force marks the old one interrupted", async () => {
    await cli(["start", "first"]);
    const first = current();
    expect(await cli(["start", "second"])).toBe(1);
    expect(err.at(-1)).toContain("is still recording");
    expect(current()).toBe(first);
    expect(await cli(["start", "second", "--force"])).toBe(0);
    expect(readSession(home, first).status).toBe("interrupted");
    expect(existsSync(join(home, "sessions", first, "upload.json"))).toBe(true); // interrupted work is kept
    expect(current()).not.toBe(first);
  });

  it("errors clearly when nothing is recording", async () => {
    for (const args of [["stop"], ["why", "because"], ["discard", "--yes"]]) {
      expect(await cli(args)).toBe(1);
      expect(err.at(-1)).toContain("no session is recording");
    }
  });

  it("recovers from a dangling current pointer", async () => {
    await cli(["start", "x"]);
    rmSync(join(home, "sessions", current()), { recursive: true });
    expect(await cli(["stop"])).toBe(1);
    expect(err.at(-1)).toContain("no longer exists");
    expect(existsSync(join(home, "current"))).toBe(false);
    expect(await cli(["start", "fresh"])).toBe(0);
  });

  it("discard needs --yes and then deletes the session", async () => {
    await cli(["start", "x"]);
    const id = current();
    expect(await cli(["discard"])).toBe(2);
    expect(existsSync(join(home, "sessions", id))).toBe(true);
    expect(await cli(["discard", "--yes"])).toBe(0);
    expect(existsSync(join(home, "sessions", id))).toBe(false);
  });

  it("rejects bad input with usage errors", async () => {
    expect(await cli(["start"])).toBe(2);
    expect(await cli(["start", "x".repeat(201)])).toBe(2);
    expect(await cli(["frobnicate"])).toBe(2);
    expect(await cli(["show", "../../etc"])).toBe(1);
    expect(err.at(-1)).toContain("not a session id");
    expect(await cli(["hook", "fish"])).toBe(2);
    expect(await cli(["hook", "bash"])).toBe(1);
    expect(await cli(["start", "--shell"])).toBe(2);
  });
});

describe("command capture and explanations", () => {
  beforeEach(async () => {
    await cli(["start", "renew"]);
  });

  it("records commands with exit codes, and attaches `why` to the last command", async () => {
    await cmd(1, "sudo systemctl stop nginx");
    await cmd(2, "sudo nginx -t", 1);
    expect(await cli(["why", "--after", "2", "always", "test", "the", "config"])).toBe(0);
    expect(out.at(-1)).toBe("  ↳ N1 explains C2: sudo nginx -t");
    const { events } = readEvents(home, current());
    expect(events.filter((e) => e.kind === "command").map((e) => e.kind === "command" && [e.seq, e.exit, e.cwd])).toEqual([[1, 0, "/tmp/work"], [2, 1, "/tmp/work"]]);
    expect(readSession(home, current()).overrides).toEqual({ "1": 2 });
  });

  it("--for attaches to an earlier command, --context to the whole session", async () => {
    await cmd(1, "certbot certificates");
    await cmd(2, "certbot renew");
    await cli(["why", "--after", "2", "--for", "C1", "check expiry first"]);
    await cli(["why", "--context", "this", "is", "for", "the", "staging", "box"]);
    const s = readSession(home, current());
    expect(s.overrides).toEqual({ "1": 1, "2": null });
    const aligned = align(readEvents(home, s.id).events, { overrides: alignOverrides(s) });
    expect(aligned.steps[0].narrations.map((n) => n.text)).toEqual(["check expiry first"]);
    expect(aligned.context.map((n) => n.text)).toEqual(["this is for the staging box"]);
  });

  it("explains the latest command when the hook gave no position", async () => {
    await cmd(1, "echo one");
    await cmd(2, "echo two");
    await cli(["why", "second", "one"]);
    expect(out.at(-1)).toContain("explains C2");
  });

  it("rejects empty explanations and unknown commands", async () => {
    await cmd(1, "echo one");
    expect(await cli(["why", "--stdin"], "   \n")).toBe(2);
    expect(await cli(["why", "--for", "C9", "x"])).toBe(1);
    expect(err.at(-1)).toContain("no recorded command C9");
    expect(await cli(["why", "--for", "banana", "x"])).toBe(2);
    expect(readEvents(home, current()).events.filter((e) => e.kind === "narration")).toEqual([]);
  });

  it("reads explanations from stdin verbatim (Wispr dictation with quotes and apostrophes)", async () => {
    await cmd(1, "nginx -t");
    await cli(["why", "--after", "1", "--stdin"], `Don't restart if it's "busy" — check first`);
    const n = readEvents(home, current()).events.find((e) => e.kind === "narration");
    expect(n && n.kind === "narration" && n.text).toBe(`Don't restart if it's "busy" — check first`);
  });

  it("never fails loudly from the background hook", async () => {
    expect(await cli(["_cmd", "--session", "so_doesnotexist1", "--seq", "1", "--exit", "0", "--start", "1", "--ms", "1"], "ls")).toBe(0);
    expect(await cli(["_cmd", "--seq", "nope"], "ls")).toBe(0);
    expect(err).toEqual([]);
  });

  it("ignores commands for a session that is no longer recording", async () => {
    const id = current();
    await cli(["stop"]);
    await cli(["_cmd", "--session", id, "--seq", "1", "--exit", "0", "--start", "1", "--ms", "1", "--cwd", "/"], "echo late");
    expect(readEvents(home, id).events).toEqual([]);
  });
});

describe("persistence", () => {
  it("writes owner-only files and an upload.json the compiler accepts", async () => {
    await cli(["start", "persist"]);
    const id = current();
    await cmd(1, "echo hi");
    await cli(["why", "--after", "1", "saying", "hi"]);
    await cli(["stop"]);
    const dir = join(home, "sessions", id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of ["session.json", "events.jsonl", "upload.json"]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    const upload = SessionUpload.parse(JSON.parse(readFileSync(join(dir, "upload.json"), "utf8")));
    expect(upload).toMatchObject({ title: "persist", shell: "zsh" });
    expect(upload.events).toHaveLength(2);
    expect(readSession(home, id).summary).toMatchObject({ commands: 1, failed: 0, narrations: 1 });
  });

  it("skips and counts a line cut short by a crash", async () => {
    await cli(["start", "crash"]);
    const id = current();
    await cmd(1, "echo before");
    appendFileSync(join(home, "sessions", id, "events.jsonl"), '{"kind":"command","seq":2,"t":"2026');
    await cmd(3, "echo after");
    expect(await cli(["stop"])).toBe(0);
    expect(readSession(home, id).summary).toMatchObject({ commands: 2, malformed: 1 });
    expect(err.join()).toContain("1 unreadable line(s) were skipped");
  });

  it("reports commands that were still in flight at stop", async () => {
    await cli(["start", "pending"]);
    const id = current();
    writeFileSync(join(home, "sessions", id, "pending.7"), "");
    await cli(["stop"]);
    expect(readSession(home, id).summary?.lost).toBe(1);
    expect(err.join()).toContain("still being recorded");
  });

  it("refuses to compile while recording or without a key, with a clear message", async () => {
    await cli(["start", "c"]);
    await cmd(1, "echo hi");
    expect(await cli(["compile"])).toBe(1);
    expect(err.at(-1)).toContain("still recording");
    await cli(["stop"]);
    expect(await cli(["compile"])).toBe(1);
    expect(err.at(-1)).toContain("GROQ_API_KEY is not set");
  });
});

describe("redaction", () => {
  it("never stores or shows raw secrets from commands, folders or explanations", async () => {
    await cli(["start", "secrets"]);
    const id = current();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
    await cmd(1, `git clone https://${token}@github.com/acme/ops.git`);
    await cmd(2, "psql postgres://admin:hunter2pass@db.internal/app -c 'select 1'");
    await cli(["why", "--after", "2", `the password is DB_PASSWORD=s3cretValue123 and token ${token}`]);
    await cli(["stop"]);
    await cli(["show", id]);
    const everything = `${sessionFiles(id)}\n${out.join("\n")}`;
    for (const raw of [token, "hunter2pass", "s3cretValue123"]) expect(everything).not.toContain(raw);
    expect(everything).toContain("<REDACTED:github_token>");
    expect(everything).toContain("<REDACTED:conn_password>");
    expect(readSession(home, id).summary?.redactions).toBe(4);
  });
});
