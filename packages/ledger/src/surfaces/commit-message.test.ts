import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ConfigError, UsageError } from "../errors.js";
import { commitMessageText } from "../git/git.js";
import { parseToolConfig } from "../sources/config.js";
import {
  type CommitSlot,
  checkCommitMessage,
  eventTrailers,
  joinActions,
  MAX_DESCRIPTION,
  parseCommitTemplate,
  readCommitTemplate,
  renderCommitMessage,
  wrapParagraph,
} from "./commit-message.js";

// adr's placeholders and the length of each one's longest value.
const VARS = { action: 24, id: 8, display: 13, command: 9 };
const DEFAULT = "docs(adr): {action} {title}";
const where = "adr.toml: commit.subject";
const template = parseCommitTemplate(DEFAULT, { vars: VARS, where });
const render = (action: string, title: string, body?: string[]) =>
  renderCommitMessage(template, {
    title,
    vars: { action, id: "k3f9q8a1", display: "ADR-0007", command: "x" },
    ...(body === undefined ? {} : { body }),
  });
const descriptionOf = (subject: string) => subject.replace(/^[a-z][a-z0-9-]*(\([^()]+\))?!?: /, "");

describe("parseCommitTemplate", () => {
  it.each([
    DEFAULT,
    "docs({command}): {action} {raw_title}",
    "chore(decisions): {action} {display} {title}",
    "{action} {title}",
    "docs: record {{decisions}} {title}",
    "docs(adr): set up the decision log",
    "feat!: {title}",
  ])("accepts %j", (text) => {
    expect(parseCommitTemplate(text, { vars: VARS, where }).source).toBe(text);
  });

  it.each([
    ["", `${where} must be 1 to 200 characters`],
    ["x".repeat(201), `${where} must be 1 to 200 characters`],
    ["docs: {title}\nbody", `${where} must be one line`],
    ["docs: {title", `${where} has a stray { or }; write {{ or }} for a literal brace`],
    ["docs: title}", `${where} has a stray { or }; write {{ or }} for a literal brace`],
    [
      "docs: {who} {title}",
      `${where} uses unknown placeholder {who}; use {title}, {raw_title}, {action}, {id}, {display}, {command}`,
    ],
    ["docs(adr): {title} ({raw_title})", `${where} can use {title} or {raw_title} once`],
    ["{title}: x", `${where}: the title must come after the type and scope`],
    ["docs({title}): x", `${where}: the title must come after the type and scope`],
    [
      "docs(architecture-decisions): {action} {title}",
      `${where}: the type and scope can push the header past 100 characters`,
    ],
    [`docs: ${"x".repeat(53)}{title}`, `${where} leaves no room for the title`],
    [
      `docs: {display} {display} {display} {display} ${"x".repeat(17)}`,
      `${where} can exceed 72 characters`,
    ],
  ])("refuses %j", (text, message) => {
    expect(() => parseCommitTemplate(text, { vars: VARS, where })).toThrow(ConfigError);
    expect(() => parseCommitTemplate(text, { vars: VARS, where })).toThrow(message);
  });

  it("counts the fixed part at the longest values, leaving 20 for the title", () => {
    expect(() =>
      parseCommitTemplate(`docs: ${"x".repeat(52)}{title}`, { vars: VARS, where }),
    ).not.toThrow();
    // {action} 24 + " " + 27 = 52.
    expect(() =>
      parseCommitTemplate(`docs: {action} ${"x".repeat(27)}{title}`, { vars: VARS, where }),
    ).not.toThrow();
    expect(() =>
      parseCommitTemplate(`docs: {action} ${"x".repeat(28)}{title}`, { vars: VARS, where }),
    ).toThrow("leaves no room for the title");
  });

  it("leaves room for each name the title placeholder can hold, which is never shortened", () => {
    // {action} at its longest (24) leaves 72 - 24 - 1 - 20 = 27 for text; a name with a short action.
    const t = (n: number) => `docs: {action} ${"x".repeat(n)}{title}`;
    const names = [{ length: 42, vars: { action: 4 } }];
    expect(() => parseCommitTemplate(t(25), { vars: VARS, where, names })).not.toThrow();
    expect(() => parseCommitTemplate(t(26), { vars: VARS, where, names })).toThrow(
      "leaves no room for the title",
    );
    expect(() => parseCommitTemplate(t(27), { vars: VARS, where })).not.toThrow();
    // The name's own placeholder lengths count, not the longest ones.
    const long = [{ length: 42, vars: { action: 24 } }];
    expect(() => parseCommitTemplate(t(5), { vars: VARS, where, names: long })).not.toThrow();
    expect(() => parseCommitTemplate(t(6), { vars: VARS, where, names: long })).toThrow(
      "leaves no room for the title",
    );
    const r = renderCommitMessage(parseCommitTemplate(t(25), { vars: VARS, where, names }), {
      title: "ADR-0001 to a decision in another log zzzz",
      vars: { action: "link" },
    });
    expect(r.shortened).toBe(false);
    expect(r.message).toBe(
      `docs: link ${"x".repeat(25)}ADR-0001 to a decision in another log zzzz`,
    );
    expect(r.message).not.toContain("Full title:");
  });
});

