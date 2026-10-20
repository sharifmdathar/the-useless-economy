/**
 * Live check of the Week 2 transfer path against Base Sepolia.
 *
 * Walks the whole two-phase flow the way the chat UI does:
 *   1. send_tokens      -> files a PENDING transfer, signs nothing
 *   2. approve_transfer -> signs + broadcasts, returns a tx hash
 *   3. reject_transfer  -> cancels another pending transfer, signs nothing
 *
 * Amounts are deliberately tiny (0.01) so the test costs nothing but proves
 * the on-chain path actually works.
 */
import {
  createPendingTransfer,
  executeAgentTransfer,
  listTransfers,
  rejectTransfer,
  MAX_TRANSFER,
  MAX_DAILY_TRANSFER,
} from "../agent/transfers";
import { loadAccountForTransfer, getUsdcBalance } from "../agent/wallet";

// A throwaway address on Base Sepolia. It is a well-known burn-ish address,
// so a test transfer can never hit a real person.
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

async function main() {
  console.log("=== caps ===");
  console.log("per-transfer:", MAX_TRANSFER, "daily:", MAX_DAILY_TRANSFER);

  const account = loadAccountForTransfer();
  console.log("\n=== agent wallet ===");
  console.log("address:", account.address);
  console.log("USDC balance:", await getUsdcBalance(account.address));

  console.log("\n=== phase 1: create pending (signs nothing) ===");
  const t = await createPendingTransfer({
    token: "USDC",
    amount: 0.01,
    recipient: RECIPIENT,
    source: "agent_wallet",
    prompt: "Send 0.01 USDC to 0x000000000000000000000000000000000000dEaD",
  });
  console.log("id:", t.id);
  console.log("status:", t.status, "(must be 'pending')");
  console.log("amount:", t.amount, t.token);
  console.log("recipient:", t.recipient);

  console.log("\n=== phase 2: execute ===");
  const done = await executeAgentTransfer(t.id);
  console.log("status:", done.status);
  if (done.status === "failed") {
    console.log("reason:", done.reason);
    process.exitCode = 1;
  } else {
    console.log("txHash:", done.txHash);
    console.log(
      "explorer:",
      `https://sepolia.basescan.org/tx/${done.txHash}`,
    );
    console.log("USDC balance after:", await getUsdcBalance(account.address));
  }

  console.log("\n=== reject path (must not sign) ===");
  const t2 = await createPendingTransfer({
    token: "USDC",
    amount: 0.01,
    recipient: RECIPIENT,
    prompt: "this one gets cancelled",
  });
  const r = await rejectTransfer(t2.id, "test: declined by user");
  console.log("status:", r.status, "(must be 'rejected')");
  console.log("reason:", r.reason);
  console.log("txHash:", r.txHash ?? "none (correct — nothing was signed)");

  console.log("\n=== cap enforcement ===");
  try {
    await createPendingTransfer({
      token: "USDC",
      amount: MAX_TRANSFER + 1,
      recipient: RECIPIENT,
    });
    console.log("FAIL: over-cap transfer was allowed");
    process.exitCode = 1;
  } catch (e) {
    console.log("OK, over-cap rejected:", (e as Error).message);
  }

  try {
    await createPendingTransfer({
      token: "USDC",
      amount: 1,
      recipient: "0xnotanaddress",
    });
    console.log("FAIL: bad address was allowed");
    process.exitCode = 1;
  } catch (e) {
    console.log("OK, bad address rejected:", (e as Error).message);
  }

  console.log("\n=== all transfers ===");
  for (const row of listTransfers()) {
    console.log(
      `${row.id}  ${row.status.padEnd(9)} ${row.amount} ${row.token} -> ${row.recipient}`,
    );
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
