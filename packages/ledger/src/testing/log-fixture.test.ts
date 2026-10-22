import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import { InvalidArgumentError } from "../errors.js";
import { MemoryTree } from "../git/tree.js";
import { eventFileName, parseBodyFileName } from "../identity/files.js";
import { bodySha256 } from "../identity/hash.js";
import { loadLog } from "../log/snapshot.js";
import { exampleKind, exampleLayout } from "./example-kind.js";
import {
  arbEventSequence,
  arbLogFixture,
  type LogFixtureSubjectInput,
  logFixtureFiles,
} from "./log-fixture.js";

const kind = compileKind(exampleKind);
const fixtures = () => arbLogFixture({ kind: exampleKind, layout: exampleLayout });

describe("arbLogFixture", () => {
  it("produces logs that load without findings", async () => {
    await fc.assert(
      fc.asyncProperty(fixtures(), async (fixture) => {
        const snap = await loadLog(new MemoryTree(fixture.files), { kind, layout: fixture.layout });
        const all = [
          ...snap.structural,
          ...[...snap.subjects.values()].flatMap((s) => [
            ...s.findings,
            ...s.events.flatMap((e) => e.findings),
          ]),
        ];
        expect(all).toEqual([]);
        expect([...snap.subjects.keys()].sort()).toEqual(fixture.subjects.map((s) => s.id).sort());
      }),
    );
  });

  it("describes exactly the files logFixtureFiles writes", () => {
    fc.assert(
      fc.property(fixtures(), (fixture) => {
        const inputs = fixture.subjects.map((s): LogFixtureSubjectInput => {
          const body = s.bodyPath === null ? undefined : fixture.files[s.bodyPath];
          const slug =
            s.bodyPath === null
              ? ""
              : (parseBodyFileName(s.bodyPath.split("/").pop() ?? "")?.slug ?? "");
          return {
            id: s.id,
            slug,
            ...(body === undefined ? {} : { body }),
            events: s.events.map((e) => e.event),
          };
        });
        expect(logFixtureFiles({ layout: fixture.layout, subjects: inputs })).toEqual(
          fixture.files,
        );
      }),
    );
  });

  it("records frozen subjects with matching hashes on every freeze event", () => {
    fc.assert(
      fc.property(fixtures(), (fixture) => {
        for (const s of fixture.subjects) {
          const freezes = s.events.filter((e) => e.event.type === "frozen");
          expect(s.frozen).toBe(freezes.length > 0);
          if (freezes.length === 0) continue;
          const body = s.bodyPath === null ? undefined : fixture.files[s.bodyPath];
          expect(body).toBeDefined();
          const hash = bodySha256(new TextEncoder().encode(body ?? ""));
          for (const e of freezes) expect(e.event.data.body_sha256).toBe(hash);
        }
      }),
    );
  });

  it("rejects a layout that doesn't match the kind's body policy", () => {
    expect(() =>
      arbLogFixture({ kind: exampleKind, layout: { ...exampleLayout, bodies: null } }),
    ).toThrow(InvalidArgumentError);
  });
});

describe("arbEventSequence", () => {
  it("produces valid events of one subject in file-name order", () => {
    fc.assert(
      fc.property(arbEventSequence({ kind: exampleKind, subject: "a7c2m9xd" }), (events) => {
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) {
          expect(kind.validate(e, { file: null }).ok).toBe(true);
          expect(e.subject).toBe("a7c2m9xd");
        }
        const names = events.map(eventFileName);
        expect(names).toEqual([...names].sort());
        expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
      }),
    );
  });
});

describe("logFixtureFiles", () => {
  it("rejects two files at one path", () => {
    fc.assert(
      fc.property(arbEventSequence({ kind: exampleKind, maxLength: 1 }), ([e]) => {
        if (e === undefined) return;
        expect(() =>
          logFixtureFiles({ layout: exampleLayout, subjects: [{ id: e.subject, events: [e, e] }] }),
        ).toThrow(InvalidArgumentError);
      }),
      { numRuns: 5 },
    );
  });
});
