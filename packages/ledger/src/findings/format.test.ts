import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Finding, finding } from "./finding.js";
import { findingsReport, formatGithub, formatJson, formatText } from "./format.js";

// The five findings of the design's §9 sample, given in shuffled order.
const sample: Finding[] = [
  finding({
    severity: "error",
    rule: "envelope/unknown-version",
    message: 'unknown envelope version "ledger/v2"; upgrade the tool to read this event',
    file: "docs/adr/events/k3f9q8a1/20261018T070215Z-z9c4-noted.yaml",
    subject: "k3f9q8a1",
    kind: "decision",
  }),
  finding({
    severity: "error",
    rule: "append-only/modified",
    message: "event file was modified; event files are append-only",
    file: "docs/adr/events/a7c2m9xd/20260314T120211Z-q8a1-accepted.yaml",
    subject: "a7c2m9xd",
    kind: "decision",
  }),
  finding({
    severity: "warning",
    rule: "identity/stray-file",
    message: "unexpected file in an event directory",
    file: "docs/adr/events/k3f9q8a1/.gitkeep",
    subject: "k3f9q8a1",
    kind: "decision",
  }),
  finding({
    severity: "error",
    rule: "body/frozen-modified",
    message: "body changed after it was frozen by accepted event 01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
    file: "docs/adr/decisions/a7c2m9xd-use-dynamodb-for-orders.md",
    subject: "a7c2m9xd",
    kind: "decision",
  }),
  finding({
    severity: "error",
    rule: "envelope/schema",
    message: "/actor: must have required property 'agent'",
    file: "docs/adr/events/k3f9q8a1/20261016T081030Z-p4d2-proposed.yaml",
    subject: "k3f9q8a1",
    kind: "decision",
  }),
];

describe("formatText", () => {
  it("matches the §9 sample", () => {
    expect(formatText(sample)).toBe(
      [
        "docs/adr/decisions/a7c2m9xd-use-dynamodb-for-orders.md: error: body changed after it was frozen by accepted event 01JAB3K9Z6Q8M2X7FQ0V4TQ8A1 [body/frozen-modified] (a7c2m9xd)",
        "docs/adr/events/a7c2m9xd/20260314T120211Z-q8a1-accepted.yaml: error: event file was modified; event files are append-only [append-only/modified] (a7c2m9xd)",
        "docs/adr/events/k3f9q8a1/.gitkeep: warning: unexpected file in an event directory [identity/stray-file] (k3f9q8a1)",
        "docs/adr/events/k3f9q8a1/20261016T081030Z-p4d2-proposed.yaml: error: /actor: must have required property 'agent' [envelope/schema] (k3f9q8a1)",
        'docs/adr/events/k3f9q8a1/20261018T070215Z-z9c4-noted.yaml: error: unknown envelope version "ledger/v2"; upgrade the tool to read this event [envelope/unknown-version] (k3f9q8a1)',
        "",
        "4 errors, 1 warning",
      ].join("\n"),
    );
  });

  it("prints a line number, findings without a file and zero counts", () => {
    const fs = [
      finding({
        severity: "error",
        rule: "event/unparseable",
        message: "bad",
        file: "a.yaml",
        line: 4,
      }),
      finding({ severity: "error", rule: "x/y", message: "no file" }),
    ];
    expect(formatText(fs)).toBe(
      "error: no file [x/y]\na.yaml:4: error: bad [event/unparseable]\n\n2 errors, 0 warnings",
    );
    expect(formatText([finding({ severity: "warning", rule: "x/y", message: "w" })])).toBe(
      "warning: w [x/y]\n\n0 errors, 1 warning",
    );
  });

  it("says No findings. when empty", () => {
    expect(formatText([])).toBe("No findings.");
  });
});

describe("formatJson", () => {
  it("matches the §9 sample", () => {
    const json = formatJson(sample);
    expect(json.endsWith("}\n")).toBe(true);
    expect(json.startsWith('{\n  "format": "ledger-findings/v1",\n  "ok": false,\n')).toBe(true);
    expect(json).toContain(
      [
        "    {",
        '      "severity": "error",',
        '      "rule": "body/frozen-modified",',
        '      "message": "body changed after it was frozen by accepted event 01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",',
        '      "file": "docs/adr/decisions/a7c2m9xd-use-dynamodb-for-orders.md",',
        '      "line": null,',
        '      "subject": "a7c2m9xd",',
        '      "kind": "decision"',
        "    },",
      ].join("\n"),
    );
    const report = JSON.parse(json);
    expect(report).toEqual({
      format: "ledger-findings/v1",
      ok: false,
      summary: { errors: 4, warnings: 1 },
      findings: [sample[3], sample[1], sample[2], sample[4], sample[0]],
    });
  });

  it("has ok equal to exitCode === 0 under failOn", () => {
    const warning = [finding({ severity: "warning", rule: "x/y", message: "w" })];
    expect(JSON.parse(formatJson(warning)).ok).toBe(true);
    expect(JSON.parse(formatJson(warning, { failOn: "warning" })).ok).toBe(false);
    expect(formatJson([])).toBe(
      '{\n  "format": "ledger-findings/v1",\n  "ok": true,\n  "summary": {\n    "errors": 0,\n    "warnings": 0\n  },\n  "findings": []\n}\n',
    );
  });

  it("always writes every key", () => {
    const { findings } = JSON.parse(formatJson([{ ...sample[0], file: null } as Finding]));
    expect(Object.keys(findings[0])).toEqual([
      "severity",
      "rule",
      "message",
      "file",
      "line",
      "subject",
      "kind",
    ]);
  });
});

