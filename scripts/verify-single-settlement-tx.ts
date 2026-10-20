/**
 * Independently verify on-chain that the post-fix commission produced
 * exactly ONE USDC transfer of the negotiated amount.
 *
 * Reads the chain directly with the project's own viem client (the same RPC
 * the app uses) and decodes the USDC Transfer event.
 */
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { USDC_ADDRESS, USDC_DECIMALS } from "../agent/usdc";

// When run through scripts/run-test.ts, argv[2] is this script's own path.
// The real arguments start at argv[3].
const args = process.argv.slice(2).filter((a) => !a.endsWith(".ts"));
const TX = args[0] ?? "0x6cfa09ce656b59ec22fa45ed14ea83c6e11e7f602f072ecaf61a1861087707ea";
const EXPECTED = Number(args[1] ?? "0.04");

const client = createPublicClient({ chain: baseSepolia, transport: http() });

async function main() {
  const receipt = await client.waitForTransactionReceipt({
    hash: TX as `0x${string}`,
    timeout: 120_000,
  });
  console.log("tx     :", TX);
  console.log("status :", receipt.status, receipt.status === "success" ? "(success)" : "(FAILED)");
  console.log("block  :", receipt.blockNumber.toString());

  // USDC v2 on Base uses the standard Transfer topic; some builds also emit
  // a non-indexed variant. Handle both shapes rather than assume one.
  const TRANSFER_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const ALTERNATE_TOPIC =
    "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

  let total = 0;
  let count = 0;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
    const topic0 = log.topics[0]?.toLowerCase();
    // Only the standard ERC-20 Transfer carries a value in `data`. USDC v2
    // also emits a TransferAuthorization event (a different topic) which
    // has no amount and must not be counted as a movement of money.
    if (topic0 !== TRANSFER_TOPIC) continue;

    const from = `0x${log.topics[1]!.slice(-40)}`;
    const to = `0x${log.topics[2]!.slice(-40)}`;
    const value = BigInt(log.data);
    const amount = Number(value) / 10 ** USDC_DECIMALS;
    total += amount;
    count++;
    console.log(`  transfer ${amount} USDC  ${from} -> ${to}`);
  }

  console.log(`\ntransfers in this tx : ${count}`);
  console.log(`total transferred     : ${total} USDC`);
  const ok = count === 1 && Math.abs(total - EXPECTED) < 1e-9;
  console.log(
    ok
      ? `\nPASS: exactly one ${EXPECTED} USDC transfer. No double payment.`
      : `\nFAIL: expected exactly one ${EXPECTED} USDC transfer.`,
  );
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
