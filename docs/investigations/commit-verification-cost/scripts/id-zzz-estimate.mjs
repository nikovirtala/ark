// Estimates how often a random 8-character subject id (5 random bytes, Crockford base32, see
// packages/ledger/src/identity/ids.ts) contains the substring "zzz". The test "issues_search
// returns searchIssues' document" in packages/issues/src/mcp/read-tools.test.ts searches for "zzz"
// and expects no match, but issues search matches a query against ids too.
//
//   node id-zzz-estimate.mjs [samples]   (default 5_000_000; uses node's crypto, like the code)
import { randomFillSync } from "node:crypto";
import process from "node:process";

const A = "0123456789abcdefghjkmnpqrstvwxyz";
const n = Number(process.argv[2] ?? 5_000_000);
const buf = new Uint8Array(5);
let hits = 0;
for (let i = 0; i < n; i++) {
  randomFillSync(buf);
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  let s = "";
  for (let k = 0; k < 8; k++) {
    s = A[Number(v & 31n)] + s;
    v >>= 5n;
  }
  if (s.includes("zzz")) hits++;
}
// exact: 8-char strings over 32 symbols with "zzz" somewhere. Positions 0..5 give 6 * 32^5 starts,
// minus overlaps (zzzz at 5 start pairs, 32^4 each, and so on); inclusion-exclusion by simulation here.
console.log(
  JSON.stringify({ samples: n, hits, rate: hits / n, per_five_ids: 1 - (1 - hits / n) ** 5 }),
);
