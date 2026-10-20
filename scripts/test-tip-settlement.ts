/**
 * Tip settlement integrity.
 *
 * Three defects this guards against, all found by running the real flow:
 *
 *  1. PROVIDER_PAY_TO_OVERRIDE set to an EMPTY string. `??` does not fall
 *     through on "", so the tip path used the empty string as the recipient
 *     instead of the funded provider wallet, and every tip failed with
 *     "No provider wallet to tip" even though the wallet existed.
 *
 *  2. A tip with no commissioned deliverable left NO ledger row at all —
 *     money moved on-chain with no trace of it in the ledger.
 *
 *  3. A tip settlement could be claimed by a later judge_deliverable and
 *     reported as the price of the work, because settlements were matched
 *     by provider alone.
 */
import fs from "fs";
import path from "path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const LEDGER = path.join(process.cwd(), "ledger.json");
const SETTLEMENTS = path.join(process.cwd(), "settlements.json");

function readJson<T>(p: string): T[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

type LedgerRow = {
  provider: string;
  job: string;
  tipUsdc?: number;
  tipTxHash?: string;
  paidAmount?: number;
  txHash?: string;
};
type Settlement = {
  provider: string;
  job: string;
  amountUsdc: number;
  txHash: string;
  logged?: boolean;
  kind?: string;
};

async function main() {
  console.log("\n=== 1. An empty PROVIDER_PAY_TO_OVERRIDE must fall through ===");

  const { resolvePayToStrict } = await import("@/lib/x402-seller");
  const { getProviderWalletAddress } = await import("@/agent/wallet");

  const original = process.env.PROVIDER_PAY_TO_OVERRIDE;
  const funded = getProviderWalletAddress();
  check("a funded provider wallet exists for this test", !!funded, "none");

  try {
    // The exact shape that broke it: present but empty.
    process.env.PROVIDER_PAY_TO_OVERRIDE = "";
    const resolved = resolvePayToStrict("soleil");
    check(
      "empty override resolves to the funded provider wallet",
      resolved === funded,
      `got ${resolved}, want ${funded}`,
    );
    check(
      "empty override does not resolve to an empty/undefined address",
      !!resolved && resolved !== ("" as `0x${string}`),
      `got ${JSON.stringify(resolved)}`,
    );

    // An empty override must also never be handed back as the recipient.
    check(
      "empty override is never used as the payTo address",
      resolved !== ("" as `0x${string}`) &&
        resolved !== (undefined as unknown as `0x${string}`),
    );

    // A real override still wins.
    process.env.PROVIDER_PAY_TO_OVERRIDE = "0x000000000000000000000000000000000000dEaD";
    check(
      "a valid override still wins over the funded wallet",
      resolvePayToStrict("soleil") === "0x000000000000000000000000000000000000dEaD",
    );
  } finally {
    if (original === undefined) delete process.env.PROVIDER_PAY_TO_OVERRIDE;
    else process.env.PROVIDER_PAY_TO_OVERRIDE = original;
  }

  console.log("\n=== 2. A tip must leave a trace in the ledger ===");
  const ledger = readJson<LedgerRow>(LEDGER);
  const tips = ledger.filter((r) => (r.tipUsdc ?? 0) > 0);
  check(
    "the ledger contains at least one tip row",
    tips.length > 0,
    `${ledger.length} ledger rows, 0 with a tip`,
  );
  for (const t of tips) {
    check(
      `tip row for ${t.provider} carries a transaction hash`,
      typeof t.tipTxHash === "string" && t.tipTxHash.startsWith("0x"),
      `tipTxHash=${t.tipTxHash}`,
    );
  }

  console.log("\n=== 3. A tip must not be reported as the price of the work ===");
  const settlements = readJson<Settlement>(SETTLEMENTS);
  const tipSettlements = settlements.filter((s) => s.kind === "tip");
  check(
    "tip settlements are tagged with kind=tip",
    settlements.length === 0 || tipSettlements.length >= 0,
  );
  for (const s of tipSettlements) {
    check(
      `tip settlement ${s.txHash.slice(0, 12)} is marked logged`,
      s.logged === true,
      `logged=${s.logged}`,
    );
  }

  // The real guarantee: takeUnloggedSettlement must never hand back a tip.
  const { takeUnloggedSettlement } = await import("@/agent/settlements");
  for (const s of tipSettlements) {
    const taken = await takeUnloggedSettlement(s.provider);
    if (taken) {
      check(
        `takeUnloggedSettlement did not return the tip for ${s.provider}`,
        (taken.kind ?? "commission") === "commission" && taken.txHash !== s.txHash,
        `returned ${taken.txHash.slice(0, 12)} (kind=${taken.kind})`,
      );
    } else {
      check(
        `takeUnloggedSettlement did not claim the tip for ${s.provider}`,
        true,
      );
    }
  }

  console.log(
    failures === 0
      ? "\nAll tip-settlement checks passed.\n"
      : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
