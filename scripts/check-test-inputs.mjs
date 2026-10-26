// Keeps scripts/test-inputs.txt complete, so scripts/check-commit.sh runs the tests that read a
// repository file whenever that file changes. Run by `pnpm lint`; usage: node scripts/check-test-inputs.mjs.
// Rule: in every .ts/.mts/.js/.mjs file under packages/<p>/src/, each string or template literal
// starting with "../" (a template's static prefix) is resolved against the file's directory, as
// new URL(literal, import.meta.url) and relative imports do. A target inside packages/<p>/ or inside
// a workspace dependency of <p> (whose changes already run <p>'s tests) is fine; any other target
// must be listed for <p> in scripts/test-inputs.txt. Each manifest entry must name an existing path
// and packages. Blind spots (paths built from segments, absolute or run-time paths, a CLI spawned
// without cwd reading the enclosing repository) are listed in test-inputs.txt's header.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = "scripts/test-inputs.txt";
const SOURCE = /\.(?:ts|mts|js|mjs)$/;
const LITERAL = /["'`]((?:\.\.\/)+[^"'`$]*)/g;

const errors = [];
const fail = (message) => errors.push(`check-test-inputs: ${message}`);

// Workspace packages by directory, with their workspace dependencies' directories.
const dirs = readdirSync(join(root, "packages")).filter((d) =>
  existsSync(join(root, "packages", d, "package.json")),
);
const manifests = new Map(
  dirs.map((d) => [d, JSON.parse(readFileSync(join(root, "packages", d, "package.json"), "utf8"))]),
);
const dirOf = new Map(dirs.map((d) => [manifests.get(d).name, d]));
const direct = new Map(
  dirs.map((d) => {
    const m = manifests.get(d);
    const names = Object.keys({ ...m.dependencies, ...m.devDependencies });
    return [d, names.map((n) => dirOf.get(n)).filter((q) => q !== undefined)];
  }),
);
/** <p> and every workspace package it depends on, directly or transitively. */
function closure(p) {
  const seen = new Set([p]);
  for (const q of seen) for (const r of direct.get(q) ?? []) seen.add(r);
  return seen;
}

// The manifest: path -> packages that may read it.
const entries = [];
readFileSync(join(root, MANIFEST), "utf8")
  .split("\n")
  .forEach((line, i) => {
    const [path, ...readers] = line.trim().split(/\s+/);
    if (path === "" || path.startsWith("#")) return;
    const at = `${MANIFEST}:${i + 1}`;
    if (readers.length === 0) fail(`${at}: ${path} lists no package`);
    if (!existsSync(join(root, path))) fail(`${at}: ${path} does not exist`);
    for (const r of readers) {
      if (!manifests.has(r)) fail(`${at}: packages/${r}/package.json does not exist`);
    }
    entries.push({ path, readers });
  });
const listed = (path, p) =>
  entries.some(
    (e) =>
      e.readers.includes(p) && (e.path.endsWith("/") ? path.startsWith(e.path) : path === e.path),
  );

for (const p of dirs) {
  const src = join(root, "packages", p, "src");
  if (!existsSync(src)) continue;
  const allowed = [...closure(p)].map((q) => join(root, "packages", q) + sep);
  for (const file of readdirSync(src, { recursive: true })) {
    if (!SOURCE.test(file) || file.split(sep).includes("node_modules")) continue;
    const abs = join(src, file);
    const text = readFileSync(abs, "utf8");
    for (const m of text.matchAll(LITERAL)) {
      const target = resolve(dirname(abs), m[1]);
      if (allowed.some((a) => `${target}${sep}`.startsWith(a))) continue;
      const path = relative(root, target).split(sep).join("/");
      if (listed(path, p)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      fail(
        `${relative(root, abs)}:${line} reads ${path} outside packages/${p}/; add "${path} ${p}" to ${MANIFEST}`,
      );
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
