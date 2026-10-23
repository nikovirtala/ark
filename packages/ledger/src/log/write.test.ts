import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { EventExistsError, InvalidArgumentError } from "../errors.js";
import { compareEvents } from "../fold/fold.js";
import { indexReader } from "../git/tree.js";
import { formatAt } from "../identity/time.js";
import { createUlidFactory, ulidTime } from "../identity/ulid.js";
import { exampleLayout as layout } from "../testing/example-kind.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { nextEventIdentity, writeEvent } from "./write.js";

const event: EventEnvelope = {
  envelope: "ledger/v1",
  kind: "widget",
  schema: "widget/v1",
  id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
  subject: "a7c2m9xd",
  type: "created",
  at: "2026-03-14T12:02:11Z",
  actor: { kind: "human", name: "Ada" },
  data: { title: "A widget" },
};
const PATH = "log/events/a7c2m9xd/20260314T120211Z-q8a1-created.yaml";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  repos.push(r);
  return r;
}

const staged = async (r: TempRepo) =>
  (await (await indexReader(r.git)).list("log")).map((e) => e.path);

describe("writeEvent", () => {
  it("writes the serialized event at its path without staging it", async () => {
    const r = await repo();
    expect(await writeEvent(r.git, layout, event)).toBe(PATH);
    expect(await readFile(join(r.root, PATH), "utf8")).toBe(serializeEvent(event));
    expect(await staged(r)).toEqual([]);
  });

  it("stages the file with stage", async () => {
    const r = await repo();
    await writeEvent(r.git, layout, event, { stage: true });
    expect(await staged(r)).toEqual([PATH]);
  });

  it("never overwrites an existing file", async () => {
    const r = await repo();
    await writeEvent(r.git, layout, event);
    const again = writeEvent(r.git, layout, { ...event, data: { title: "other" } });
    await expect(again).rejects.toBeInstanceOf(EventExistsError);
    await expect(again).rejects.toMatchObject({ code: "event-exists", path: PATH });
    expect(await readFile(join(r.root, PATH), "utf8")).toBe(serializeEvent(event));
  });

  it("refuses an invalid event and writes nothing", async () => {
    const r = await repo();
    const bad = { ...event, actor: { kind: "agent" as const, name: "bot" } };
    await expect(writeEvent(r.git, layout, bad)).rejects.toThrow(
      "refusing to write an invalid event: /actor: must have required property 'agent'",
    );
    await expect(
      writeEvent(r.git, layout, { ...event, envelope: "ledger/v2" as "ledger/v1" }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(stat(join(r.root, "log"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("needs a work tree", async () => {
    const bare = await repo({ bare: true });
    await expect(writeEvent(bare.git, layout, event)).rejects.toThrow(
      "operation needs a work tree",
    );
  });
});

describe("nextEventIdentity", () => {
  const NOW = Date.parse("2026-03-14T12:02:11.250Z");
  const idAt = (ms: number) => createUlidFactory({ now: () => ms })();

  it("uses the clock when there is nothing earlier", () => {
    const { at, id } = nextEventIdentity([], { now: () => NOW });
    expect(at).toBe("2026-03-14T12:02:11Z");
    expect(ulidTime(id)).toBe(NOW);
  });

  it("uses the clock when the previous events are older", () => {
    const previous = [{ at: "2026-03-14T12:02:10Z", id: idAt(NOW + 5000) }];
    const { at, id } = nextEventIdentity(previous, { now: () => NOW });
    expect(at).toBe(formatAt(NOW));
    expect(ulidTime(id)).toBe(NOW);
  });

  it("moves the ULID time past the latest id on an equal at", () => {
    const latest = idAt(NOW + 500);
    const previous = [
      { at: formatAt(NOW), id: idAt(NOW - 100) },
      { at: formatAt(NOW), id: latest },
    ];
    const next = nextEventIdentity(previous, { now: () => NOW });
    expect(next.at).toBe(formatAt(NOW));
    expect(ulidTime(next.id)).toBe(NOW + 501);
    expect(next.id > latest).toBe(true);
  });

  it("keeps the latest at when the clock steps back", () => {
    const later = Date.parse("2026-03-14T13:00:00Z");
    const previous = [{ at: formatAt(later), id: idAt(later) }];
    const next = nextEventIdentity(previous, { now: () => NOW });
    expect(next.at).toBe(formatAt(later));
    expect(ulidTime(next.id)).toBe(later + 1);
  });

  it("takes its random part from the injected source", () => {
    const random = (b: Uint8Array) => b.fill(0);
    const a = nextEventIdentity([], { now: () => NOW, random });
    expect(a).toEqual(nextEventIdentity([], { now: () => NOW, random }));
    expect(a.id.slice(-16)).toBe("0000000000000000");
  });

  it("always sorts after every previous event, whatever the clock does", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: Date.parse("2001-01-01"), max: Date.parse("2090-01-01") }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.boolean(),
        (clock, ties) => {
          const previous: { at: string; id: string }[] = [];
          for (const [i, t] of clock.entries()) {
            const now = ties && i > 0 ? (clock[i - 1] ?? t) : t;
            const next = nextEventIdentity(previous, { now: () => now });
            for (const p of previous) expect(compareEvents(next, p)).toBe(1);
            previous.push(next);
          }
        },
      ),
    );
  });
});