describe("readCommitTemplate", () => {
  const read = (toml: string | null) =>
    readCommitTemplate(toml === null ? null : parseToolConfig(toml, { file: "adr.toml" }), {
      file: "docs/adr/adr.toml",
      vars: VARS,
      defaultSubject: DEFAULT,
    });

  it("reads [commit] subject, else the default", () => {
    expect(read(null).source).toBe(DEFAULT);
    expect(read("[policy]\nauto_commit = true\n").source).toBe(DEFAULT);
    expect(read("[commit]\nother = 1\n").source).toBe(DEFAULT);
    expect(read('[commit]\nsubject = "chore: {action} {title}"\n').source).toBe(
      "chore: {action} {title}",
    );
  });

  it("refuses a [commit] that isn't a table and a subject that isn't a valid string", () => {
    expect(() => read('commit = "x"\n')).toThrow("docs/adr/adr.toml: commit must be a table");
    expect(() => read("[commit]\nsubject = 1\n")).toThrow(
      "docs/adr/adr.toml: commit.subject must be a string",
    );
    expect(() => read('[commit]\nsubject = "docs: {nope}"\n')).toThrow(
      "docs/adr/adr.toml: commit.subject uses unknown placeholder {nope}",
    );
    try {
      read('[commit]\nsubject = "docs: {nope}"\n');
    } catch (e) {
      expect(e).toMatchObject({ file: "docs/adr/adr.toml" });
    }
  });

  it("passes names on to the check of the subject", () => {
    const config = parseToolConfig(`[commit]\nsubject = "docs: ${"x".repeat(31)}{title}"\n`, {
      file: "adr.toml",
    });
    const o = { file: "docs/adr/adr.toml", vars: VARS, defaultSubject: DEFAULT };
    expect(() =>
      readCommitTemplate(config, { ...o, names: [{ length: 41, vars: {} }] }),
    ).not.toThrow();
    expect(() => readCommitTemplate(config, { ...o, names: [{ length: 42, vars: {} }] })).toThrow(
      "docs/adr/adr.toml: commit.subject leaves no room for the title",
    );
  });
});

