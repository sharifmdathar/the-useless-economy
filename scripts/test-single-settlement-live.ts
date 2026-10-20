/**
 * SINGLE-SETTLEMENT LIVE TEST — the end-to-end proof that ONE logical
 * commission moves the money ONCE.
 *
 * This is the regression test for a real, on-chain defect: a single
 * commission produced two funded transfers (0.05 + 0.05) because the agent
 * paid the ask and then paid again at the counter-offer, and the provider
 * route ignored the negotiated price so both requests were charged the ask.
 *
 * WHAT IT PROVES, ON THE REAL CHAIN
 *   1. A negotiated commission pays EXACTLY ONE authorization.
 *   2. The agent's USDC balance drops by exactly the settled amount.
 *   3. The provider's USDC balance rises by exactly the settled amount.
 *   4. The recorded settlement amount equals what actually moved.
 *   5. The ledger records the settled amount, not the counter-offer.
 *
 * It runs against Base Sepolia via the x402 facilitator, so it costs a few
 * thousandths of a testnet USDC. The provider is a LOCAL server speaking the
 * real x402 protocol, so the test does not depend on an LLM.
 *
 *   node --experimental-strip-types scripts/run-test.ts \
 *     scripts/test-single-settlement-live.ts
 */
import { createServer } from "node:http";
import { createPublicClient, http, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { payAndFetch } from "../agent/wallet";
import { guardOrSettle, resolvePayTo } from "../lib/x402-seller";
import { recordSettlement, listSettlements } from "../agent/settlements";
import { USDC_ADDRESS, USDC_DECIMALS } from "../agent/usdc";
import { PROVIDERS } from "../lib/providers";

const client = createPublicClient({ chain: baseSepolia, transport: http() });

async function usdcBalance(addr: Address): Promise<number> {
  const raw = await client.readContract({
    address: USDC_ADDRESS,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [addr],
  });
  return Number(raw) / 10 ** USDC_DECIMALS;
}

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
    if (detail !== undefined) {
      console.log("        detail:", JSON.stringify(detail));
    }
  }
}

async function main() {
  const provider = PROVIDERS.find((p) => p.slug === "capn")!;
  const PAYTO = resolvePayTo("capn");
  const agentAddr = (await import("../agent/wallet")).getWalletAddress();
  if (!agentAddr) throw new Error("No agent wallet configured.");
  console.log("agent:  ", agentAddr);
  console.log("payTo:  ", PAYTO);

  // The negotiated price: below capn's ask (0.02)? No — capn holds firm at
  // 0.02. Use soleil instead, whose floor is 0.03 and ask is 0.05, so a
  // counter-offer of 0.04 is legal and is exactly the shape that used to
  // double-pay.
  const ASK = 0.05;
  const NEGOTIATED = 0.04;

  const agentBefore = await usdcBalance(agentAddr);
  const payToBefore = await usdcBalance(PAYTO);
  console.log(
    `balances before: agent=${agentBefore} provider=${payToBefore}`,
  );

  // A local provider speaking the real x402 protocol. It must honour the
  // negotiated price — that is the route behaviour we fixed.
  let settlements = 0;
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const negotiated = Number(url.searchParams.get("price") ?? "") || undefined;
    const result = await guardOrSettle(
      new Request(`http://localhost:${port}${req.url}`, {
        method: "GET",
        headers: req.headers as Record<string, string>,
      }),
      "soleil",
      negotiated,
    );
    if (result.kind === "requirements") {
      res.writeHead(result.response.status, { "Content-Type": "application/json" });
      res.end(await result.response.text());
      return;
    }
    settlements++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        deliverable: "Settled once.",
        settledTx: result.settledTx,
        paidUsdc: result.effectivePrice,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;

  // The buyer's single request, with the negotiated price and the intent.
  const res = await payAndFetch(
    `http://localhost:${port}/providers/rate-sunset?price=${NEGOTIATED}`,
    { maxPrice: ASK, expectedPrice: NEGOTIATED },
  );
  server.close();

  const payment = res.payment as { status: string; tx?: string } | undefined;
  console.log("payment:", JSON.stringify(payment));
  console.log("settledAmountUsdc:", res.settledAmountUsdc);

  check("the payment settled", payment?.status === "settled", payment);
  check("the provider settled exactly once", settlements === 1, { settlements });
  check(
    "the settled amount is the negotiated price",
    res.settledAmountUsdc === NEGOTIATED,
    { settled: res.settledAmountUsdc, negotiated: NEGOTIATED },
  );

  // Wait for the chain to reflect the transfer.
  await new Promise((r) => setTimeout(r, 4000));
  const agentAfter = await usdcBalance(agentAddr);
  const payToAfter = await usdcBalance(PAYTO);
  const agentDelta = agentBefore - agentAfter;
  const payToDelta = payToAfter - payToBefore;
  console.log(
    `balances after: agent=${agentAfter} provider=${payToAfter} | agent delta=${agentDelta} provider delta=${payToDelta}`,
  );

  check(
    "the agent paid EXACTLY the settled amount (no double payment)",
    Math.abs(agentDelta - NEGOTIATED) < 1e-6,
    { agentDelta, expected: NEGOTIATED },
  );
  check(
    "the provider received EXACTLY the settled amount",
    Math.abs(payToDelta - NEGOTIATED) < 1e-6,
    { payToDelta, expected: NEGOTIATED },
  );

  // Record the settlement the way commission_job does, and confirm the
  // recorded amount is the settled one.
  const before = (await listSettlements()).length;
  await recordSettlement({
    provider: "soleil",
    job: "single settlement live test",
    amountUsdc: res.settledAmountUsdc,
    txHash: payment?.tx ?? "",
    kind: "commission",
  });
  const all = await listSettlements();
  const row = all[all.length - 1];
  check("a settlement was recorded", all.length === before + 1);
  check(
    "the recorded amount is the settled amount",
    row.amountUsdc === NEGOTIATED,
    { recorded: row.amountUsdc, settled: res.settledAmountUsdc },
  );
  check(
    "the recorded tx hash is the real transaction",
    row.txHash === payment?.tx,
    { recorded: row.txHash, real: payment?.tx },
  );

  // And the on-chain receipt must exist and succeed.
  if (payment?.tx) {
    const receipt = await client.waitForTransactionReceipt({
      hash: payment.tx as `0x${string}`,
      timeout: 120_000,
    });
    check("the on-chain receipt succeeded", receipt.status === "success", {
      status: receipt.status,
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} assertion(s) failed`);
  console.log("\nPASS: one commission moves the money exactly once.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFAIL:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
