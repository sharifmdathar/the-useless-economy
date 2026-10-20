/**
 * REPAIR THE LOCAL SPEND HISTORY AGAINST THE CHAIN.
 *
 * The weekly cap is only as good as the numbers behind it, and those numbers
 * came from a reconstruction that recorded the NEGOTIATED price (0.04) for
 * five commissions that actually settled at 0.05, and never wrote a ledger
 * row for the orphaned duplicate payment.
 *
 * This script reconciles ledger.json and settlements.json with the chain:
 *
 *  1. For every settlement, read the amount that actually left the wallet
 *     from the USDC Transfer event in its receipt, and correct the recorded
 *     amount if it disagrees.
 *  2. For every settlement that has no ledger row, write one — a payment
 *     that left the wallet must appear in the ledger even if the judge
 *     never ran.
 *  3. For every ledger row, read the settled amount from the chain and
 *     correct paidAmount / tipUsdc if they disagree.
 *
 * It is idempotent: running it twice changes nothing the second time.
 *
 *   node --experimental-strip-types scripts/run-test.ts \
 *     scripts/repair-spend-history.ts
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { parseAbi, decodeEventLog } from "viem";

const ROOT = process.cwd();
const LEDGER = path.join(ROOT, "ledger.json");
const SETTLEMENTS = path.join(ROOT, "settlements.json");

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const client = createPublicClient({ chain: baseSepolia, transport: http() });

const cache = new Map<string, number | null>();
async function chainAmount(txHash: string): Promise<number | null> {
  if (cache.has(txHash)) return cache.get(txHash)!;
  let total: number | null = null;
  try {
    const receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });
    let sum = 0;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC.toLowerCase()) continue;
      try {
        const { eventName, args } = decodeEventLog({
          abi,
          data: log.data,
          topics: log.topics,
        });
        if (eventName === "Transfer" && args) sum += Number(args.value) / 1e6;
      } catch {
        /* not a USDC log */
      }
    }
    total = sum;
  } catch {
    total = null;
  }
  cache.set(txHash, total);
  return total;
}

function readJson<T>(file: string): T[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

type Settlement = {
  ts: string;
  provider: string;
  job?: string;
  amountUsdc: number;
  txHash: string;
  logged?: boolean;
  kind?: "commission" | "tip";
};
type Ledger = {
  ts: string;
  job: string;
  provider: string;
  providerWallet: string;
  deliverable: string;
  score: number;
  feedback: string;
  quotedPrice?: number;
  paidAmount?: number;
  txHash?: string;
  tipUsdc?: number;
  tipTxHash?: string;
};

async function main() {
  const settlements = readJson<Settlement>(SETTLEMENTS);
  const ledger = readJson<Ledger>(LEDGER);

  let changedSettlements = 0;
  let changedLedger = 0;
  let addedLedger = 0;

  // ── 1. Correct every settlement to the amount that actually moved. ──
  for (const s of settlements) {
    if (!s.txHash) continue;
    const onChain = await chainAmount(s.txHash);
    if (onChain === null) {
      console.log(`  ?  settlement ${s.txHash.slice(0, 12)}: no receipt, left as is`);
      continue;
    }
    if (Math.abs(onChain - Number(s.amountUsdc)) > 1e-9) {
      console.log(
        `  ~  settlement ${s.txHash.slice(0, 12)}: ${s.amountUsdc} -> ${onChain} (chain)`,
      );
      s.amountUsdc = onChain;
      changedSettlements++;
    }
  }

  // ── 2. Every settlement must have a ledger row. ──
  const findRow = (txHash: string) =>
    ledger.find(
      (r) =>
        (r.txHash ?? "").toLowerCase() === txHash.toLowerCase() ||
        (r.tipTxHash ?? "").toLowerCase() === txHash.toLowerCase(),
    );

  for (const s of settlements) {
    if (!s.txHash) continue;
    if (findRow(s.txHash)) continue;
    const kind = s.kind ?? "commission";
    const row: Ledger = {
      ts: s.ts,
      job: s.job ?? `${s.provider} ${kind}`,
      provider: s.provider,
      providerWallet: "0xc71DAa8fD15B713Fe27406e25bB9AdfA1fea5025",
      deliverable: "(no judged deliverable — the payment settled but the job was never judged)",
      score: 0,
      feedback:
        "Payment settled on-chain but no judge ran. Recorded so the weekly spend cap counts it.",
      paidAmount: kind === "commission" ? s.amountUsdc : 0,
      txHash: s.txHash,
      tipUsdc: kind === "tip" ? s.amountUsdc : 0,
      ...(kind === "tip" ? { tipTxHash: s.txHash } : {}),
    };
    ledger.push(row);
    addedLedger++;
    console.log(
      `  +  ledger row added for ${kind} ${s.txHash.slice(0, 12)} (${s.amountUsdc} USDC)`,
    );
  }

  // ── 3. Correct every ledger component to the amount that actually moved. ──
  for (const r of ledger) {
    if (r.txHash) {
      const onChain = await chainAmount(r.txHash);
      if (onChain !== null && Math.abs(onChain - Number(r.paidAmount ?? 0)) > 1e-9) {
        console.log(
          `  ~  ledger ${r.txHash.slice(0, 12)}: paidAmount ${r.paidAmount} -> ${onChain} (chain)`,
        );
        r.paidAmount = onChain;
        changedLedger++;
      }
    }
    if (r.tipTxHash) {
      const onChain = await chainAmount(r.tipTxHash);
      if (onChain !== null && Math.abs(onChain - Number(r.tipUsdc ?? 0)) > 1e-9) {
        console.log(
          `  ~  ledger tip ${r.tipTxHash.slice(0, 12)}: tipUsdc ${r.tipUsdc} -> ${onChain} (chain)`,
        );
        r.tipUsdc = onChain;
        changedLedger++;
      }
    }
  }

  if (changedSettlements || changedLedger || addedLedger) {
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
    fs.writeFileSync(SETTLEMENTS, JSON.stringify(settlements, null, 2) + "\n");
  }

  console.log(
    `\n${changedSettlements} settlement amounts corrected, ${changedLedger} ledger amounts corrected, ${addedLedger} ledger rows added`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
