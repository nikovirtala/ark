// Bumps ark's own tool pins to the versions a release just published, for the release workflow's
// self-update step (adr:jgdhvxtq, docs/03-setup-v1.md "bootstrapping"). The pins live in a single
// source of truth, the `ARK_PINS` constant in packages/ledger/src/surfaces/ark-setup.ts, from which
// `init --setup` regenerates every pinned file (.mcp.json, .kiro/settings/mcp.json, the package.json
// `prepare` script, the committed hook scripts) and ark-setup.lock. So this script edits only that
// constant; the workflow then rebuilds and reruns `init --setup` to rewrite the rest, and opens a
// pull request (never a push to main).
//
// Input: the publish step's `published-packages` output on $PUBLISHED_PACKAGES, a JSON array like
// [{"name":"@nikovirtala/adr","version":"0.6.0"}, …]. Only @nikovirtala/adr and @nikovirtala/issues
// are pins; other published packages (e.g. ledger) are ignored. A package not in this release keeps
// its current pin. Output (GitHub Actions): `changed=true|false`, so the workflow skips the rerun
// and the PR when nothing moved. Usage: PUBLISHED_PACKAGES='[…]' node scripts/bump-ark-pins.mjs.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ARK_SETUP = new URL("../packages/ledger/src/surfaces/ark-setup.ts", import.meta.url);

// Pin name (in ARK_PINS) -> published npm package name.
const PINS = { adr: "@nikovirtala/adr", issues: "@nikovirtala/issues" };

function fail(message) {
  console.error(`bump-ark-pins: ${message}`);
  process.exit(1);
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

const raw = process.env.PUBLISHED_PACKAGES;
if (!raw || raw.trim() === "")
  fail("PUBLISHED_PACKAGES is empty (expected the publish step's JSON)");

let published;
try {
  published = JSON.parse(raw);
} catch (err) {
  fail(`PUBLISHED_PACKAGES is not valid JSON: ${err.message}`);
}
if (!Array.isArray(published)) fail("PUBLISHED_PACKAGES must be a JSON array");

// Latest published version per package name.
const versions = new Map();
for (const entry of published) {
  if (entry && typeof entry.name === "string" && typeof entry.version === "string") {
    versions.set(entry.name, entry.version);
  }
}

const source = readFileSync(ARK_SETUP, "utf8");
// ARK_PINS is a single-line const: `export const ARK_PINS: ArkPins = { adr: "x", issues: "y" };`.
const line = /export const ARK_PINS: ArkPins = \{ adr: "([^"]+)", issues: "([^"]+)" \};/;
const match = source.match(line);
if (!match) fail("could not find the ARK_PINS constant in ark-setup.ts");

const next = { adr: match[1], issues: match[2] };
const bumped = [];
for (const [pin, pkg] of Object.entries(PINS)) {
  const version = versions.get(pkg);
  if (version && version !== next[pin]) {
    bumped.push(`${pin} ${next[pin]} -> ${version}`);
    next[pin] = version;
  }
}

if (bumped.length === 0) {
  console.log("bump-ark-pins: no pin changed (published release carries no newer adr/issues pin)");
  setOutput("changed", "false");
  process.exit(0);
}

const replaced = source.replace(
  line,
  `export const ARK_PINS: ArkPins = { adr: "${next.adr}", issues: "${next.issues}" };`,
);
writeFileSync(ARK_SETUP, replaced);
console.log(`bump-ark-pins: bumped ${bumped.join(", ")}`);
console.log(`bump-ark-pins: edited ${fileURLToPath(ARK_SETUP).slice(root.length)}`);
setOutput("changed", "true");