describe("renderCommitMessage", () => {
  it.each([
    ["propose to", "Use Aurora for orders", "docs(adr): propose to use Aurora for orders", 32],
    [
      "decide to",
      "Keep ark's tools in one monorepo",
      "docs(adr): decide to keep ark's tools in one monorepo",
      42,
    ],
    [
      "propose to",
      "Keep each tool's kind apart from its CLI and MCP code",
      "docs(adr): propose to keep each tool's kind apart from its CLI and MCP code",
      64,
    ],
    [
      "propose to",
      "Attribute agent writes with ARK_AGENT and ARK_ON_BEHALF_OF",
      "docs(adr): propose to attribute agent writes with ARK_AGENT and ARK_ON_BEHALF_OF",
      69,
    ],
    [
      "propose to",
      "Use Conventional Commits for --commit messages and ark's history",
      "docs(adr): propose to use Conventional Commits for --commit messages and ark's…",
      68,
    ],
    [
      "decide to",
      "Use Conventional Commits for --commit messages and ark's history",
      "docs(adr): decide to use Conventional Commits for --commit messages and ark's…",
      67,
    ],
    [
      "propose to",
      "Require Node 24 or newer for every ark package",
      "docs(adr): propose to require Node 24 or newer for every ark package",
      57,
    ],
    [
      "decide to",
      "Require Node 24 or newer for every ark package",
      "docs(adr): decide to require Node 24 or newer for every ark package",
      56,
    ],
    ["supersede", "ADR-0001 with ADR-0002", "docs(adr): supersede ADR-0001 with ADR-0002", 32],
    [
      "decide not to",
      "Adopt GraphQL federation for the public API.",
      "docs(adr): decide not to adopt GraphQL federation for the public API",
      57,
    ],
    ["add a note to", "ADR-0002", "docs(adr): add a note to ADR-0002", 22],
    ["link", "ADR-0003 to ADR-0001", "docs(adr): link ADR-0003 to ADR-0001", 25],
    ["set the scope of", "ADR-0006", "docs(adr): set the scope of ADR-0006", 25],
    ["set the scope of", "gy2pgcmf", "docs(adr): set the scope of gy2pgcmf", 25],
    [
      "withdraw the proposal to",
      "Qualify ids in other logs with the source name",
      "docs(adr): withdraw the proposal to qualify ids in other logs with the source name",
      71,
    ],
    [
      "withdraw the proposal to",
      "Keep each tool's kind apart from its CLI and MCP code",
      "docs(adr): withdraw the proposal to keep each tool's kind apart from its CLI and…",
      70,
    ],
    ["deprecate", "ADR-0003", "docs(adr): deprecate ADR-0003", 18],
    [
      "decide to",
      "Use event sourcing with one append-only log per subject for every record kind in the monorepo",
      "docs(adr): decide to use event sourcing with one append-only log per subject for…",
      70,
    ],
  ])("renders %s %j as the design's example", (action, title, subject, length) => {
    const r = render(action, title);
    expect(r.subject).toBe(subject);
    expect(descriptionOf(r.subject)).toHaveLength(length);
    expect(r.shortened).toBe(subject.endsWith("…"));
  });

  it("keeps natural casing after the description's first letter", () => {
    expect(render("propose to", "Use the CLI with ARK_AGENT on Node 24.").subject).toBe(
      "docs(adr): propose to use the CLI with ARK_AGENT on Node 24",
    );
    expect(render("decide to", "CLI flags follow ARK_AGENT conventions").subject).toBe(
      "docs(adr): decide to CLI flags follow ARK_AGENT conventions",
    );
    for (const display of ["ADR-0006", "gy2pgcmf"]) {
      expect(render("set the scope of", display).subject).toBe(
        `docs(adr): set the scope of ${display}`,
      );
    }
    const bare = parseCommitTemplate("docs(adr): {raw_title}", { vars: VARS, where });
    expect(renderCommitMessage(bare, { title: "Use Aurora", vars: {} }).subject).toBe(
      "docs(adr): use Aurora",
    );
    const noPrefix = parseCommitTemplate("{title}", { vars: VARS, where });
    expect(renderCommitMessage(noPrefix, { title: "IPv6 Only", vars: {} }).subject).toBe(
      "iPv6 Only",
    );
    for (const [title, kept] of [
      ["GraphQL federation for the public API", "GraphQL federation for the public API"],
      ["TypeScript everywhere", "TypeScript everywhere"],
      ["PostgreSQL for orders", "PostgreSQL for orders"],
      ["iOS first", "iOS first"],
      ["Aurora for orders", "aurora for orders"],
    ] as const) {
      expect(render("propose to", title).subject).toBe(`docs(adr): propose to ${kept}`);
    }
    // The title starts the description, so its first letter is lowercased whatever the word.
    const titleFirst = parseCommitTemplate("docs(adr): {title}", { vars: VARS, where });
    expect(renderCommitMessage(titleFirst, { title: "GraphQL federation", vars: {} }).subject).toBe(
      "docs(adr): graphQL federation",
    );
    const long = render(
      "propose to",
      "Use Conventional Commits for --commit messages and ark's history",
    );
    expect(long.message).toBe(
      [
        "docs(adr): propose to use Conventional Commits for --commit messages and ark's…",
        "",
        "Full title: Use Conventional Commits for --commit messages and ark's",
        "history",
      ].join("\n"),
    );
  });

  it("renders init without a title", () => {
    const init = parseCommitTemplate("docs(adr): {action} {title}", { vars: VARS, where });
    const r = renderCommitMessage(init, {
      title: "the decision log",
      vars: { action: "set up", id: "", display: "", command: "init" },
    });
    expect(r).toEqual({
      message: "docs(adr): set up the decision log",
      subject: "docs(adr): set up the decision log",
      shortened: false,
      note: null,
    });
  });

  it("puts the full title as recorded first in the body of a shortened subject", () => {
    const title =
      "Use event sourcing with one append-only log per subject for every record kind in the monorepo";
    const r = render("decide to", title);
    expect(
      commitMessageText(r.message, [
        ["ADR", "k3f9q8a1"],
        ["ADR-Event", "accepted"],
      ]),
    ).toBe(
      [
        "docs(adr): decide to use event sourcing with one append-only log per subject for…",
        "",
        "Full title: Use event sourcing with one append-only log per subject for",
        "every record kind in the monorepo",
        "",
        "ADR: k3f9q8a1",
        "ADR-Event: accepted",
        "",
      ].join("\n"),
    );
    const dots = render("decide to", `${"Keep Every Word ".repeat(6)}Here...`);
    expect(dots.shortened).toBe(true);
    expect(dots.message).toContain("Here...");
    expect(dots.message.split("\n")[2]).toBe(
      "Full title: Keep Every Word Keep Every Word Keep Every Word Keep Every",
    );
  });

  it("keeps the case with {raw_title} and wraps body paragraphs", () => {
    const raw = parseCommitTemplate("docs(adr): {action} {raw_title}", { vars: VARS, where });
    const r = renderCommitMessage(raw, {
      title: "  Use   Aurora.. ",
      vars: { action: "decide not to", id: "k", display: "k", command: "reject" },
      body: ["Reason: First line\nwraps here.\n\n  \nSecond.", "Supersedes ADR-0001: Old."],
    });
    expect(r.message).toBe(
      [
        "docs(adr): decide not to Use Aurora",
        "",
        "Reason: First line wraps here.",
        "",
        "Second.",
        "",
        "Supersedes ADR-0001: Old.",
      ].join("\n"),
    );
  });

  it("strips trailing dots from the whole subject", () => {
    const t = parseCommitTemplate("docs: {action}...", { vars: VARS, where });
    expect(renderCommitMessage(t, { title: null, vars: { action: "x" } }).subject).toBe("docs: x");
  });

  it("strips trailing dots separated by whitespace from the title", () => {
    expect(render("propose to", "a.\n.").subject).toBe("docs(adr): propose to a");
    expect(render("propose to", "Use X. . .").subject).toBe("docs(adr): propose to use X");
  });

  it("gives commitlint-clean subjects for any title and action", () => {
    const actions = [
      "propose to",
      "decide to",
      "decide not to",
      "withdraw the proposal to",
      "deprecate",
      "supersede",
      "add a note to",
      "link",
      "set the scope of",
      "set up",
    ];
    const unit = fc.oneof(
      { weight: 8, arbitrary: fc.constantFrom("a", "B", "z", "Q", " ", "-", ",", "'") },
      { weight: 2, arbitrary: fc.constantFrom(".", "..", "\n", "\t", "  ") },
      { weight: 1, arbitrary: fc.constantFrom("é", "İ", "ß", "😀", "𝒳", "Σ") },
    );
    const arbTitle = fc
      .array(unit, { minLength: 1, maxLength: 200 })
      .map((xs) =>
        xs
          .join("")
          .slice(0, 200)
          .replace(/[\ud800-\udbff]$/, ""),
      )
      .filter((t) => t.length > 0);
    fc.assert(
      fc.property(arbTitle, fc.constantFrom(...actions), (title, action) => {
        const r = render(action, title, ["Reason: some reason"]);
        expect(r.subject).toMatch(/^docs\(adr\): \S/);
        const d = descriptionOf(r.subject);
        expect(d.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
        const first = String.fromCodePoint(d.codePointAt(0) as number);
        expect(first).toBe(first.toLowerCase());
        const prepared = title
          .replace(/\s+/g, " ")
          .replace(/[. ]+$/, "")
          .trim();
        const [head = ""] = Array.from(prepared);
        if (!r.shortened) expect(d).toContain(prepared.slice(head.length));
        expect(d.endsWith(".")).toBe(false);
        expect(r.subject).not.toMatch(
          /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
        );
        const message = commitMessageText(r.message, [
          ["ADR", "k3f9q8a1"],
          ["ADR-Event", "noted"],
        ]);
        const lines = message.split("\n");
        for (const line of lines.slice(1)) expect(line.length).toBeLessThanOrEqual(72);
        expect(message.endsWith("\n\nADR: k3f9q8a1\nADR-Event: noted\n")).toBe(true);
        if (r.shortened) {
          const squeeze = (s: string) => s.replace(/\s+/g, "");
          expect(squeeze(lines.slice(2).join(""))).toContain(squeeze(`Full title: ${title}`));
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("wrapParagraph", () => {
  it("joins lines into paragraphs and wraps them at 72", () => {
    expect(wrapParagraph("First line\nwraps here.\n\n  \nSecond.")).toEqual([
      "First line wraps here.",
      "",
      "Second.",
    ]);
    expect(wrapParagraph("\n\n  a  b \n\n\n")).toEqual(["a b"]);
    expect(wrapParagraph("")).toEqual([]);
    const words = "word ".repeat(30).trim();
    const lines = wrapParagraph(words);
    expect(lines.every((l) => l.length <= 72)).toBe(true);
    expect(lines.join(" ")).toBe(words);
  });

  it("breaks a word longer than the width, never inside a surrogate pair", () => {
    const long = "x".repeat(100);
    expect(wrapParagraph(`a ${long} b`)).toEqual(["a", "x".repeat(72), `${"x".repeat(28)} b`]);
    const astral = `${"x".repeat(71)}😀y`;
    expect(wrapParagraph(astral)).toEqual(["x".repeat(71), "😀y"]);
    expect(wrapParagraph("abcdef", 3)).toEqual(["abc", "def"]);
  });
});

describe("checkCommitMessage", () => {
  it("trims a message and refuses empty, NUL and oversized ones", () => {
    expect(checkCommitMessage("  fix: x\n\nbody\n")).toBe("fix: x\n\nbody");
    expect(() => checkCommitMessage(" \n ")).toThrow(UsageError);
    expect(() => checkCommitMessage("a\0b")).toThrow("the commit message contains a NUL character");
    expect(() => checkCommitMessage("x".repeat(65_537))).toThrow(
      "the commit message is 65537 bytes; the limit is 65536",
    );
    expect(checkCommitMessage("x".repeat(65_536))).toHaveLength(65_536);
  });
});

describe("commitMessageText", () => {
  it("writes trailers as the last paragraph and leaves a message without trailers alone", () => {
    expect(
      commitMessageText("feat: x\n\nbody\n\n", [
        ["ADR", "k"],
        ["ADR-Event", "proposed"],
      ]),
    ).toBe("feat: x\n\nbody\n\nADR: k\nADR-Event: proposed\n");
    expect(commitMessageText("chore: y\n", [])).toBe("chore: y\n");
    expect(commitMessageText("chore: y", [])).toBe("chore: y");
  });

  it("appends the trailers to the last paragraph with merge", () => {
    const trailers: [string, string][] = [
      ["ADR", "k"],
      ["ADR-Event", "noted"],
    ];
    const own = "chore: x\n\nWhy.\n\nCo-authored-by: A <a@x>\nRefs: #12\n";
    expect(commitMessageText(own, trailers, { merge: true })).toBe(
      "chore: x\n\nWhy.\n\nCo-authored-by: A <a@x>\nRefs: #12\nADR: k\nADR-Event: noted\n",
    );
    for (const o of [undefined, { merge: false }]) {
      expect(commitMessageText(own, trailers, o)).toBe(
        "chore: x\n\nWhy.\n\nCo-authored-by: A <a@x>\nRefs: #12\n\nADR: k\nADR-Event: noted\n",
      );
    }
    expect(commitMessageText(own, [], { merge: true })).toBe(own);
  });
});

describe("renderCommitMessage with a slot", () => {
  const issues = parseCommitTemplate("docs(issues): {action} {title}", { vars: VARS, where });
  const slotted = (action: string, title: string, slot: CommitSlot) =>
    renderCommitMessage(issues, { title, vars: { action }, slot });

  it("puts before, the quoted title and after around the title", () => {
    expect(slotted("open", "Split the orders service", { quote: true }).subject).toBe(
      'docs(issues): open "split the orders service"',
    );
    expect(
      slotted("close", "Split the orders service", {
        before: "?42",
        quote: true,
        after: "as won't fix",
      }).subject,
    ).toBe(`docs(issues): close ?42 "split the orders service" as won't fix`);
    expect(slotted("start work on", "CLI flags", { before: "?42" }).subject).toBe(
      "docs(issues): start work on ?42 CLI flags",
    );
    // A quote inside the title stays as it is.
    expect(slotted("open", 'Use the "fast" path', { quote: true }).subject).toBe(
      'docs(issues): open "use the "fast" path"',
    );
    // {raw_title} keeps the recorded casing.
    const raw = parseCommitTemplate("docs(issues): {action} {raw_title}", { vars: VARS, where });
    expect(
      renderCommitMessage(raw, { title: "Use X", vars: { action: "open" }, slot: { quote: true } })
        .subject,
    ).toBe('docs(issues): open "Use X"');
  });

  it("shortens only the title, keeping before, after and both quotes", () => {
    const title = "Add the retry budget and the circuit breaker to the payments gateway client";
    const r = slotted("close", title, {
      before: "?42",
      quote: true,
      after: "as a duplicate of ?17",
    });
    expect(r.shortened).toBe(true);
    expect(r.subject).toMatch(/^docs\(issues\): close \?42 "add the .*…" as a duplicate of \?17$/);
    expect(descriptionOf(r.subject).length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(r.message.replace(/\s+/g, " ")).toContain(`Full title: ${title}`);
    expect(r.note).toBe(
      'the title was shortened to keep the commit description (after "docs(issues):") within 72 characters; the full title is in the commit body',
    );
  });

  it("words the note for a template without a Conventional prefix", () => {
    const plain = parseCommitTemplate("{action} {title}", { vars: VARS, where });
    const r = renderCommitMessage(plain, { title: "x".repeat(90), vars: { action: "open" } });
    expect(r.note).toBe(
      "the title was shortened to keep the commit subject within 72 characters; the full title is in the commit body",
    );
    expect(renderCommitMessage(plain, { title: "x", vars: { action: "open" } }).note).toBeNull();
  });

  it("keeps quotes balanced and the description within 72 for any title", () => {
    const unit = fc.constantFrom("a", "B", " ", '"', "'", "é", "😀", "-", ".");
    const arbTitle = fc
      .array(unit, { minLength: 1, maxLength: 120 })
      .map((xs) => xs.join(""))
      .filter((t) => t.replace(/[\s.]/g, "") !== "");
    fc.assert(
      fc.property(arbTitle, fc.constantFrom("", "as won't fix", "to ?17"), (title, after) => {
        const r = slotted("close", title, { before: "?42", quote: true, after });
        const d = descriptionOf(r.subject);
        expect(d.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
        expect(d.startsWith('close ?42 "')).toBe(true);
        const end = after === "" ? '"' : `" ${after}`;
        expect(d.endsWith(end)).toBe(true);
        if (r.shortened) expect(d.endsWith(`…${end}`)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("joinActions", () => {
  it("joins one to three verbs without an Oxford comma", () => {
    expect(joinActions([])).toBe("");
    expect(joinActions(["link"])).toBe("link");
    expect(joinActions(["link", "scope"])).toBe("link and scope");
    expect(joinActions(["assign", "start", "comment on"])).toBe("assign, start and comment on");
  });
});

describe("eventTrailers", () => {
  it("gives one pair per distinct subject and type, in first-occurrence order", () => {
    const keys = { subject: "Issue", event: "Issue-Event" };
    expect(
      eventTrailers(
        [
          { subject: "x", type: "linked" },
          { subject: "x", type: "linked" },
          { subject: "y", type: "linked" },
          { subject: "x", type: "scoped" },
          { subject: "x", type: "linked" },
        ],
        keys,
      ),
    ).toEqual([
      ["Issue", "x"],
      ["Issue-Event", "linked"],
      ["Issue", "y"],
      ["Issue-Event", "linked"],
      ["Issue", "x"],
      ["Issue-Event", "scoped"],
    ]);
    expect(eventTrailers([], keys)).toEqual([]);
  });
});
