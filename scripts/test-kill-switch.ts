/**
 * Verify the kill switch blocks BOTH halves of the transfer flow:
 *   1. creating a new pending intent
 *   2. executing one that was created before the switch was flipped
 *
 * Run: KILL_SWITCH=1 JITI_TSCONFIG_PATHS=true node_modules/.bin/jiti scripts/test-kill-switch.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPendingTransfer, executeAgentTransfer } from "../agent/transfers";

const FILE = ".transfers.json";

function readRows(): any[] {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

async function main() {
  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  // --- 1. Creation is blocked while the switch is on.
  process.env.KILL_SWITCH = "1";
  let createBlocked = false;
  let createMsg = "";
  try {
    await createPendingTransfer({
      token: "USDC",
      amount: 0.01,
      recipient: "0x000000000000000000000000000000000000dEaD",
    });
  } catch (e) {
    createBlocked = true;
    createMsg = (e as Error).message;
  }
  check("KILL_SWITCH=1 blocks creating a pending transfer", createBlocked, createMsg);

  // --- 2. A transfer created BEFORE the switch was flipped must not settle.
  process.env.KILL_SWITCH = "0";
  const before = readRows().length;
  const pending = await createPendingTransfer({
    token: "USDC",
    amount: 0.01,
    recipient: "0x000000000000000000000000000000000000dEaD",
  });
  check("a transfer can be created with the switch off", !!pending.id, pending.id);

  process.env.KILL_SWITCH = "1";
  let execBlocked = false;
  let execMsg = "";
  try {
    await executeAgentTransfer(pending.id);
  } catch (e) {
    execBlocked = true;
    execMsg = (e as Error).message;
  }
  check("KILL_SWITCH=1 blocks executing a pre-existing transfer", execBlocked, execMsg);

  // --- 3. With the switch back off, the same transfer settles.
  process.env.KILL_SWITCH = "0";
  const settled = await executeAgentTransfer(pending.id);
  check(
    "the transfer settles once the switch is off",
    settled.status === "executed" && !!settled.txHash,
    settled.txHash,
  );

  // Leave the ledger as we found it.
  const rows = readRows();
  writeFileSync(FILE, JSON.stringify(rows.slice(0, before), null, 2));

  console.log(failures === 0 ? "\nPASS: the kill switch gates both halves." : `\nFAIL: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
