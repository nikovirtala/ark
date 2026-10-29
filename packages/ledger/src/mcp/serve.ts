import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { InvalidArgumentError, type JsonValue, LedgerError, UsageError } from "../errors.js";
import { invalidateGitOperation, withNewGitOperation } from "../git/operation.js";
import { renderStateHeader } from "../surfaces/header.js";
import { errorResult, toolResult } from "./results.js";
import type {
  McpContext,
  McpPrompt,
  McpResourceContent,
  McpServeOptions,
  McpServerSpec,
  McpTool,
} from "./types.js";
import { compileUriTemplate, type UriTemplate } from "./uri.js";
import { compileInputSchema, formatInputErrors } from "./validate.js";

/** MCP's code for a resource that doesn't exist. */
const RESOURCE_NOT_FOUND = -32002;
const MAX_PROMPT_ARGUMENT = 1000;

const SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The prefix rule of tool and prompt names (`<tool>_<verb>`); hyphens in the tool become `_`. */
function namePattern(server: string): RegExp {
  return new RegExp(`^${server.replace(/-/g, "_")}_[a-z][a-z0-9_]{0,47}$`);
}

/** The spec checks: a bad spec is a bug in the tool, reported at startup. */
function checkSpec(spec: McpServerSpec): {
  validators: Map<string, ValidateFunction>;
  templates: UriTemplate[];
} {
  if (!SERVER_NAME.test(spec.name)) {
    throw new InvalidArgumentError(`MCP server name ${JSON.stringify(spec.name)} is invalid`);
  }
  const pattern = namePattern(spec.name);
  const names = new Set<string>();
  const claim = (what: string, name: string) => {
    if (!pattern.test(name)) {
      throw new InvalidArgumentError(
        `${spec.name}: ${what} name ${JSON.stringify(name)} must match ${pattern.source}`,
      );
    }
    if (names.has(name)) throw new InvalidArgumentError(`${spec.name}: ${name} is defined twice`);
    names.add(name);
  };
  const validators = new Map<string, ValidateFunction>();
  for (const tool of spec.tools) {
    claim("tool", tool.name);
    if (
      tool.inputHint !== undefined &&
      (tool.inputHint.length < 1 || tool.inputHint.length > 200 || /[\r\n]/.test(tool.inputHint))
    ) {
      throw new InvalidArgumentError(
        `tool ${tool.name}: inputHint must be one line of 1-200 characters`,
      );
    }
    validators.set(tool.name, compileInputSchema(tool.name, tool.inputSchema));
  }
  for (const name of Object.keys(spec.unavailable ?? {})) claim("tool", name);
  for (const prompt of spec.prompts ?? []) claim("prompt", prompt.name);
  const uris = new Set<string>();
  for (const uri of [
    ...(spec.resources ?? []).map((r) => r.uri),
    ...(spec.resourceTemplates ?? []).map((r) => r.uriTemplate),
  ]) {
    if (uris.has(uri))
      throw new InvalidArgumentError(`${spec.name}: resource ${uri} is defined twice`);
    uris.add(uri);
  }
  const templates = (spec.resourceTemplates ?? []).map((r) => compileUriTemplate(r.uriTemplate));
  return { validators, templates };
}

/**
 * How a resource read's or prompt get's exception reaches the client: a usage error is the
 * caller's (−32602), another ledger error or a bug is the server's (−32603), a bug also on stderr.
 */
