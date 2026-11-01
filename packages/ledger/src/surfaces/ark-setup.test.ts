import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { ARK_PINS, arkPrepare, arkServers, arkSetup, arkShared } from "./ark-setup.js";
import { mcpStdioServer } from "./setup-claude.js";

describe("ark-setup content", () => {
  it("pins exact versions, never workspace:* or a range, and passes ARK_ON_BEHALF_OF through", () => {
    const servers = arkServers({ pkg: "@nikovirtala/adr", name: "adr", version: ARK_PINS.adr });
    const claude = servers.claude.value as { args: string[]; env: Record<string, string> };
    expect(claude.args).toEqual(["-y", "@nikovirtala/adr@0.5.10", "mcp"]);
    expect(claude.env.ARK_AGENT).toBe("claude-code");
    // The value is passed through as a shell placeholder, never resolved (R4).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected shell placeholder
    expect(claude.env.ARK_ON_BEHALF_OF).toBe("${ARK_ON_BEHALF_OF}");
    const kiro = servers.kiro.value as { env: Record<string, string> };
    expect(kiro.env.ARK_AGENT).toBe("kiro");
    expect(JSON.stringify(servers)).not.toContain("workspace:");
  });

  it("refuses a non-exact version (R4, R8)", () => {
    expect(() => mcpStdioServer({ pkg: "p", version: "^1.0.0", agent: "a" })).toThrow(
      InvalidArgumentError,
    );
    expect(() => mcpStdioServer({ pkg: "p", version: "workspace:*", agent: "a" })).toThrow(
      InvalidArgumentError,
    );
    expect(() => mcpStdioServer({ pkg: "p", version: "1.2.3", agent: "a" })).not.toThrow();
  });

  it("writes the prepare script naming both tools at their pins, with no --quiet", () => {
    const prepare = arkPrepare(ARK_PINS);
    expect(prepare).toBe(
      "npx -y @nikovirtala/adr@0.5.10 hooks install && npx -y @nikovirtala/issues@0.5.6 hooks install",
    );
    expect(prepare).not.toContain("--quiet");
  });

  it("gives Kiro its disabled/autoApprove fields and Claude none", () => {
    const servers = arkServers({
      pkg: "@nikovirtala/issues",
      name: "issues",
      version: ARK_PINS.issues,
    });
    expect(servers.kiro.value).toMatchObject({ disabled: false, autoApprove: [] });
    expect(servers.claude.value).not.toHaveProperty("disabled");
  });

  it("shares identical hook scripts across harnesses' pins and builds a full setup", () => {
    const shared = arkShared(ARK_PINS);
    expect(shared.claude.sessionStartScript).toContain("@nikovirtala/adr@0.5.10");
    expect(shared.kiro.beforeEditScript).toContain("@nikovirtala/issues@0.5.6");
    const setup = arkSetup({
      harnesses: ["claude", "kiro"],
      pkg: "@nikovirtala/adr",
      name: "adr",
      version: ARK_PINS.adr,
      pins: ARK_PINS,
    });
    expect(setup.harnesses).toEqual(["claude", "kiro"]);
    expect(setup.prepare).toBe(arkPrepare(ARK_PINS));
  });
});
