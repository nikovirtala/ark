import { InvalidArgumentError } from "../errors.js";
import {
  HOOK_NAMES,
  type HookName,
  type HookRegistration,
  normalizeRegistrations,
} from "./shim.js";

export type HookManager = "lefthook" | "husky" | "pre-commit";

const SH_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const YAML_PLAIN = /^[A-Za-z0-9_./][A-Za-z0-9 _@%+=:,./-]*$/;

function shWord(token: string): string {
  return SH_SAFE.test(token) ? token : `'${token.replace(/'/g, "'\\''")}'`;
}

/** A plain YAML scalar when that's unambiguous, else a double-quoted one. */
function yamlValue(s: string): string {
  const plain = YAML_PLAIN.test(s) && !s.includes(": ") && !/[: ]$/.test(s);
  return plain ? s : JSON.stringify(s);
}

function commandLine(r: HookRegistration, args: string | null): string {
  return [r.tool, ...r.argv]
    .flatMap((t) => (t === "{args}" ? (args === null ? [] : [args]) : [shWord(t)]))
    .join(" ");
}

function byHook(regs: readonly HookRegistration[]): [HookName, HookRegistration[]][] {
  const sorted = normalizeRegistrations(regs);
  return HOOK_NAMES.map((h): [HookName, HookRegistration[]] => [
    h,
    sorted.filter((r) => r.hook === h),
  ]).filter(([, rs]) => rs.length > 0);
}

/** A unique, readable id for a tool's command: `<tool>-<first argv word>`. */
function commandId(r: HookRegistration): string {
  const word = (r.argv[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return word === "" ? r.tool : `${r.tool}-${word}`;
}

/**
 * Config to paste into an existing hook manager instead of installing shims. Each tool's command
 * runs through `npx --no-install` (husky v9 already puts `node_modules/.bin` on PATH). Pure.
 */
export function hookSnippet(manager: HookManager, regs: readonly HookRegistration[]): string {
  const groups = byHook(regs);
  const out: string[] = [];
  if (manager === "lefthook") {
    out.push("# lefthook.yml");
    for (const [hook, rs] of groups) {
      out.push(`${hook}:`, "  commands:");
      for (const r of rs) {
        out.push(
          `    ${commandId(r)}:`,
          `      run: ${yamlValue(`npx --no-install ${commandLine(r, "{0}")}`)}`,
        );
      }
    }
  } else if (manager === "husky") {
    groups.forEach(([hook, rs], i) => {
      if (i > 0) out.push("");
      out.push(`# .husky/${hook}`, ...rs.map((r) => commandLine(r, '"$@"')));
    });
  } else if (manager === "pre-commit") {
    out.push("# .pre-commit-config.yaml", "repos:", "  - repo: local", "    hooks:");
    for (const [hook, rs] of groups) {
      for (const r of rs) {
        const at = r.argv.indexOf("{args}");
        if (at >= 0 && at !== r.argv.length - 1) {
          throw new InvalidArgumentError(
            `pre-commit can pass the hook's arguments only last; ${r.tool} has {args} at ${at}`,
          );
        }
        const line = commandLine(r, null);
        out.push(
          `      - id: ${commandId(r)}`,
          `        name: ${yamlValue(line)}`,
          `        entry: ${yamlValue(`npx --no-install ${line}`)}`,
          "        language: system",
          `        pass_filenames: ${at >= 0}`,
          "        always_run: true",
          `        stages: [${hook}]`,
        );
      }
    }
  } else {
    throw new InvalidArgumentError(`unknown hook manager: ${JSON.stringify(manager)}`);
  }
  return `${out.join("\n")}\n`;
}