function requestError(
  err: unknown,
  o: { readonly server: string; readonly stderr: { write(s: string): void } },
): McpError {
  if (err instanceof McpError) return err;
  if (err instanceof UsageError) return new McpError(ErrorCode.InvalidParams, err.message);
  if (err instanceof LedgerError) {
    return new McpError(ErrorCode.InternalError, `${err.code}: ${err.message}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack !== undefined ? `${err.stack}\n` : "";
  o.stderr.write(`${o.server}: internal error: ${message}\n${stack}`);
  return new McpError(ErrorCode.InternalError, `internal error: ${message}`);
}

const resourceText = (c: McpResourceContent) =>
  c.header === null ? c.text : `${renderStateHeader(c.header)}\n${c.text}`;

/** The prompt's arguments, checked: declared names only, required ones present, short, no NUL. */
function promptArguments(
  prompt: McpPrompt,
  given: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const args = { ...(given ?? {}) };
  const declared = new Set(prompt.arguments.map((a) => a.name));
  const invalid = (why: string) => new McpError(ErrorCode.InvalidParams, `${prompt.name}: ${why}`);
  for (const [name, value] of Object.entries(args)) {
    if (!declared.has(name)) throw invalid(`unknown argument ${name}`);
    if (typeof value !== "string") throw invalid(`argument ${name} must be a string`);
    if (value.length > MAX_PROMPT_ARGUMENT) {
      throw invalid(`argument ${name} is longer than ${MAX_PROMPT_ARGUMENT} characters`);
    }
    if (value.includes("\0")) throw invalid(`argument ${name} contains a NUL character`);
  }
  for (const a of prompt.arguments) {
    if (a.required && !Object.hasOwn(args, a.name)) throw invalid(`missing argument ${a.name}`);
  }
  return args;
}

/** Runs tasks one at a time, in the order they were queued. */
function serialQueue(): {
  run<T>(task: () => Promise<T>): Promise<T>;
  idle(): Promise<void>;
} {
  let tail: Promise<void> = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(task);
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    idle: () => tail,
  };
}

function listedTool(t: McpTool): Record<string, unknown> {
  return {
    name: t.name,
    ...(t.title === undefined ? {} : { title: t.title }),
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations === undefined ? {} : { annotations: t.annotations }),
  };
}

/**
 * Serves `spec` as an MCP server until stdin ends or the transport closes. Tool input is checked
 * against the tool's schema, calls run one at a time in arrival order, and a tool's document is
 * its `structuredContent`; errors become `isError` results with `ark-error/v1`. Throws
 * `InvalidArgumentError` for a bad spec before serving.
 */
export async function serveMcp(spec: McpServerSpec, o: McpServeOptions = {}): Promise<void> {
  const { validators, templates } = checkSpec(spec);
  // Each request runs in its own git operation, even under a CLI command's (`issues mcp`). End
  // the outer operation's generation here, so its resident processes exit instead of idling.
  invalidateGitOperation();
  const env = o.env ?? process.env;
  const stderr = o.stderr ?? process.stderr;
  const tools = new Map(spec.tools.map((t) => [t.name, t]));
  const unavailable = spec.unavailable ?? {};
  const queue = serialQueue();
  const resources = spec.resources ?? [];
  const resourceTemplates = spec.resourceTemplates ?? [];
  const prompts = spec.prompts ?? [];
  const fail = { server: spec.name, stderr };

  const server = new Server(
    { name: spec.name, version: spec.version },
    {
      capabilities: {
        tools: {},
        ...(resources.length > 0 || resourceTemplates.length > 0 ? { resources: {} } : {}),
        ...(prompts.length > 0 ? { prompts: {} } : {}),
      },
      ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
    },
  );
  const context = (): McpContext => {
    const client = server.getClientVersion();
    return {
      client: client === undefined ? null : { name: client.name, version: client.version },
      env,
    };
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: spec.tools.map(listedTool) as never,
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    queue.run(() =>
      withNewGitOperation(async () => {
        const { name } = req.params;
        const tool = tools.get(name);
        if (tool === undefined) {
          const reason = Object.hasOwn(unavailable, name) ? unavailable[name] : undefined;
          throw new McpError(
            ErrorCode.InvalidParams,
            reason === undefined ? `unknown tool ${name}` : `${name} is not available: ${reason}`,
          );
        }
        const input = (req.params.arguments ?? {}) as Record<string, JsonValue>;
        const validate = validators.get(name);
        if (validate !== undefined && !validate(input)) {
          const message = formatInputErrors(tool, validate.errors ?? []);
          return errorResult(new UsageError(message), fail);
        }
        try {
          return toolResult(name, await tool.run(input, context()));
        } catch (err) {
          return errorResult(err, fail);
        }
      }),
    ),
  );

  if (resources.length > 0 || resourceTemplates.length > 0) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        ...(r.title === undefined ? {} : { title: r.title }),
        description: r.description,
        mimeType: r.mimeType,
      })),
    }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: resourceTemplates.map((r) => ({
        uriTemplate: r.uriTemplate,
        name: r.name,
        ...(r.title === undefined ? {} : { title: r.title }),
        description: r.description,
        mimeType: r.mimeType,
      })),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, (req) =>
      queue.run(() =>
        withNewGitOperation(async () => {
          const { uri } = req.params;
          const notFound = () => new McpError(RESOURCE_NOT_FOUND, `resource not found: ${uri}`);
          let content: McpResourceContent | null = null;
          let mimeType = "";
          try {
            const exact = resources.find((r) => r.uri === uri);
            if (exact !== undefined) {
              mimeType = exact.mimeType;
              content = await exact.read(context());
            } else {
              const i = templates.findIndex((t) => t.match(uri) !== null);
              const template = resourceTemplates[i];
              if (template === undefined) throw notFound();
              mimeType = template.mimeType;
              content = await template.read(templates[i]?.match(uri) ?? {}, context());
            }
          } catch (err) {
            throw requestError(err, fail);
          }
          if (content === null) throw notFound();
          return { contents: [{ uri, mimeType, text: resourceText(content) }] };
        }),
      ),
    );
  }
  if (prompts.length > 0) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: prompts.map((p) => ({
        name: p.name,
        ...(p.title === undefined ? {} : { title: p.title }),
        description: p.description,
        arguments: p.arguments.map((a) => ({ ...a })),
      })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, (req) =>
      queue.run(() =>
        withNewGitOperation(async () => {
          const prompt = prompts.find((p) => p.name === req.params.name);
          if (prompt === undefined) {
            throw new McpError(ErrorCode.InvalidParams, `unknown prompt ${req.params.name}`);
          }
          const args = promptArguments(prompt, req.params.arguments);
          let text: string;
          try {
            text = await prompt.get(args, context());
          } catch (err) {
            throw requestError(err, fail);
          }
          return {
            description: prompt.description,
            messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
          };
        }),
      ),
    );
  }

  await serve(server, queue, { stderr, name: spec.name, transport: o.transport });
}

/** Connects and waits until the client goes away, then closes after the running request. */
async function serve(
  server: Server,
  queue: { idle(): Promise<void> },
  o: {
    readonly stderr: { write(s: string): void };
    readonly name: string;
    readonly transport: Transport | undefined;
  },
): Promise<void> {
  const { promise: ended, resolve: end } = Promise.withResolvers<void>();
  server.onclose = () => end();
  server.onerror = (err) => o.stderr.write(`${o.name}: warning: ${err.message}\n`);
  let transport = o.transport;
  if (transport === undefined) {
    transport = new StdioServerTransport();
    // StdioServerTransport doesn't watch for the end of stdin, so the process would stay up
    // after the client closed it.
    process.stdin.once("end", () => end());
    process.stdin.once("close", () => end());
  }
  await server.connect(transport);
  await ended;
  await queue.idle();
  await server.close();
}
