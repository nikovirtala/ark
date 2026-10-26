import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { InvalidArgumentError, type JsonValue, UsageError } from "../errors.js";
import { errorResult, toolResult } from "./results.js";
import type { McpContext, McpServeOptions, McpServerSpec, McpTool } from "./types.js";
import { compileInputSchema, formatInputErrors } from "./validate.js";

const SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The prefix rule of tool and prompt names (`<tool>_<verb>`); hyphens in the tool become `_`. */
function namePattern(server: string): RegExp {
  return new RegExp(`^${server.replace(/-/g, "_")}_[a-z][a-z0-9_]{0,47}$`);
}

/** The spec checks: a bad spec is a bug in the tool, reported at startup. */
function checkSpec(spec: McpServerSpec): Map<string, ValidateFunction> {
  if (!SERVER_NAME.test(spec.name)) {
    throw new InvalidArgumentError(`MCP server name ${JSON.stringify(spec.name)} is invalid`);
  }
  if (
    (spec.resources?.length ?? 0) > 0 ||
    (spec.resourceTemplates?.length ?? 0) > 0 ||
    (spec.prompts?.length ?? 0) > 0
  ) {
    throw new InvalidArgumentError(`${spec.name}: MCP resources and prompts are not supported yet`);
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
  return validators;
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
  const validators = checkSpec(spec);
  const env = o.env ?? process.env;
  const stderr = o.stderr ?? process.stderr;
  const tools = new Map(spec.tools.map((t) => [t.name, t]));
  const unavailable = spec.unavailable ?? {};
  const queue = serialQueue();

  const server = new Server(
    { name: spec.name, version: spec.version },
    {
      capabilities: { tools: {} },
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
    queue.run(async () => {
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
        return errorResult(new UsageError(message), { server: spec.name, stderr });
      }
      try {
        return toolResult(name, await tool.run(input, context()));
      } catch (err) {
        return errorResult(err, { server: spec.name, stderr });
      }
    }),
  );

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
