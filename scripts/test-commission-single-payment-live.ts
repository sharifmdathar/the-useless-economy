/**
 * COMMISSION DOUBLE-PAYMENT REGRESSION (tool level, live chain).
 *
 * Drives the REAL `commission_job` tool — the same code the agent loop uses —
 * with a counter-offer, and proves:
 *
 *   1. Exactly ONE on-chain USDC transfer leaves the agent for one commission.
 *   2. That transfer is for the NEGOTIATED price, not the full ask.
 *   3. The agent's balance drops by exactly the negotiated price.
 *   4. The settlement recorded carries the amount that actually settled.
 *
 * This is the exact shape that used to double-pay: a commission for Soleil
 * (ask 0.05, floor 0.03) with a counter-offer of 0.04 produced two funded
 * transfers of 0.05 each, while the ledger recorded 0.04.
 *
 * The provider route is a LOCAL server speaking the real x402 protocol so the
 * test needs no LLM, but the settlement, the facilitator, the signature and
 * the chain are all real.
 *
 *   node --experimental-strip-types scripts/run-test.ts \
 *     scripts/test-commission-single-payment-live.ts
 */
import { createServer } from "node:http";
import { createPublicClient, http, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { guardOrSettle, resolvePayTo } from "../lib/x402-seller";
import { getWalletAddress } from "../agent/wallet";
import { listSettlements } from "../agent/settlements";
import { USDC_ADDRESS, USDC_DECIMALS } from "../agent/usdc";
import { paidTools } from "../agent/tools";

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
  const agentAddr = getWalletAddress();
  if (!agentAddr) throw new Error("No agent wallet configured.");
  const PAYTO = resolvePayTo("soleil");
  console.log("agent: ", agentAddr);
  console.log("payTo: ", PAYTO);

  const ASK = 0.05;
  const COUNTER = 0.04;

  const agentBefore = await usdcBalance(agentAddr);
  const payToBefore = await usdcBalance(PAYTO);
  console.log(`before: agent=${agentBefore} provider=${payToBefore}`);

  // A local provider speaking the real x402 protocol, wired the way the
  // app's own route is: it passes the negotiated price into guardOrSettle.
  let providerHits = 0;
  let providerSettlements = 0;
  let paidRequests = 0;
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    providerHits++;
    // A request carrying X-PAYMENT is a SIGNED authorization — the only
    // kind that can move money. The protocol's first request (no header)
    // merely gets a 402.
    if (req.headers["x-payment"]) paidRequests++;
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
    providerSettlements++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        provider: "soleil",
        score: 8,
        verdict: "Magnifique.",
        notes: "The light was absurd.",
        settledTx: result.settledTx,
        paidUsdc: result.effectivePrice,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://localhost:${port}`;

  // The REAL tool, with a counter-offer — the shape that double-paid.
  const tool = paidTools.find((t) => t.name === "commission_job");
  if (!tool) throw new Error("commission_job tool not found");
  const out = (await tool.run(
    {
      provider: "soleil",
      job: "rate the sunset over the Tagus in Lisbon",
      counterOffer: COUNTER,
    },
    { baseUrl },
  )) as Record<string, unknown>;

  server.close();
  console.log("tool output:", JSON.stringify(out, null, 2));

  check(
    "the provider route saw the protocol's 2 requests (402 + paid)",
    providerHits === 2,
    { providerHits },
  );
  check(
    "only ONE request carried a signed authorization",
    paidRequests === 1,
    { paidRequests },
  );
  check(
    "the provider settled ONCE (no double payment)",
    providerSettlements === 1,
    { providerSettlements },
  );
  check(
    "the tool reports the negotiated price as paid",
    out.paid === COUNTER,
    { paid: out.paid, expected: COUNTER },
  );
  check("the tool reports the negotiation", out.negotiated === true, {
    negotiated: out.negotiated,
  });

  await new Promise((r) => setTimeout(r, 4000));
  const agentAfter = await usdcBalance(agentAddr);
  const payToAfter = await usdcBalance(PAYTO);
  const agentDelta = agentBefore - agentAfter;
  const payToDelta = payToAfter - payToBefore;
  console.log(
    `after: agent=${agentAfter} provider=${payToAfter} | agent delta=${agentDelta} provider delta=${payToDelta}`,
  );

  check(
    "the agent paid EXACTLY the negotiated price (no double payment)",
    Math.abs(agentDelta - COUNTER) < 1e-6,
    { agentDelta, expected: COUNTER },
  );
  check(
    "the provider received EXACTLY the negotiated price",
    Math.abs(payToDelta - COUNTER) < 1e-6,
    { payToDelta, expected: COUNTER },
  );

  // The recorded settlement must carry the settled amount.
  const settlements = await listSettlements();
  const row = settlements[settlements.length - 1];
  console.log("recorded settlement:", JSON.stringify(row));
  check(
    "the recorded settlement amount is the settled amount",
    row.amountUsdc === COUNTER,
    { recorded: row.amountUsdc, settled: COUNTER },
  );
  check("the recorded settlement is a commission", row.kind === "commission", {
    kind: row.kind,
  });

  const tx = out.tx as string | undefined;
  if (tx) {
    const receipt = await client.waitForTransactionReceipt({
      hash: tx as `0x${string}`,
      timeout: 120_000,
    });
    check("the on-chain receipt succeeded", receipt.status === "success", {
      status: receipt.status,
    });
  } else {
    check("a transaction hash was reported", false, { tx });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} assertion(s) failed`);
  console.log("\nPASS: one commission = one payment = one settlement.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFAIL:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
