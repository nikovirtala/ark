import type { SetupPiece } from "./setup.js";
import type { HarnessShared, McpServerEntry } from "./setup-claude.js";

/** The Kiro harness's pieces (design: formats in one module per harness). */
export function kiroPieces(o: {
  readonly server: McpServerEntry;
  readonly shared: HarnessShared;
}): SetupPiece[] {
  const pieces: SetupPiece[] = [
    {
      id: `kiro.mcp.${o.server.name}`,
      file: ".kiro/settings/mcp.json",
      ownership: {
        kind: "merge",
        scaffold: { mcpServers: {} },
        entries: { [`mcpServers.${o.server.name}`]: o.server.value },
      },
    },
  ];
  if (o.shared.sessionStartHook !== undefined) {
    pieces.push({
      id: "kiro.hook.session-start.def",
      file: ".kiro/hooks/session-start.kiro.hook.json",
      ownership: { kind: "whole", text: o.shared.sessionStartHook },
    });
  }
  if (o.shared.beforeEditHook !== undefined) {
    pieces.push({
      id: "kiro.hook.before-edit.def",
      file: ".kiro/hooks/before-edit.kiro.hook.json",
      ownership: { kind: "whole", text: o.shared.beforeEditHook },
    });
  }
  if (o.shared.sessionStartScript !== undefined) {
    pieces.push({
      id: "kiro.hook.session-start",
      file: ".kiro/hooks/session-start.sh",
      ownership: { kind: "whole", text: o.shared.sessionStartScript },
    });
  }
  if (o.shared.beforeEditScript !== undefined) {
    pieces.push({
      id: "kiro.hook.before-edit",
      file: ".kiro/hooks/before-edit.sh",
      ownership: { kind: "whole", text: o.shared.beforeEditScript },
    });
  }
  return pieces;
}
