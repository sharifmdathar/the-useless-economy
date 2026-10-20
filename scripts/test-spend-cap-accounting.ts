/**
 * SPEND-CAP ACCOUNTING REGRESSION.
 *
 * The weekly cap is checked against `weekSpend()`. A commission settles the
 * money on-chain BEFORE the judge writes the ledger row, so a cap computed
 * from the ledger alone under-counts by the amount of the payment that just
 * left the wallet.
 *
 * This test drives the REAL `weekSpend()` (exported as `testWeekSpend()`)
 * and proves that a settled-but-not-yet-judged payment is counted against
 * the cap exactly once, and not double-counted once the ledger row lands.
 */
import fs from "node:fs";
import path from "node:path";
import { testWeekSpend } from "../agent/tools";

const ROOT = process.cwd();
const LEDGER = path.join(ROOT, "ledger.json");
const SETTLEMENTS = path.join(ROOT, "settlements.json");

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
    if (detail !== undefined)
      console.log("        detail:", JSON.stringify(detail));
  }
}

const ledgerBackup = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER) : null;
const settlementsBackup = fs.existsSync(SETTLEMENTS)
  ? fs.readFileSync(SETTLEMENTS)
  : null;

async function main() {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Empty state.
  fs.writeFileSync(LEDGER, "[]");
  fs.writeFileSync(SETTLEMENTS, "[]");
  check("an empty account spends nothing", (await testWeekSpend()) === 0, {
    spend: await testWeekSpend(),
  });

  // A payment settled on-chain, but the judge has not written a ledger row.
  fs.writeFileSync(
    SETTLEMENTS,
    JSON.stringify([
      {
        ts: now,
        provider: "soleil",
        kind: "commission",
        amountUsdc: 0.04,
        txHash: "0xabc",
        logged: false,
      },
    ]),
  );
  check(
    "a settled-but-unjudged payment counts against the cap",
    Math.abs((await testWeekSpend()) - 0.04) < 1e-9,
    { spend: await testWeekSpend() },
  );

  // Once the judge consumes the settlement and writes the ledger row, the
  // settlement is marked logged and the ledger carries the amount. It must
  // still be counted exactly once.
  fs.writeFileSync(
    LEDGER,
    JSON.stringify([{ ts: now, job: "sunset", paidAmount: 0.04, score: 8 }]),
  );
  fs.writeFileSync(
    SETTLEMENTS,
    JSON.stringify([
      {
        ts: now,
        provider: "soleil",
        kind: "commission",
        amountUsdc: 0.04,
        txHash: "0xabc",
        logged: true,
      },
    ]),
  );
  check(
    "a judged payment is counted exactly once (not twice)",
    Math.abs((await testWeekSpend()) - 0.04) < 1e-9,
    { spend: await testWeekSpend() },
  );

  // A tip is a separate ledger row and must also count.
  fs.writeFileSync(LEDGER, "[]");
  fs.writeFileSync(SETTLEMENTS, "[]");
  fs.writeFileSync(
    LEDGER,
    JSON.stringify([{ ts: now, job: "tip", tipUsdc: 0.005 }]),
  );
  check(
    "a tip counts against the cap",
    Math.abs((await testWeekSpend()) - 0.005) < 1e-9,
    { spend: await testWeekSpend() },
  );

  // Settlements older than the window do not count.
  fs.writeFileSync(LEDGER, "[]");
  fs.writeFileSync(
    SETTLEMENTS,
    JSON.stringify([
      { ts: old, provider: "soleil", amountUsdc: 0.04, logged: false },
    ]),
  );
  check(
    "a settlement older than 7 days does not count",
    (await testWeekSpend()) === 0,
    { spend: await testWeekSpend() },
  );

  // A commission plus a tip together — the shape of the Week 3 demo.
  fs.writeFileSync(LEDGER, "[]");
  fs.writeFileSync(
    SETTLEMENTS,
    JSON.stringify([
      {
        ts: now,
        provider: "soleil",
        kind: "commission",
        amountUsdc: 0.04,
        logged: false,
      },
    ]),
  );
  fs.writeFileSync(
    LEDGER,
    JSON.stringify([{ ts: now, job: "tip", tipUsdc: 0.005 }]),
  );
  check(
    "a settled commission plus a tip both count",
    Math.abs((await testWeekSpend()) - 0.045) < 1e-9,
    { spend: await testWeekSpend() },
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} assertion(s) failed`);
  console.log("\nPASS: the spend cap sees every settled payment exactly once.");
}

main()
  .then(() => {
    console.log("\nPASS: the spend cap sees every settled payment exactly once.");
  })
  .catch((err) => {
    console.error("\nFAIL:", err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Restore the real runtime files. Must not call process.exit() above:
    // that would skip this and destroy the account's local history.
    if (ledgerBackup) fs.writeFileSync(LEDGER, ledgerBackup);
    else if (fs.existsSync(LEDGER)) fs.unlinkSync(LEDGER);
    if (settlementsBackup) fs.writeFileSync(SETTLEMENTS, settlementsBackup);
    else if (fs.existsSync(SETTLEMENTS)) fs.unlinkSync(SETTLEMENTS);
    console.log("(restored ledger.json and settlements.json)");
  });
