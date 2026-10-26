import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { InvalidArgumentError, type JsonValue } from "../errors.js";

const MAX_ERRORS = 5;

let ajv: Ajv2020 | null = null;

/**
 * Compiles a tool's input schema with ajv's 2020-12 dialect in strict mode, so a schema keyword
 * ajv would ignore is a startup error. Throws `InvalidArgumentError` for a schema that doesn't
 * compile or whose top level isn't `type: "object"`.
 */
export function compileInputSchema(
  tool: string,
  schema: Readonly<Record<string, JsonValue>>,
): ValidateFunction {
  if (schema.type !== "object") {
    throw new InvalidArgumentError(`tool ${tool}: the input schema must have type "object"`);
  }
  ajv ??= new Ajv2020({ strict: true, allErrors: true });
  try {
    return ajv.compile(schema);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new InvalidArgumentError(`tool ${tool}: the input schema doesn't compile: ${why}`, {
      cause: err,
    });
  }
}

/**
 * `invalid input for <tool>: <path> <message>; …` with at most five problems (`/` for the root),
 * then `. <hint>` when the tool has one.
 */
export function formatInputErrors(
  tool: { readonly name: string; readonly inputHint?: string },
  errors: readonly ErrorObject[],
): string {
  const problems = errors
    .slice(0, MAX_ERRORS)
    .map((e) => `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? "is invalid"}`);
  const more = errors.length > MAX_ERRORS ? `; and ${errors.length - MAX_ERRORS} more` : "";
  const hint = tool.inputHint === undefined ? "" : `. ${tool.inputHint}`;
  return `invalid input for ${tool.name}: ${problems.join("; ")}${more}${hint}`;
}
