/**
 * A fake GitHub REST API for deployments, over HTTP on 127.0.0.1, so the real `githubRestApi` client
 * is tested with real requests: it checks the token, the API version header and the bodies, and keeps
 * deployments and statuses as GitHub does (newest first in lists).
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface FakeDeployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  description: string;
  production_environment: boolean;
  required_contexts: unknown;
  auto_merge: unknown;
}

export interface FakeStatus {
  id: number;
  deployment: number;
  state: string;
  description: string;
  log_url?: string;
  environment: string;
  auto_inactive: unknown;
}

export interface FakeGitHub {
  readonly url: string;
  readonly deployments: FakeDeployment[];
  readonly statuses: FakeStatus[];
  readonly requests: string[];
  /** Answer every request with this status, to test failures. */
  failWith: number | undefined;
  /** The newest state of every deployment, by id. */
  states(): Record<number, string | undefined>;
  close(): Promise<void>;
}

const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length
    ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
    : {};
};

export async function startFakeGitHub(repository: string, token: string): Promise<FakeGitHub> {
  const deployments: FakeDeployment[] = [];
  const statuses: FakeStatus[] = [];
  const requests: string[] = [];
  let next = 100;
  const state = {
    failWith: undefined as number | undefined,
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (state.failWith) return send(state.failWith, { message: "Server Error" });
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(401, { message: "Bad credentials" });
    if (req.headers["x-github-api-version"] !== "2022-11-28")
      return send(400, { message: "no API version" });
    const base = `/repos/${repository}/deployments`;
    if (req.method === "POST" && url.pathname === base) {
      const b = await body(req);
      if (typeof b.ref !== "string" || typeof b.environment !== "string")
        return send(422, { message: "Validation Failed" });
      const d: FakeDeployment = {
        id: next++,
        sha: b.ref,
        ref: b.ref,
        environment: b.environment,
        description: String(b.description ?? ""),
        production_environment: Boolean(b.production_environment),
        required_contexts: b.required_contexts,
        auto_merge: b.auto_merge,
      };
      deployments.push(d);
      return send(201, d);
    }
    if (req.method === "GET" && url.pathname === base) {
      const env = url.searchParams.get("environment");
      return send(
        200,
        [...deployments].reverse().filter((d) => !env || d.environment === env),
      );
    }
    const m = new RegExp(`^${base}/(\\d+)/statuses$`).exec(url.pathname);
    if (m) {
      const id = Number(m[1]);
      if (!deployments.some((d) => d.id === id)) return send(404, { message: "Not Found" });
      if (req.method === "POST") {
        const b = await body(req);
        const description = String(b.description ?? "");
        if (description.length > 140)
          return send(422, { message: "description is too long (maximum is 140 characters)" });
        const s: FakeStatus = {
          id: next++,
          deployment: id,
          state: String(b.state),
          description,
          ...(typeof b.log_url === "string" ? { log_url: b.log_url } : {}),
          environment: String(b.environment ?? ""),
          auto_inactive: b.auto_inactive,
        };
        statuses.push(s);
        return send(201, s);
      }
      const list = statuses.filter((s) => s.deployment === id).reverse();
      return send(200, list.slice(0, Number(url.searchParams.get("per_page") ?? 30)));
    }
    send(404, { message: "Not Found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    deployments,
    statuses,
    requests,
    get failWith() {
      return state.failWith;
    },
    set failWith(v) {
      state.failWith = v;
    },
    states: () =>
      Object.fromEntries(
        deployments.map((d) => [d.id, statuses.filter((s) => s.deployment === d.id).at(-1)?.state]),
      ),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
