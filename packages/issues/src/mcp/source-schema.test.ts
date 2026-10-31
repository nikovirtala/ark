import { describe, expect, it } from "vitest";
import { readTools } from "./read-tools.js";

describe("the source input schema", () => {
  it("is the source-name rule, anchored", () => {
    const tools = readTools({ cwd: ".", root: null, env: {} });
    for (const name of ["issues_list", "issues_search"]) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as {
        properties: Record<string, unknown>;
      };
      expect(schema.properties.source, name).toEqual({
        type: "string",
        pattern: "^[a-z][a-z0-9-]{0,31}$",
      });
    }
  });
});
