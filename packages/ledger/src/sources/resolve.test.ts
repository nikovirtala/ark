import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import { MemoryTree } from "../git/tree.js";
import type { LogLayout } from "../identity/layout.js";
import type { FetchedSource } from "./fetch.js";
import { type LogRef, resolveQualifiedId, sourceLogRef } from "./resolve.js";

const layout: LogLayout = { root: "docs/adr", bodies: "decisions", events: "events" };

const local: LogRef = {
  name: null,
  kind: "adr",
  layout,
  commit: null,
  tree: new MemoryTree({
    "docs/adr/events/a7c2m9xd/20260314T120211Z-q8a1-proposed.yaml": "x",
    "docs/adr/decisions/b4n8r2kd-body-only.md": "# Body only\n",
    "docs/adr/decisions/sub/c5p9s3me-nested.md": "# Nested\n",
  }),
};
const platform: LogRef = {
  name: "platform",
  kind: "adr",
  layout: { root: "adr", bodies: null, events: "events" },
  commit: "0".repeat(40),
  tree: new MemoryTree({ "adr/events/k3f9q8a1/.gitkeep": "" }),
};
const logs = { local, sources: new Map([["platform", platform]]) };

describe("resolveQualifiedId", () => {
  it("resolves a bare id in the local log", async () => {
    expect(await resolveQualifiedId("a7c2m9xd", logs)).toEqual({
      ok: true,
      log: local,
      subject: "a7c2m9xd",
    });
  });

  it("finds a subject by its body file alone", async () => {
    expect(await resolveQualifiedId("b4n8r2kd", logs)).toMatchObject({ ok: true });
    expect(await resolveQualifiedId("c5p9s3me", logs)).toMatchObject({ reason: "not-found" });
  });

  it("resolves a qualified id in its source", async () => {
    expect(await resolveQualifiedId("platform:k3f9q8a1", logs)).toEqual({
      ok: true,
      log: platform,
      subject: "k3f9q8a1",
    });
    expect(await resolveQualifiedId("k3f9q8a1", logs)).toMatchObject({ reason: "not-found" });
  });

  it.each<[string, string]>([
    ["platform:a7c2m9xd", "not-found"],
    ["payments:a7c2m9xd", "unknown-source"],
    ["A7C2M9XD", "malformed"],
    ["platform:", "malformed"],
  ])("reports %j as %s", async (input, reason) => {
    expect(await resolveQualifiedId(input, logs)).toEqual({ ok: false, reason, input });
  });
});

describe("sourceLogRef", () => {
  const fetched = (root: string | null): FetchedSource => ({
    config: { name: "platform", kind: "adr", url: "../p.git", ref: "main", root },
    commit: "1".repeat(40),
    tree: new MemoryTree({}),
    stale: false,
    staleReason: null,
    cacheDir: "/tmp/cache.git",
  });
  const kindLayout = { bodies: "decisions", events: "events" };

  it("uses the configured root, else the default root", () => {
    expect(
      sourceLogRef(fetched("records/adr"), { layout: kindLayout, defaultRoot: "docs/adr" }),
    ).toMatchObject({
      name: "platform",
      kind: "adr",
      commit: "1".repeat(40),
      layout: { root: "records/adr", bodies: "decisions", events: "events" },
    });
    expect(
      sourceLogRef(fetched(null), { layout: kindLayout, defaultRoot: "docs/adr/" }).layout.root,
    ).toBe("docs/adr");
  });

  it("throws ConfigError without any root", () => {
    expect(() => sourceLogRef(fetched(null), { layout: kindLayout })).toThrow(ConfigError);
  });
});
