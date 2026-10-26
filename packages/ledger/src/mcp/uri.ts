import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { InvalidArgumentError } from "../errors.js";

export interface UriTemplate {
  readonly template: string;
  /** The variables of a matching URI, `%`-decoded; `null` when it doesn't match. */
  match(uri: string): Record<string, string> | null;
}

const VARIABLE = /\{([^{}]*)\}/g;
const NAME = /^[a-z][a-z0-9_]*$/;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compiles a level-1 RFC 6570 template whose variables each fill a whole path segment, such as
 * `adr://decision/{id}`. A URI matches when the literal parts are equal and each variable's
 * segment is non-empty without `/`, `?` or `#`. Anything richer is an `InvalidArgumentError`; a
 * matching URI with a malformed `%` escape is `McpError` −32602.
 */
export function compileUriTemplate(template: string): UriTemplate {
  const bad = (why: string) =>
    new InvalidArgumentError(`resource template ${JSON.stringify(template)}: ${why}`);
  const names: string[] = [];
  let pattern = "";
  let last = 0;
  for (const m of template.matchAll(VARIABLE)) {
    const literal = template.slice(last, m.index);
    const name = m[1] ?? "";
    if (!NAME.test(name)) throw bad(`variable {${name}} must match ${NAME.source}`);
    if (names.includes(name)) throw bad(`variable {${name}} appears twice`);
    const after = template[m.index + m[0].length];
    if (!literal.endsWith("/") || (after !== undefined && after !== "/")) {
      throw bad(`variable {${name}} must fill a whole path segment`);
    }
    names.push(name);
    pattern += `${escapeRegExp(literal)}([^/?#]+)`;
    last = m.index + m[0].length;
  }
  const rest = template.slice(last);
  if (/[{}]/.test(template.replace(VARIABLE, ""))) throw bad("unbalanced braces");
  if (names.length === 0) throw bad("it has no variables; list it as a resource");
  const re = new RegExp(`^${pattern}${escapeRegExp(rest)}$`);
  return {
    template,
    match(uri) {
      const m = re.exec(uri);
      if (m === null) return null;
      const params: Record<string, string> = {};
      names.forEach((name, i) => {
        try {
          params[name] = decodeURIComponent(m[i + 1] ?? "");
        } catch {
          throw new McpError(ErrorCode.InvalidParams, `malformed resource URI ${uri}`);
        }
      });
      return params;
    },
  };
}
