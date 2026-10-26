/**
 * Test-only values and arbitraries for issue logs. Never bundled or packed: excluded from
 * `tsconfig.json`, included in `tsconfig.test.json`.
 */
import type { Actor } from "@nikovirtala/ledger";

/** An agent actor (adr's test value; issues may import only `@nikovirtala/adr/kind`). */
export const TEST_AGENT: Actor = Object.freeze({
  kind: "agent",
  name: "test-agent",
  email: null,
  agent: "test-agent",
  on_behalf_of: "test@example.com",
});
