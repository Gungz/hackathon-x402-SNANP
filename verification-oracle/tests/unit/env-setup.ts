/**
 * Test-environment setup — MUST be imported first by every test file.
 *
 * ES module imports are evaluated before the importing module's body, so
 * environment overrides that later modules read at import time (or lazily)
 * can only be reliably set here, and in a separate module.
 *
 * - SOLANA_PAY_TO: points payment verification at a fake oracle operator
 *   wallet so tests are hermetic (independent of the real .env value)
 * - ESCROW_RECORDS_FILE: redirects escrow record persistence to a temporary
 *   file so tests never pollute the repo's escrow-records.json
 */

import * as path from "path";
import * as os from "os";

// Mock operator wallet used across the test mocks (see rpc-mock.ts BENEFICIARY)
process.env.SOLANA_PAY_TO = "7heA9wh3UMrywyBDwMXPgU8yNkH4uuW1C9EPcXaoGyQB";
process.env.ESCROW_RECORDS_FILE = path.join(
  os.tmpdir(),
  `escrow-records-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`
);
