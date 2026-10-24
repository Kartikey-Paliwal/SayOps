import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { Plan } from "@sayops/core";

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // so_xxxxxx
  owner: text("owner"), // null for demo seeds
  title: text("title").notNull(),
  shell: text("shell").notNull(),
  os: text("os").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  isDemo: boolean("is_demo").notNull().default(false),
  /** demo seed this session was copied from (judge "try it" copies) */
  copiedFrom: text("copied_from"),
  /** narration seq → command seq (null = context), set by dragging in the UI */
  alignOverrides: jsonb("align_overrides").$type<Record<number, number | null>>().notNull().default({}),
  status: text("status").notNull().default("uploaded"), // uploaded | compiling | ready | failed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const commands = pgTable("commands", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  cmdRedacted: text("cmd_redacted").notNull(),
  exitCode: integer("exit_code").notNull(),
  durationMs: integer("duration_ms").notNull(),
  cwd: text("cwd").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("commands_session_seq").on(t.sessionId, t.seq)]);

export const narrations = pgTable("narrations", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  textRedacted: text("text_redacted").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("narrations_session_seq").on(t.sessionId, t.seq)]);

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  planJson: jsonb("plan_json").$type<Plan>().notNull(),
  model: text("model").notNull(),
  source: text("source").notNull(), // compile | correction | finding
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("plans_session_version").on(t.sessionId, t.version)]);

export const findings = pgTable("findings", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  detail: text("detail").notNull(),
  fixStep: text("fix_step"),
  status: text("status").notNull().default("open"), // open | accepted | dismissed
});

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // script | workflow | runbook
  content: text("content").notNull(),
  lintOk: boolean("lint_ok"), // null until a proof run lints it
  lintOutput: text("lint_output"),
});

export const proofRuns = pgTable("proof_runs", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  fixture: text("fixture").notNull(), // normal | broken
  status: text("status").notNull().default("queued"), // queued | running | passed | failed
  ghRunUrl: text("gh_run_url"),
  stepsJson: jsonb("steps_json").$type<{ id: string; ok: boolean; output: string; ms: number }[]>(),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const corrections = pgTable("corrections", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  textRedacted: text("text_redacted").notNull(),
  producedVersion: integer("produced_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
