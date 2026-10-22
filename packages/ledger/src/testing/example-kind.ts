import type { KindSchema } from "../envelope/kind.js";
import type { LogLayout } from "../identity/layout.js";

/**
 * A small kind for tests: widgets are `created`, `noted` and `frozen`; the first `frozen` event
 * freezes the body and records its hash in `body_sha256`.
 */
export const exampleKind: KindSchema = {
  name: "widget",
  schemas: {
    "widget/v1": {
      events: {
        created: {
          data: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string", minLength: 1 } },
          },
        },
        noted: { data: { type: "object" } },
        frozen: { data: { type: "object", properties: { body_sha256: { type: "string" } } } },
      },
    },
  },
  body: { freezeOn: "frozen" },
};

/** Where `exampleKind` logs live in tests. */
export const exampleLayout: LogLayout = { root: "log", bodies: "items", events: "events" };
