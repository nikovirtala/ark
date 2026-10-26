import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { compileUriTemplate } from "./uri.js";

describe("compileUriTemplate", () => {
  it.each([
    "adr://decision/{Id}",
    "adr://decision/{}",
    "adr://decision/x{id}",
    "adr://decision/{id}x",
    "adr://decision/{id}/{id}",
    "adr://decision/{id",
    "adr://decision/id}",
    "adr://index",
    "adr://decision/{+id}",
  ])("rejects %s", (t) => {
    expect(() => compileUriTemplate(t)).toThrow(InvalidArgumentError);
  });

  it("matches whole segments and decodes them", () => {
    const t = compileUriTemplate("adr://decision/{id}");
    expect(t.match("adr://decision/12")).toEqual({ id: "12" });
    expect(t.match("adr://decision/ADR-0012")).toEqual({ id: "ADR-0012" });
    expect(t.match("adr://decision/a%3Ab")).toEqual({ id: "a:b" });
    for (const uri of [
      "adr://decision/",
      "adr://decision/a/b",
      "adr://decision/a?x",
      "adr://decision/a#x",
      "adr://decisionx/a",
      "xadr://decision/a",
    ]) {
      expect(t.match(uri), uri).toBeNull();
    }
  });

  it("matches several variables and literal tails", () => {
    const t = compileUriTemplate("x://{a}/b.c/{d}/e");
    expect(t.match("x://1/b.c/2/e")).toEqual({ a: "1", d: "2" });
    expect(t.match("x://1/bxc/2/e")).toBeNull();
  });

  it("reports a malformed escape as -32602", () => {
    const t = compileUriTemplate("adr://decision/{id}");
    let err: unknown = null;
    try {
      t.match("adr://decision/%E0%A4%A");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(-32602);
    expect((err as McpError).message).toContain("malformed resource URI adr://decision/%E0%A4%A");
  });
});
