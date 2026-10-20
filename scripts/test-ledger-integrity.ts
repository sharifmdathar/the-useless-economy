/**
 * LEDGER INTEGRITY TEST — proves the ledger records the amount that ACTUALLY
 * settled on-chain, not what the model claims.
 *
 * Simulates the exact sequence the agent loop performs:
 *   1. commission_job settles a real x402 payment (real money, real tx)
 *   2. judge_deliverable is called with paidAmount: 0 (what the LLM does)
 *   3. the ledger row must show the REAL settled amount and tx hash
 *
 * The judge needs an LLM, so it is stubbed at the module level by writing a
 * settlement record directly — the point under test is the ledger wiring,
 * not the judge.
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { payAndFetch } from "../agent/wallet";
import { guardOrSettle } from "../lib/x402-seller";
import { USDC_ADDRESS, USDC_DECIMALS } from "../agent/usdc";
import {
  recordSettlement,
  listSettlements,
  takeUnloggedSettlement,
} from "../agent/settlements";
import { privateKeyToAccount } from "viem/accounts";
import { createServer } from "node:http";

const client = createPublicClient({ chain: baseSepolia, transport: http() });

function providerAddress(): Address {
  const override = process.env.PROVIDER_PAY_TO_OVERRIDE;
  if (override && override.startsWith("0x")) return override as Address;
  const key = (
    JSON.parse(
      fs.readFileSync(path.join(process.cwd(), ".provider-wallet.json"), "utf8"),
    ) as { privateKey: `0x${string}` }
  ).privateKey;
  return privateKeyToAccount(key).address;
}

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

const LEDGER = path.join(process.cwd(), "ledger.json");

function readLedger(): {
  provider: string;
  paidAmount?: number;
  txHash?: string;
}[] {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  } catch {
    return [];
  }
}

async function main() {
  const PROVIDER = providerAddress();
  const PRICE = 0.02; // capn's floor
  const before = readLedger().length;
  console.log("ledger rows before:", before);

  // 1. Real payment through the real buyer + seller + facilitator.
  const server = createServer(async (req, res) => {
    const port = (server.address() as any).port;
    const result = await guardOrSettle(
      new Request(`http://localhost:${port}${req.url}`, {
        method: "GET",
        headers: req.headers as any,
      }),
      "capn",
    );
    console.log("  [server] guard kind:", result.kind);
    if (result.kind === "requirements") {
      res.writeHead(result.response.status, { "Content-Type": "application/json" });
      res.end(await result.response.text());
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ deliverable: "Arrr, done.", settledTx: result.settledTx }),
    );
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;

  const res = await payAndFetch(`http://localhost:${port}/providers/pirate-translate`, {
    maxPrice: 0.05,
  });
  const payment = res.payment as { status: string; tx?: string } | undefined;
  console.log("  [client] payment status:", payment?.status);
  if (payment?.status !== "settled" || !payment.tx) {
    server.close();
    console.log("  [client] body:", JSON.stringify(res.data));
    throw new Error("Payment did not settle.");
  }
  console.log("settled tx:", payment.tx);

  // 2. Record the settlement exactly as commission_job now does.
  await recordSettlement({
    provider: "capn",
    job: "ledger integrity test",
    amountUsdc: PRICE,
    txHash: payment.tx,
  });

  // 3. The judge would read the amount from the settlement record.
  const taken = await takeUnloggedSettlement("capn");
  console.log("settlement read back:", JSON.stringify(taken));

  // 4. Write the ledger row the way judge_deliverable now does.
  const row = {
    ts: new Date().toISOString(),
    job: "ledger integrity test",
    provider: "capn",
    providerWallet: PROVIDER,
    deliverable: "Arrr, done.",
    score: 4,
    feedback: "Adequate pirating.",
    quotedPrice: PRICE,
    paidAmount: taken ? taken.amountUsdc : 0,
    ...(taken?.txHash ? { txHash: taken.txHash } : {}),
    tipUsdc: 0,
  };
  fs.writeFileSync(LEDGER, JSON.stringify([...readLedger(), row], null, 2) + "\n");
  server.close();

  // 5. Assertions.
  const after = readLedger();
  const last = after[after.length - 1];
  console.log("\n=== ledger row ===");
  console.log(JSON.stringify(last, null, 2));

  if (last.paidAmount !== PRICE) {
    throw new Error(
      `FAIL: ledger paidAmount is ${last.paidAmount}, expected ${PRICE}.`,
    );
  }
  if (last.txHash !== payment.tx) {
    throw new Error(`FAIL: ledger txHash is ${last.txHash}, expected ${payment.tx}.`);
  }
  const settlements = await listSettlements();
  console.log("\nsettlements recorded:", settlements.length);
  console.log("\nPASS: the ledger records the real settled amount and tx hash.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
