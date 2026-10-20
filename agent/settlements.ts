/**
 * SETTLEMENT RECORDS — the code-side source of truth for "what was paid".
 *
 * WHY THIS EXISTS
 * ---------------
 * The ledger's `paidAmount` used to come from the LLM as an argument to
 * `judge_deliverable`. The model simply passed 0 (or nothing), so every row
 * in ledger.json read `paidAmount: 0` even when real USDC had moved — 51
 * entries, 0 paid. The amount that actually settled is knowable in code at
 * the moment the settlement tx confirms, so that is where it is recorded.
 *
 * `judge_deliverable` then reads the real amount from here instead of
 * trusting the model.
 */
import fs from "fs";
import path from "path";

const SETTLEMENTS_PATH = path.join(process.cwd(), "settlements.json");

/** The settlement-records file path, for callers that must read it directly. */
export const SETTLEMENTS_FILE = SETTLEMENTS_PATH;

export type Settlement = {
  ts: string;
  provider: string;
  job: string;
  amountUsdc: number;
  txHash: string;
  /** True once a ledger row has consumed this settlement. */
  logged?: boolean;
  /**
   * What kind of payment this was. A "commission" is the price of work and
   * belongs on the deliverable's ledger row; a "tip" is a gratuity and does
   * not. Without this, a tip settlement could be claimed by a later
   * judge_deliverable and reported as the price of the work.
   */
  kind?: "commission" | "tip";
};

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => T): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function readAll(): Settlement[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTLEMENTS_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as Settlement[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: Settlement[]) {
  fs.writeFileSync(SETTLEMENTS_PATH, JSON.stringify(entries, null, 2) + "\n");
}

/**
 * Record a settlement that actually happened on-chain.
 * Called only after the settlement tx is confirmed.
 */
export async function recordSettlement(
  s: Omit<Settlement, "ts" | "logged">,
): Promise<Settlement[]> {
  return serialized(() => {
    const entries = readAll();
    entries.push({ ...s, ts: new Date().toISOString() });
    writeAll(entries);
    return entries;
  });
}

/**
 * The most recent settlement for a provider that has not yet been written to
 * a ledger row. Returns null when the provider's last run was free (no
 * payment) — in which case paidAmount genuinely is 0.
 *
 * Only "commission" settlements are eligible: a tip is a gratuity, not the
 * price of the work, so it must never be reported as a deliverable's
 * paidAmount. Legacy rows with no `kind` are treated as commissions.
 */
export async function takeUnloggedSettlement(
  provider: string,
): Promise<Settlement | null> {
  return serialized(() => {
    const entries = readAll();
    for (let i = entries.length - 1; i >= 0; i--) {
      const row = entries[i];
      const kind = row.kind ?? "commission";
      if (row.provider === provider && !row.logged && kind === "commission") {
        row.logged = true;
        writeAll(entries);
        return row;
      }
    }
    return null;
  });
}

/** Every settlement recorded so far (for the report/audit tools). */
export async function listSettlements(): Promise<Settlement[]> {
  return serialized(() => readAll());
}

/**
 * Mark a settlement as already reflected in the ledger, so it is not later
 * claimed by a judge_deliverable. Used for payments that are not the price
 * of a deliverable (tips), which write their own ledger row directly.
 */
export async function markSettlementLogged(txHash: string): Promise<void> {
  return serialized(() => {
    const entries = readAll();
    for (const row of entries) {
      if (row.txHash === txHash && !row.logged) {
        row.logged = true;
        writeAll(entries);
        return;
      }
    }
  });
}
