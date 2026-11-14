import type { HarnessRuntime } from "./harness-runtime.js";
import { claudeRuntime, type Harness } from "./setup-claude.js";
import { kiroRuntime } from "./setup-kiro.js";

/** How each harness runs what init writes, in {@link HARNESSES} order. A new harness adds one. */
export const HARNESS_RUNTIMES: Readonly<Record<Harness, HarnessRuntime>> = {
  claude: claudeRuntime,
  kiro: kiroRuntime,
};
