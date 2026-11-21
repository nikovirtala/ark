/**
 * The records are a contract with every project's ledger. longplay's table and freeze flag were read
 * on 2026-11-21 (test-support/longplay-*.json, every item as DynamoDB stores it); each must read
 * unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  FREEZE_SCHEMA,
  parseFreezeRecord,
  parseRunRecord,
  parseTaskRecord,
  phaseOf,
  RUN_SCHEMA,
} from "./records.js";
import { LONGPLAY_FREEZE, LONGPLAY_ITEMS } from "./test-support/longplay.js";

describe("longplay's ledger items", () => {
  const runs = LONGPLAY_ITEMS.filter((i) => i.pk === "DEPLOY" && String(i.sk).startsWith("RUN#"));
  const tasks = LONGPLAY_ITEMS.filter((i) => String(i.pk).startsWith("RELEASE#"));

  it("are runs, tasks and the last good commit, and nothing else", () => {
    expect(runs.length + tasks.length + 1).toBe(LONGPLAY_ITEMS.length);
    expect(LONGPLAY_ITEMS.filter((i) => i.sk === "LAST_GOOD")).toHaveLength(1);
  });

  it("read as run records, every one, with longplay's release-failed as task-failed", () => {
    for (const item of runs) {
      const r = parseRunRecord(item);
      expect(r, String(item.sk)).toBeDefined();
      expect(r).toMatchObject({
        schema: RUN_SCHEMA,
        commit: item.commit,
        at: item.at,
        execution: item.execution,
        summary: item.summary,
      });
    }
    const failed = runs.find((i) => i.outcome === "release-failed");
    expect(failed).toBeDefined();
    expect(parseRunRecord(failed as Record<string, unknown>)).toMatchObject({
      outcome: "task-failed",
      phase: "frozen",
    });
  });

  it("read as task records, every one", () => {
    for (const item of tasks) {
      expect(parseTaskRecord(item), String(item.sk)).toMatchObject({
        id: item.id,
        commit: item.commit,
        outcome: item.outcome,
      });
    }
  });

  it("refuse what is not a record, instead of guessing", () => {
    expect(
      parseRunRecord({ commit: "c", at: "t", execution: "e", summary: "s", outcome: "exploded" }),
    ).toBeUndefined();
    expect(parseRunRecord({ commit: "c" })).toBeUndefined();
    expect(
      parseTaskRecord({ id: "x", commit: "c", at: "t", summary: "s", outcome: "maybe" }),
    ).toBeUndefined();
  });
});

describe("longplay's freeze value", () => {
  it("reads as a freeze record, set by the pipeline, with where it rolled back to", () => {
    const r = parseFreezeRecord(LONGPLAY_FREEZE);
    expect(r).toMatchObject({ schema: FREEZE_SCHEMA, by: "pipeline" });
    expect(r?.rolledBackTo).toMatch(/^[0-9a-f]{40}$/);
    expect(r?.logs).toContain("longplay-platform-deploy");
  });

  it("a hand freeze of longplay reads as set by a person", () => {
    expect(
      parseFreezeRecord(
        JSON.stringify({ reason: "by hand: drill", commit: "-", at: "t", logs: "-" }),
      )?.by,
    ).toBe("person");
  });

  it("anything that is not a freeze record is no record (and the store treats it as frozen)", () => {
    for (const v of [
      "yes",
      "[]",
      "{}",
      '{"reason": 1}',
      JSON.stringify({
        schema: "deployment-freeze/v9",
        reason: "r",
        commit: "c",
        at: "t",
        logs: "l",
      }),
    ]) {
      expect(parseFreezeRecord(v), v).toBeUndefined();
    }
  });
});

describe("run outcomes and phases", () => {
  it("map every outcome to the terminal phase it ends in", () => {
    expect(phaseOf("succeeded")).toBe("succeeded");
    expect(phaseOf("refused")).toBe("refused");
    expect(phaseOf("check-failed")).toBe("refused");
    for (const o of ["frozen", "rolled-back", "rollback-failed", "task-failed"] as const)
      expect(phaseOf(o)).toBe("frozen");
  });
});
