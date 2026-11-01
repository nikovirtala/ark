import { stat } from "node:fs/promises";
import { join } from "node:path";
import { InvalidArgumentError } from "../errors.js";
import type { Git } from "../git/git.js";
import type { SetupPiece } from "./setup.js";

/** A harness's name, for the `--harness <name>` opt-out and the piece ids. */
export type Harness = "claude" | "kiro";

/** Every harness init can write, in a stable order. */
export const HARNESSES: readonly Harness[] = ["claude", "kiro"];

/** The config directory whose presence marks a harness as in use. */
const HARNESS_DIR: Readonly<Record<Harness, string>> = { claude: ".claude", kiro: ".kiro" };

/**
 * The harnesses a repository uses, by the presence of their config directories (`.claude`,
 * `.kiro`). A repository with neither gets every harness, so a first `init` writes the full setup;
 * flags then opt pieces or harnesses out (never in, R1).
 */
export async function detectHarnesses(git: Git): Promise<readonly Harness[]> {
  const root = git.root ?? "";
  const present: Harness[] = [];
  for (const h of HARNESSES) {
    const there = await stat(join(root, HARNESS_DIR[h]))
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (there) present.push(h);
  }
  return present.length > 0 ? present : [...HARNESSES];
}

/** One MCP server entry: the key under `mcpServers` and the value (`command`/`args`/`env`/…). */
export interface McpServerEntry {
  readonly name: string;
  readonly value: unknown;
}

/**
 * An MCP stdio server value: `npx -y <package>@<version> mcp`, with `ARK_AGENT` naming the harness
 * and `ARK_ON_BEHALF_OF` passed through from the environment, never its value (R4). `version` MUST
 * be an exact published version; a range or `workspace:*` is refused.
 */
export function mcpStdioServer(o: {
  readonly pkg: string;
  readonly version: string;
  readonly agent: string;
  /** Kiro's config carries `disabled`/`autoApprove`; Claude's does not. */
  readonly kiroFields?: boolean;
}): unknown {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(o.version)) {
    throw new InvalidArgumentError(
      `MCP server version must be an exact published version, got ${JSON.stringify(o.version)}`,
    );
  }
  const base: Record<string, unknown> = {
    command: "npx",
    args: ["-y", `${o.pkg}@${o.version}`, "mcp"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell env placeholder, passed through verbatim (R4)
    env: { ARK_AGENT: o.agent, ARK_ON_BEHALF_OF: "${ARK_ON_BEHALF_OF}" },
  };
  return o.kiroFields === true ? { ...base, disabled: false, autoApprove: [] } : base;
}

/**
 * The exact file contents of the shared, ark-specific pieces a harness writes whole: the hook
 * scripts, the settings/hook JSON. These are identical whichever tool runs init, so init
 * reproduces the committed fixture byte-for-byte regardless of which tool wrote first (R9). Supply
 * `null` for a piece the harness does not have.
 */
export interface HarnessShared {
  /** `.claude/settings.json` (hooks + permissions.deny) or `.kiro` hook JSON files, as raw text. */
  readonly settings?: string;
  readonly sessionStartHook?: string;
  readonly beforeEditHook?: string;
  readonly sessionStartScript?: string;
  readonly beforeEditScript?: string;
}

/** The Claude harness's pieces (design: formats in one module per harness). */
export function claudePieces(o: {
  readonly server: McpServerEntry;
  readonly shared: HarnessShared;
}): SetupPiece[] {
  const pieces: SetupPiece[] = [
    {
      id: `claude.mcp.${o.server.name}`,
      file: ".mcp.json",
      ownership: {
        kind: "merge",
        scaffold: { mcpServers: {} },
        entries: { [`mcpServers.${o.server.name}`]: o.server.value },
      },
    },
  ];
  if (o.shared.settings !== undefined) {
    pieces.push({
      id: "claude.settings",
      file: ".claude/settings.json",
      ownership: { kind: "whole", text: o.shared.settings },
    });
  }
  if (o.shared.sessionStartScript !== undefined) {
    pieces.push({
      id: "claude.hook.session-start",
      file: ".claude/hooks/session-start.sh",
      ownership: { kind: "whole", text: o.shared.sessionStartScript },
    });
  }
  if (o.shared.beforeEditScript !== undefined) {
    pieces.push({
      id: "claude.hook.before-edit",
      file: ".claude/hooks/before-edit.sh",
      ownership: { kind: "whole", text: o.shared.beforeEditScript },
    });
  }
  return pieces;
}
