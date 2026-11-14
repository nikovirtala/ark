// Writes one row to ops-cells.csv: wall and machine time of the verification pass, number of
// commits checked, rewritten and changed, and the per-commit sums. Called by run-branch-op.sh.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , csv, cell, n, op, rep, opWall, timing, rc, jsonl, preFile, postFile] = process.argv;
const HEADER =
  "cell,n,op,rep,op_wall_s,verify_wall_s,verify_user_s,verify_sys_s,exit,checked,rewritten,tree_changed,patch_changed,msg_changed,sum_commit_wall_s,tests,test_files";
const rows = existsSync(jsonl)
  ? readFileSync(jsonl, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const pre = JSON.parse(readFileSync(preFile, "utf8"));
const post = JSON.parse(readFileSync(postFile, "utf8"));
const has = (set, v) => set.has(v);
const preSha = new Set(pre.map((c) => c.sha));
const preTree = new Set(pre.map((c) => c.tree));
const prePatch = new Set(pre.map((c) => c.patch));
const preMsg = new Set(pre.map((c) => c.msg));
const rewritten = post.filter((c) => !has(preSha, c.sha)).length;
const treeChanged = post.filter((c) => !has(preTree, c.tree)).length;
const patchChanged = post.filter((c) => !has(prePatch, c.patch)).length;
const msgChanged = post.filter((c) => !has(preMsg, c.msg)).length;
const [wall, user, sys] = timing.split(",");
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
if (!existsSync(csv)) writeFileSync(csv, `${HEADER}\n`);
appendFileSync(
  csv,
  `${[cell, n, op, rep, Number(opWall).toFixed(3), wall, user, sys, rc, rows.length, rewritten, treeChanged, patchChanged, msgChanged, sum("wall_s").toFixed(3), sum("tests"), sum("test_files")].join(",")}\n`,
);
