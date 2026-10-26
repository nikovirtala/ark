import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JsonValue } from "../errors.js";
import type { StateHeader } from "../surfaces/header.js";

export interface McpContext {
  /** `clientInfo` from `initialize`; `null` before it (never, in practice). */
  readonly client: { readonly name: string; readonly version: string } | null;
  /** The server process's environment (`McpServeOptions.env`). */
  readonly env: NodeJS.ProcessEnv;
}

export interface McpAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpTool {
  /** `<spec.name>_<verb>`, checked at startup. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** JSON Schema (2020-12 keywords) with `type: "object"` at the top; compiled at startup. */
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  /**
   * One sentence appended to every schema-failure message, for rules ajv words poorly (for
   * example `adr_scope needs id and at least one of set, add or remove`).
   */
  readonly inputHint?: string;
  readonly annotations?: McpAnnotations;
  run(input: Readonly<Record<string, JsonValue>>, ctx: McpContext): Promise<McpToolResult>;
}

export interface McpToolResult {
  /** The tool's document: the CLI's `--json` document, unchanged. Must be a JSON object. */
  readonly document: JsonValue;
  /** State headers to lead the text, in order; `[]` when the result shows no subject. */
  readonly headers: readonly StateHeader[];
  /** The rest of the readable text (summary, body). */
  readonly text: string;
}

export interface McpResourceContent {
  readonly header: StateHeader | null;
  readonly text: string;
}

export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly mimeType: string;
  read(ctx: McpContext): Promise<McpResourceContent>;
}

export interface McpResourceTemplate {
  /** For example `adr://decision/{id}`: each variable fills a whole path segment. */
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly mimeType: string;
  /** `null` means the resource doesn't exist (−32002). */
  read(
    params: Readonly<Record<string, string>>,
    ctx: McpContext,
  ): Promise<McpResourceContent | null>;
}

export interface McpPromptArgument {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

export interface McpPrompt {
  /** `<spec.name>_<verb>`, like a tool. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly arguments: readonly McpPromptArgument[];
  /** The text of the single user message. */
  get(args: Readonly<Record<string, string>>, ctx: McpContext): Promise<string>;
}

export interface McpServerSpec {
  /** The tool's name, such as `adr`: the server name and the prefix of every tool and prompt. */
  readonly name: string;
  readonly version: string;
  readonly instructions?: string;
  readonly tools: readonly McpTool[];
  /** Tools the server knows but doesn't list, each with the reason a call gets. */
  readonly unavailable?: Readonly<Record<string, string>>;
  readonly resources?: readonly McpResource[];
  readonly resourceTemplates?: readonly McpResourceTemplate[];
  readonly prompts?: readonly McpPrompt[];
}

export interface McpServeOptions {
  /** Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Default `process.stderr`. */
  readonly stderr?: { write(s: string): void };
  /** Default: a `StdioServerTransport` on `process.stdin` and `process.stdout`. */
  readonly transport?: Transport;
}
