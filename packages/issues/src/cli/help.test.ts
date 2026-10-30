import { type CliIO, runCli } from "@nikovirtala/ledger/cli";
import { describe, expect, it } from "vitest";
import { issuesCli } from "./commands.js";

const TOOL = issuesCli("0.0.0");

async function help(command: string): Promise<string> {
  const out: string[] = [];
  const io: CliIO = {
    argv: [command, "--help"],
    cwd: process.cwd(),
    env: {},
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: () => {} },
    interactive: false,
    stdoutIsTTY: false,
  };
  expect(await runCli(TOOL, io)).toBe(0);
  return out.join("");
}

/** The lines of the help's `Options:` block. */
const optionLines = (text: string): string[] => {
  const start = text.indexOf("\nOptions:\n");
  if (start === -1) return [];
  const block = text.slice(start + "\nOptions:\n".length);
  return block.slice(0, block.indexOf("\n\n")).split("\n");
};

describe("issues <command> --help", () => {
  it("describes link's --rel values and default, and every write option", async () => {
    expect(optionLines(await help("link"))).toEqual([
      "  --rel <relation>         depends-on, part-of, relates-to (the default), or implements for a decision",
      "  --commit                 commit what the command writes (default: [policy] auto_commit)",
      "  --no-commit              stage it without committing, even with [policy] auto_commit",
      "  -m, --message <message>  the commit message; needs a commit",
    ]);
  });

  it("shows new's --section <id>=<markdown> and its negated options", async () => {
    const lines = optionLines(await help("new"));
    expect(lines).toContain(
      "  --section <id>=<markdown>  fill the template section <id> with <markdown> (repeatable)",
    );
    expect(lines.map((l) => l.trim().split(" ")[0])).toEqual([
      "--template",
      "--parent",
      "--depends-on",
      "--label",
      "--section",
      "--edit",
      "--no-edit",
      "--commit",
      "--no-commit",
      "-m,",
    ]);
    expect(optionLines(await help("edit"))).toContain(
      "  --section <id>=<markdown>  fill the template section <id> with <markdown> (repeatable)",
    );
  });

  it.each(TOOL.commands.map((c) => [c.name, c] as const))(
    "%s: every option has a description, and every --no- option of the usage is listed",
    async (name, spec) => {
      const text = await help(name);
      const lines = optionLines(text);
      expect(lines.length).toBeGreaterThanOrEqual(Object.keys(spec.options).length);
      for (const line of lines) expect(line, line).toMatch(/^ {2}\S.*\S {2,}\S/);
      const flags = lines.map(
        (l) =>
          l
            .trim()
            .replace(/^-\w, /, "")
            .split(" ")[0],
      );
      for (const negated of spec.usage.match(/--no-[a-z-]+/g) ?? []) {
        expect(flags, negated).toContain(negated);
      }
    },
  );
});
