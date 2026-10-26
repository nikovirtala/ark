/** Test-only helpers for spawning the built `issues` binary on temp repos. */
import { existsSync } from "node:fs";

/** `path`, or an error telling the developer to build first. */
export function requireBuilt(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing; run \`pnpm build\` first`);
  return path;
}
