/**
 * THE LEDGER — append-only, ledger.json at repo root.
 *
 * Every commission appends one row when judged; tips append riding on the
 * original paid row (updated tipUsdc only, never re-quoted). A naive
 * read-modify-write can race in concurrent Next dev requests, so writes
 * serialize on a module-level promise queue.
 */
import fs from "fs";
import path from "path";

export type LedgerEntry = {
  ts: string; // ISO timestamp of the commission
  jobType: string;
  provider: string;
  quotedPrice: number; // provider's asking price
  paidAmount: number; // what was actually paid (0 for free runs)
  txHash?: string; // on-chain payment or tip tx, if any
  qualityScore: number; // 1-5 from the judge (0 for unjudged rows)
  verdict: string; // judge or incident narrative
  tipUsdc: number; // gratuity on top of paidAmount
};

const LEDGER_PATH = path.join(process.cwd(), "ledger.json");

let queue: Promise<unknown> = Promise.resolve();
/** Serialize mutations so concurrent API requests can't clobber ledger.json. */
function serialized<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function readAll(): LedgerEntry[] {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return []; // first run or corrupted file: start over rather than crash
  }
}

function writeAll(entries: LedgerEntry[]) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2) + "\n");
}

/** Append one judged (or incident) row to ledger.json. */
export async function appendLedger(entry: LedgerEntry): Promise<LedgerEntry[]> {
  return serialized(() => {
    const entries = readAll();
    entries.push({ ...entry, ts: entry.ts || new Date().toISOString() });
    writeAll(entries);
    return entries;
  });
}

/** Attach a tip (and optional tx hash) to the most recent paid row per provider. */
export async function applyTipToLedger(provider: string, tipUsdc: number, txHash?: string): Promise<LedgerEntry | null> {
  return serialized(() => {
    const entries = readAll();
    for (let i = entries.length - 1; i >= 0; i--) {
      const row = entries[i];
      if (row.provider === provider && row.paidAmount > 0 && row.qualityScore > 0) {
        row.tipUsdc += tipUsdc;
        if (txHash) row.txHash = txHash;
        writeAll(entries);
        return row;
      }
    }
    return null;
  });
}

export function readLedger(): LedgerEntry[] {
  return readAll();
}

/** The hard-coded weekly cap: max spend (paid + tips) in a rolling 7-day window. */
export function sumRecentSpend(days = 7): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return readAll()
    .filter((e) => new Date(e.ts).getTime() >= cutoff)
    .reduce((sum, e) => sum + e.paidAmount + e.tipUsdc, 0);
}
