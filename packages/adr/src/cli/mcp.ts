import { UsageError } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";

/**
 * `adr mcp` (design §7.1): the MCP server over stdio. Loaded with a dynamic import, so no other
 * command loads the MCP SDK.
 */
export function mcpCommand(version: string): CommandSpec {
  return {
    name: "mcp",
    summary: "start the MCP server over stdio",
    usage: "mcp",
    options: {},
    positionals: { min: 0, max: 0, names: [] },
    ref: "reject",
    async run({ io, flags }) {
      if (flags.json) throw new UsageError("adr mcp speaks JSON-RPC on stdout; it takes no --json");
      if (io.interactive) {
        io.stderr.write(
          "adr: adr mcp speaks MCP on stdin and stdout; start it from an MCP client\n",
        );
      }
      const { serveAdrMcp } = await import("../mcp/server.js");
      await serveAdrMcp({
        cwd: io.cwd,
        root: flags.root,
        env: io.env,
        version,
        stderr: io.stderr,
      });
      return { exit: 0, json: null, text: "" };
    },
  };
}
