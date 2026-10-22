import fc from "fast-check";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { InvalidArgumentError } from "../errors.js";
import { bodyFileName, formatEventFileName, parseEventFileName } from "../identity/files.js";
import { bodySha256 } from "../identity/hash.js";
import { eventDir, eventPath } from "../identity/layout.js";
import { formatAt } from "../identity/time.js";
import { arbSlug, arbSubjectId, arbUlid } from "./arbitraries.js";
import {
  allTypes,
  arbRandomHash,
  arbSubjectEvents,
  freezePolicy,
  type LogFixture,
} from "./log-fixture.js";

/**
 * A mechanical tampering of a log. Mutations that add a file carry its `path` and `content`, so
 * `applyTamper` needs nothing but the file map.
 */
export type TamperMutation =
  | { readonly type: "modify-event"; readonly path: string }
  | { readonly type: "delete-event"; readonly path: string }
  | { readonly type: "rename-event"; readonly path: string; readonly to: string }
  | { readonly type: "edit-frozen-body"; readonly subject: string; readonly path: string }
  | { readonly type: "delete-frozen-body"; readonly subject: string; readonly path: string }
  /** A new freeze-type event recording a wrong body hash; no existing file changes. */
  | {
      readonly type: "wrong-hash";
      readonly subject: string;
      readonly path: string;
      readonly content: string;
    }
  /** A new event file at `path` reusing the id of the event at `from`. */
  | {
      readonly type: "duplicate-event-id";
      readonly path: string;
      readonly from: string;
      readonly content: string;
    }
  /** A second body file for an existing subject id. */
  | {
      readonly type: "duplicate-subject-id";
      readonly subject: string;
      readonly path: string;
      readonly content: string;
    };

/** The rules verify may report for each mutation; at least one fires, as an error. */
export const expectedRules: Readonly<Record<TamperMutation["type"], readonly string[]>> =
  Object.freeze({
    "modify-event": ["append-only/modified"],
    "delete-event": ["append-only/deleted"],
    "rename-event": [
      "append-only/deleted",
      "identity/file-name-mismatch",
      "identity/subject-mismatch",
    ],
    "edit-frozen-body": ["body/frozen-modified", "body/hash-mismatch"],
    "delete-frozen-body": ["body/frozen-deleted", "body/missing"],
    "wrong-hash": ["body/hash-mismatch"],
    "duplicate-event-id": ["identity/duplicate-event-id"],
    "duplicate-subject-id": ["identity/duplicate-subject-id"],
  });

/** A new map with `m` applied; `files` is never mutated. */
export function applyTamper(
  files: Readonly<Record<string, string>>,
  m: TamperMutation,
): Record<string, string> {
  const out = { ...files };
  const existing = (path: string): string => {
    const content = out[path];
    if (content === undefined) throw new InvalidArgumentError(`no file at ${path}`);
    return content;
  };
  const fresh = (path: string, content: string) => {
    if (Object.hasOwn(out, path)) throw new InvalidArgumentError(`a file exists at ${path}`);
    out[path] = content;
  };
  switch (m.type) {
    case "modify-event":
      out[m.path] = `${existing(m.path)}# tampered\n`;
      break;
    case "edit-frozen-body":
      out[m.path] = `${existing(m.path)}\nTampered.\n`;
      break;
    case "delete-event":
    case "delete-frozen-body":
      existing(m.path);
      delete out[m.path];
      break;
    case "rename-event": {
      const content = existing(m.path);
      delete out[m.path];
      fresh(m.to, content);
      break;
    }
    case "wrong-hash":
    case "duplicate-event-id":
    case "duplicate-subject-id":
      fresh(m.path, m.content);
      break;
  }
  return out;
}

const MAX_AT = Date.parse("9999-12-31T23:59:59Z");

