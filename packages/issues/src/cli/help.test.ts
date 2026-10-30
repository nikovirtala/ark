import { type CliIO, runCli } from "@nikovirtala/ledger/cli";
import { describe, expect, it } from "vitest";
import { issuesCli } from "./commands.js";

const TOOL = issuesCli("0.0.0-test");

async function help(command: string): Promise<string> {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    argv: [command, "--help"],
    cwd: "/",
    env: {},
    stdout: {
      write: (s) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        stderr += s;
      },
    },
    interactive: false,
    stdoutIsTTY: false,
  };
  const code = await runCli(TOOL, io);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return stdout;
}

/** The `Options:` block of a command's help, up to the blank line after it. */
function optionsBlock(text: string): string {
  const start = text.indexOf("Options:\n");
  expect(start).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf("\n\n", start) + 1);
}

describe("issues subcommand help", () => {
  it("describes every option of every command", () => {
    const undescribed = TOOL.commands.flatMap((c) =>
      Object.entries(c.options)
        .filter(([, o]) => (o.help ?? "").trim() === "")
        .map(([name]) => `${c.name} --${name}`),
    );
    expect(undescribed).toEqual([]);
  });

  it.each(TOOL.commands.map((c) => [c.name, c.usage] as const))(
    "lists every --no-<name> in %s's usage as an option",
    async (name, usage) => {
      const text = await help(name);
      for (const [negated] of usage.matchAll(/--no-[a-z-]+/g)) {
        expect(text, `${name} --help has no ${negated} row`).toMatch(
          new RegExp(`\\n  ${negated} +\\S`),
        );
      }
    },
  );

  it("lists link's --rel values and its default", async () => {
    expect(optionsBlock(await help("link"))).toBe(
      [
        "Options:",
        "  --rel <rel>              the relation: depends-on, part-of, relates-to or implements (default: relates-to)",
        "  --commit                 commit what the command stages (default: [policy] auto_commit)",
        "  --no-commit              only stage, even with [policy] auto_commit",
        "  -m, --message <message>  the commit message; needs a commit",
        "",
      ].join("\n"),
    );
  });

  it("shows new's and edit's --section <id>=<markdown> and their negated options", async () => {
    const created = optionsBlock(await help("new"));
    expect(created).toMatch(
      /\n {2}--section <id>=<markdown> +fill section <id> .*\(repeatable\)\n/,
    );
    for (const row of ["--edit", "--no-edit", "--commit", "--no-commit"]) {
      expect(created).toMatch(new RegExp(`\\n  ${row} +\\S`));
    }
    const edited = optionsBlock(await help("edit"));
    expect(edited).toMatch(/\n {2}--section <id>=<markdown> +replace section <id> /);
    expect(edited).toMatch(/\n {2}--no-edit +don't open an editor\n/);
  });
});
