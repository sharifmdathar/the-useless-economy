/**
 * LIVE x402 SETTLEMENT TEST — Base Sepolia only.
 *
 * Exercises the real buyer -> seller -> facilitator path with no mocks:
 *   1. Start a local HTTP server that runs the REAL provider guard
 *      (lib/x402-seller.ts guardOrSettle) on a fake provider route.
 *   2. Call the REAL buyer path (agent/wallet.ts payAndFetch) against it.
 *      - first request -> 402 with the x402 requirements
 *      - buyer signs an EIP-3009 authorization and retries with X-PAYMENT
 *   3. The seller verifies the signature and settles through the x402
 *      facilitator, which pays the gas.
 *   4. Assert the settlement tx exists, succeeded on-chain, and moved USDC
 *      to the provider wallet.
 *
 * This is the test that was failing before: it recorded paidAmount 0.
 */
import { createServer } from "node:http";
import { createPublicClient, http, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { payAndFetch } from "../agent/wallet";
import { guardOrSettle } from "../lib/x402-seller";
import { USDC_ADDRESS, USDC_DECIMALS } from "../agent/usdc";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";

const CHAIN = baseSepolia;
const client = createPublicClient({ chain: CHAIN, transport: http() });

function loadProviderAddress(): Address {
  const override = process.env.PROVIDER_PAY_TO_OVERRIDE;
  if (override && override.startsWith("0x")) return override as Address;
  const file = path.join(process.cwd(), ".provider-wallet.json");
  const key = (
    JSON.parse(fs.readFileSync(file, "utf8")) as { privateKey: `0x${string}` }
  ).privateKey;
  return privateKeyToAccount(key).address;
}

const PROVIDER = loadProviderAddress();
// capn's floor is 0.02 USDC — pay at or above it or the provider refuses.
const PRICE = 0.02; // USDC

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

/** Read a USDC balance, retrying briefly so a read-after-write lag on the
 *  RPC does not report a stale value. */
async function usdcBalanceSettled(addr: Address, expect?: number): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const bal = await usdcBalance(addr);
    if (expect === undefined || Math.abs(bal - expect) > 1e-9) return bal;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return usdcBalance(addr);
}

async function main() {
  console.log("=== pre-flight ===");
  const { getWalletAddress } = await import("../agent/wallet");
  const agentAddr = getWalletAddress() as Address;
  const providerBefore = await usdcBalance(PROVIDER);
  const agentBefore = await usdcBalance(agentAddr);
  console.log("agent USDC   :", agentBefore.toFixed(6));
  console.log("provider USDC:", providerBefore.toFixed(6));

  // 1. Fake provider route backed by the REAL guard.
  const server = createServer(async (req, res) => {
    const url = `http://localhost:${(server.address() as any).port}${req.url}`;
    const result = await guardOrSettle(
      new Request(url, { method: "GET", headers: req.headers as any }),
      "capn", // price 0.02, floor 0.02
    );
    if (result.kind === "requirements") {
      const body = await result.response.text();
      res.writeHead(result.response.status, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        deliverable: "Arr, me deliverable be done.",
        settledTx: result.settledTx,
        paid: result.effectivePrice,
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const url = `http://localhost:${port}/providers/pirate-translate`;
  console.log("\nprovider route:", url);

  // 2. Buy from it with the real buyer path.
  console.log("\n=== buy (402 -> sign -> X-PAYMENT -> settle) ===");
  const res = await payAndFetch(url, { maxPrice: 0.05 });
  const payment = res.payment as
    | { status: string; tx?: string; amount?: string; to?: string }
    | undefined;
  console.log("payment status:", payment?.status);
  if (payment?.status !== "settled") {
    console.log("body:", JSON.stringify(res.data));
    throw new Error("Payment did NOT settle — this is the paidAmount:0 bug.");
  }
  const tx = payment.tx;
  console.log("settledTx     :", tx);

  // 3. Verify on-chain.
  console.log("\n=== on-chain verification ===");
  const receipt = await client.waitForTransactionReceipt({ hash: tx as any, timeout: 60_000 });
  console.log("receipt status:", receipt.status);
  if (receipt.status !== "success") throw new Error("Settlement tx reverted.");
  console.log("explorer      :", `https://sepolia.basescan.org/tx/${tx}`);

  const providerAfter = await usdcBalanceSettled(PROVIDER, providerBefore);
  const agentAfter = await usdcBalanceSettled(agentAddr, agentBefore);
  console.log("provider USDC after:", providerAfter.toFixed(6));
  console.log("agent USDC after   :", agentAfter.toFixed(6));

  server.close();

  if (receipt.status !== "success") {
    throw new Error("FAIL: settlement reverted.");
  }
  // The money must actually have moved, and by exactly the quoted price.
  const expectedDelta = Number(PRICE);
  const providerDelta = providerAfter - providerBefore;
  const agentDelta = agentBefore - agentAfter;
  console.log("provider delta:", providerDelta.toFixed(6), "USDC");
  console.log("agent delta   :", agentDelta.toFixed(6), "USDC");
  if (Math.abs(providerDelta - expectedDelta) > 1e-6) {
    throw new Error(
      `FAIL: provider received ${providerDelta}, expected ${expectedDelta}.`,
    );
  }
  if (Math.abs(agentDelta - expectedDelta) > 1e-6) {
    throw new Error(
      `FAIL: agent paid ${agentDelta}, expected ${expectedDelta}.`,
    );
  }
  console.log("\nPASS: x402 payment settled on-chain with a real tx hash, and the USDC moved.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