/** `at` moved by `seconds`, backwards when that would pass the last valid time. */
function shiftAt(at: string, seconds: number): string {
  const ms = Date.parse(at) + seconds * 1000;
  return formatAt(ms > MAX_AT ? Date.parse(at) - seconds * 1000 : ms);
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Mutations that apply to `fixture` and that verify is guaranteed to detect in `scope` (default
 * `"all"`). In scope `changed`, a duplicated event id stays within one subject: staged mode
 * compares ids among touched subjects only.
 */
export function arbTamper(
  fixture: LogFixture,
  o: { readonly scope?: "all" | "changed" } = {},
): fc.Arbitrary<TamperMutation> {
  const { layout, files } = fixture;
  const taken = (path: string) => Object.hasOwn(files, path);
  const events = fixture.subjects.flatMap((s) => s.events.map((e) => ({ subject: s, ...e })));
  const ids = new Set(events.map((e) => e.event.id));
  const freeze = freezePolicy(fixture.kind);
  const candidates: fc.Arbitrary<TamperMutation>[] = [];

  if (events.length > 0) {
    const anyEvent = fc.constantFrom(...events);
    candidates.push(
      anyEvent.map((e) => ({ type: "modify-event" as const, path: e.path })),
      anyEvent.map((e) => ({ type: "delete-event" as const, path: e.path })),
      anyEvent.chain((e) => {
        const name = parseEventFileName(basename(e.path));
        const dir = e.path.slice(0, e.path.lastIndexOf("/"));
        const others = fixture.subjects.filter((s) => s.id !== e.subject.id);
        const renamed = arbUlid().map((id) =>
          name === null
            ? `${dir}/${id.toLowerCase()}.yaml`
            : `${dir}/${formatEventFileName({ ...name, rand: id.slice(-4).toLowerCase() })}`,
        );
        const moved =
          others.length === 0
            ? renamed
            : fc.oneof(
                renamed,
                fc
                  .constantFrom(...others)
                  .map((s) => `${eventDir(layout, s.id)}/${basename(e.path)}`),
              );
        return moved
          .filter((to) => to !== e.path && !taken(to))
          .map((to) => ({ type: "rename-event" as const, path: e.path, to }));
      }),
    );
    const targets =
      o.scope === "changed" ? null : fc.constantFrom(...fixture.subjects.map((s) => s.id));
    candidates.push(
      anyEvent.chain((e) =>
        fc
          .tuple(targets ?? fc.constant(e.subject.id), fc.integer({ min: 1, max: 86_400 }))
          .map(([subject, seconds]) => {
            const copy: EventEnvelope = { ...e.event, subject, at: shiftAt(e.event.at, seconds) };
            return {
              type: "duplicate-event-id" as const,
              path: eventPath(layout, copy),
              from: e.path,
              content: serializeEvent(copy),
            };
          })
          .filter((m) => !taken(m.path)),
      ),
    );
  }

  const withBody = fixture.subjects.flatMap((s) =>
    s.bodyPath === null ? [] : [{ ...s, bodyPath: s.bodyPath }],
  );
  const frozen = withBody.filter((s) => s.frozen);
  if (frozen.length > 0) {
    const anyFrozen = fc.constantFrom(...frozen);
    candidates.push(
      anyFrozen.map((s) => ({
        type: "edit-frozen-body" as const,
        subject: s.id,
        path: s.bodyPath,
      })),
      anyFrozen.map((s) => ({
        type: "delete-frozen-body" as const,
        subject: s.id,
        path: s.bodyPath,
      })),
    );
  }
  if (withBody.length > 0 && layout.bodies !== null) {
    const bodies = layout.bodies;
    const anyWithBody = fc.constantFrom(...withBody);
    candidates.push(
      anyWithBody.chain((s) =>
        fc
          .tuple(arbSlug(), fc.string({ maxLength: 40 }))
          .map(([slug, content]) => ({
            type: "duplicate-subject-id" as const,
            subject: s.id,
            path: `${layout.root}/${bodies}/${bodyFileName(s.id, slug)}`,
            content,
          }))
          .filter((m) => !taken(m.path)),
      ),
    );
    if (freeze !== null) {
      const schema = Object.entries(fixture.kind.schemas).find(
        ([, v]) => v.events[freeze.freezeOn] !== undefined,
      )?.[0];
      candidates.push(
        anyWithBody.chain((s) => {
          const last = s.events.at(-1)?.event;
          if (last === undefined || schema === undefined) {
            throw new InvalidArgumentError(`subject ${s.id} has no events`);
          }
          const prior = s.events.find((e) => e.event.type === freeze.freezeOn)?.event.data;
          const hash = bodySha256(new TextEncoder().encode(files[s.bodyPath] ?? ""));
          return fc
            .tuple(arbUlid(), arbRandomHash)
            .filter(([id, wrong]) => !ids.has(id) && wrong !== hash)
            .map(([id, wrong]) => {
              const e: EventEnvelope = {
                ...last,
                id,
                type: freeze.freezeOn,
                schema,
                data: { ...prior, [freeze.hashField]: wrong },
              };
              return {
                type: "wrong-hash" as const,
                subject: s.id,
                path: eventPath(layout, e),
                content: serializeEvent(e),
              };
            })
            .filter((m) => !taken(m.path));
        }),
      );
    }
  }

  if (candidates.length === 0) {
    throw new InvalidArgumentError("the fixture has no events or bodies to tamper with");
  }
  return fc.oneof(...candidates);
}

/**
 * One to three new files that keep the log valid: events for existing or new subjects (fresh
 * ids, `at` no earlier than the subject's last event, correct names), a freeze-type event only
 * for a subject with a body and with its hash, and a body for every new subject of a kind with
 * bodies. Existing paths are never touched.
 */
export function arbAppend(fixture: LogFixture): fc.Arbitrary<Record<string, string>> {
  const { kind, layout, files } = fixture;
  const freeze = freezePolicy(kind);
  const types = allTypes(kind);
  const unfrozen = types.filter((t) => t !== freeze?.freezeOn);
  const ids = new Set(fixture.subjects.flatMap((s) => s.events.map((e) => e.event.id)));
  const subjectIds = new Set(fixture.subjects.map((s) => s.id));
  const hashOf = (body: string) => bodySha256(new TextEncoder().encode(body));
  const one = { minLength: 1, maxLength: 1 };

  type Action = { files: Record<string, string>; events: string[]; subject: string | null };
  const toFiles = (events: readonly EventEnvelope[], extra: Record<string, string> = {}) => ({
    ...extra,
    ...Object.fromEntries(events.map((e) => [eventPath(layout, e), serializeEvent(e)])),
  });

  const existing: fc.Arbitrary<Action>[] =
    fixture.subjects.length === 0
      ? []
      : [
          fc.constantFrom(...fixture.subjects).chain((s) => {
            const body = s.bodyPath === null ? undefined : files[s.bodyPath];
            const lastAt = s.events.at(-1)?.event.at ?? "1970-01-01T00:00:00Z";
            return arbSubjectEvents(
              kind,
              s.id,
              body === undefined ? unfrozen : types,
              one,
              body === undefined ? null : hashOf(body),
            ).map((events) => {
              const late = events.map((e) => (e.at < lastAt ? { ...e, at: lastAt } : e));
              return { files: toFiles(late), events: late.map((e) => e.id), subject: null };
            });
          }),
        ];
  const fresh: fc.Arbitrary<Action> = fc
    .tuple(arbSubjectId(), arbSlug(), fc.string({ unit: "grapheme", maxLength: 40 }))
    .filter(([id]) => !subjectIds.has(id))
    .chain(([id, slug, body]) => {
      const withBody = kind.body !== "none" && layout.bodies !== null;
      return arbSubjectEvents(
        kind,
        id,
        withBody ? types : unfrozen,
        one,
        withBody ? hashOf(body) : null,
      ).map((events) => ({
        files: toFiles(
          events,
          withBody ? { [`${layout.root}/${layout.bodies}/${bodyFileName(id, slug)}`]: body } : {},
        ),
        events: events.map((e) => e.id),
        subject: id,
      }));
    });

  return fc
    .array(fc.oneof(...existing, fresh), { minLength: 1, maxLength: 3 })
    .filter((actions) => {
      const paths = actions.flatMap((a) => Object.keys(a.files));
      const eventIds = actions.flatMap((a) => a.events);
      const subjects = actions.flatMap((a) => (a.subject === null ? [] : [a.subject]));
      return (
        paths.length <= 3 &&
        new Set(paths).size === paths.length &&
        !paths.some((p) => Object.hasOwn(files, p)) &&
        new Set(eventIds).size === eventIds.length &&
        !eventIds.some((id) => ids.has(id)) &&
        new Set(subjects).size === subjects.length
      );
    })
    .map((actions) => Object.assign({}, ...actions.map((a) => a.files)));
}