describe("findingsReport", () => {
  it("equals the parsed formatJson report", () => {
    const warning = [finding({ severity: "warning", rule: "x/y", message: "w" })];
    for (const [fs, opts] of [
      [sample, {}],
      [[], {}],
      [warning, {}],
      [warning, { failOn: "warning" as const }],
    ] as const) {
      expect(findingsReport(fs, opts)).toEqual(JSON.parse(formatJson(fs, opts)));
    }
    const sources = [
      { name: "platform", kind: "adr", ref: "v1", commit: "a".repeat(40), fetched: true },
      { name: "tracker", kind: "issues", ref: "main", commit: null, fetched: false },
    ];
    expect(findingsReport(sample, { sources }).sources).toEqual(sources);
    expect(JSON.parse(formatJson(sample, { sources })).sources).toEqual(sources);
    expect(Object.keys(JSON.parse(formatJson(sample, { sources })))).toEqual([
      "format",
      "ok",
      "summary",
      "findings",
      "sources",
    ]);
    expect("sources" in findingsReport(sample)).toBe(false);
    expect("sources" in JSON.parse(formatJson(sample))).toBe(false);
    expect(findingsReport(sample).findings.map((f) => f.rule)).toEqual(
      [sample[3], sample[1], sample[2], sample[4], sample[0]].map((f) => f?.rule),
    );
  });
});

describe("formatGithub", () => {
  it("matches the §9 sample", () => {
    expect(formatGithub(sample)).toBe(
      [
        "::error file=docs/adr/decisions/a7c2m9xd-use-dynamodb-for-orders.md,title=body/frozen-modified::body changed after it was frozen by accepted event 01JAB3K9Z6Q8M2X7FQ0V4TQ8A1 (a7c2m9xd)",
        "::error file=docs/adr/events/a7c2m9xd/20260314T120211Z-q8a1-accepted.yaml,title=append-only/modified::event file was modified; event files are append-only (a7c2m9xd)",
        "::warning file=docs/adr/events/k3f9q8a1/.gitkeep,title=identity/stray-file::unexpected file in an event directory (k3f9q8a1)",
        "::error file=docs/adr/events/k3f9q8a1/20261016T081030Z-p4d2-proposed.yaml,title=envelope/schema::/actor: must have required property 'agent' (k3f9q8a1)",
        '::error file=docs/adr/events/k3f9q8a1/20261018T070215Z-z9c4-noted.yaml,title=envelope/unknown-version::unknown envelope version "ledger/v2"; upgrade the tool to read this event (k3f9q8a1)',
      ].join("\n"),
    );
  });

  it("writes line and omits file when null", () => {
    expect(
      formatGithub([
        finding({
          severity: "error",
          rule: "event/unparseable",
          message: "m",
          file: "a.yaml",
          line: 4,
        }),
        finding({ severity: "warning", rule: "x/y", message: "m" }),
      ]),
    ).toBe("::warning title=x/y::m\n::error file=a.yaml,line=4,title=event/unparseable::m");
  });

  const unescapeGithub = (s: string) =>
    s.replace(
      /%(25|0D|0A|3A|2C)/g,
      (_, c: string) => ({ "25": "%", "0D": "\r", "0A": "\n", "3A": ":", "2C": "," })[c] ?? "",
    );

  it("escapes so that messages and paths round-trip", () => {
    const tricky = fc.string({
      unit: fc.constantFrom("a", "%", "\r", "\n", ":", ",", "=", " ", "é", "2", "5", "0", "D"),
    });
    fc.assert(
      fc.property(tricky, tricky, fc.option(tricky, { nil: null }), (message, file, subject) => {
        const f: Finding = {
          severity: "error",
          rule: "a/b,c:d",
          message,
          file,
          line: 7,
          subject,
          kind: null,
        };
        const out = formatGithub([f]);
        expect(out).not.toMatch(/[\r\n]/);
        const m = /^::error ([^:]*)::(.*)$/s.exec(out);
        expect(m).not.toBeNull();
        const props = Object.fromEntries(
          (m?.[1] ?? "").split(",").map((p) => {
            const i = p.indexOf("=");
            return [p.slice(0, i), unescapeGithub(p.slice(i + 1))];
          }),
        );
        expect(props).toEqual({ file, line: "7", title: "a/b,c:d" });
        expect(unescapeGithub(m?.[2] ?? "")).toBe(
          subject === null ? message : `${message} (${subject})`,
        );
      }),
    );
  });

  it("writes one line per finding", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 5 }), (messages) => {
        const fs = messages.map(
          (message): Finding => ({
            ...finding({ severity: "error", rule: "a/b", message }),
            message,
          }),
        );
        const out = formatGithub(fs);
        expect(out === "" ? [] : out.split("\n")).toHaveLength(fs.length);
      }),
    );
  });
});
