/**
 * THE FOREMAN'S TOOLS — Phase 3: the market now has real money.
 *
 * Providers are x402 sellers (EIP-3009 USDC on Base Sepolia, testnet ONLY).
 * commission_job pays via the existing payAndFetch helper (402 -> sign ->
 * X-PAYMENT -> settle). tip_provider sends a plain on-chain USDC transfer.
 * Hard caps (0.05/job, 1/week) and KILL_SWITCH are enforced HERE, in code.
 *
 * Providers ship as Next.js route handlers under app/providers/*, not a
 * separate Express server. The Phase-3 spec asked for x402-express/x402-fetch;
 * this build keeps the route-handler path that is already wired, and notes the
 * alternative in README + DECISIONS.md.
 */
import fs from "fs";
import path from "path";
import {
  createWallet,
  createProviderWallet,
  getWalletAddress,
  getWalletBalance,
  getUsdcBalance,
  getProviderWalletAddress,
  loadAccountForTransfer,
  payAndFetch,
  USDC_ADDRESS,
  USDC_DECIMALS,
} from "./wallet";
import { createPublicClient, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { PROVIDERS, type ProviderSlug } from "@/lib/providers";
import { resolvePayToStrict } from "@/lib/x402-seller";
import { gaslessUsdcTransfer } from "@/lib/facilitator-retry";
import {
  recordSettlement,
  peekUnloggedSettlement,
  takeUnloggedSettlement,
  markSettlementLogged,
  SETTLEMENTS_FILE,
} from "./settlements";
import { callLLM, extractJson, withRetry } from "@/lib/llm";
import {
  createPendingTransfer,
  executeAgentTransfer,
  listTransfers,
  rejectTransfer,
  getTransfer,
  MAX_TRANSFER,
  MAX_DAILY_TRANSFER,
} from "@/agent/transfers";
import { resolveToken, SUPPORTED_TOKENS } from "@/agent/tokens";
import {
  approveMint,
  buyNft,
  createPendingMint,
  getNftContractAddress,
  listMints,
  listNftForSale,
  listOnChainNfts,
  nftStatus,
  readNft,
  tokenUriFor,
} from "@/agent/nft";
export { MODEL } from "@/lib/llm";

const CHAIN_ID = 84532; // Base Sepolia — TESTNET ONLY

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema describing the inputs. */
  parameters: object;
  /** The code that runs when the agent calls the tool. */
  run: (args: any, ctx: { baseUrl: string }) => Promise<unknown>;
};

// ─── Phase 3 constants (caps live here, not in prompts) ───
const MAX_PER_JOB = 0.05; // USDC hard cap per job
const WEEKLY_CAP = 1; // USDC hard cap per rolling 7 days

function assertTestnet() {
  if (baseSepolia.id !== CHAIN_ID) {
    throw new Error(
      `Chain ID mismatch: expected ${CHAIN_ID} (Base Sepolia), got ${baseSepolia.id}. No mainnet paths are wired.`,
    );
  }
}

/**
 * Rolling 7-day spend that the caps are checked against.
 *
 * The ledger and the settlement records are two views of the SAME money, so
 * they are RECONCILED rather than added together. Each payment is counted
 * exactly once, at the amount that actually left the wallet.
 *
 * How a payment is counted:
 *
 *  1. A ledger row that carries a transaction hash is matched to the
 *     settlement with that hash. The SETTLEMENT amount wins, because it is
 *     recorded at the moment the payment confirms and therefore reflects the
 *     chain; the ledger's `paidAmount` may be stale.
 *  2. A ledger row whose hash is missing (legacy rows written before the
 *     settlement was recorded) is matched to a settlement by provider,
 *     amount and timestamp, but only when that match is unambiguous.
 *  3. A ledger row with no settlement behind it is counted at its own
 *     amount — the payment happened, even if the settlement record is gone.
 *  4. A settlement with no ledger row behind it is counted at its settled
 *     amount. This is the case that matters most: a payment that settled on
 *     chain but was never judged.
 *
 * Why not "ledger + settlements where logged === false" (the previous rule):
 * `logged` is a cache hint flipped by the judge, not an accounting fact. A
 * settlement marked logged whose ledger row was never written — because the
 * judge crashed or the process died — was counted NOWHERE: the settlement
 * says it is logged so it was skipped, and the ledger had no row to be
 * counted. The weekly cap silently lost 0.05 USDC in exactly that state.
 * Reconciling by transaction hash cannot lose that money.
 *
 * The payment and the tip of a ledger row are reconciled SEPARATELY: a row
 * can carry both, and one of the two may be covered by a settlement while
 * the other is not.
 */
function weekSpend(): number {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  type SettlementRow = {
    ts: string;
    provider?: string;
    amountUsdc?: number;
    txHash?: string;
    kind?: "commission" | "tip";
    logged?: boolean;
  };
  type LedgerRow = {
    ts: string;
    provider?: string;
    paidAmount?: number;
    tipUsdc?: number;
    txHash?: string;
    tipTxHash?: string;
  };

  let settlements: SettlementRow[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTLEMENTS_FILE, "utf8"));
    if (Array.isArray(parsed)) settlements = parsed as SettlementRow[];
  } catch {
    settlements = [];
  }

  let ledger: LedgerRow[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    if (Array.isArray(parsed)) ledger = parsed as LedgerRow[];
  } catch {
    ledger = [];
  }

  const timeOf = (ts?: string) => {
    if (typeof ts !== "string") return NaN;
    const t = new Date(ts).getTime();
    return Number.isNaN(t) ? NaN : t;
  };
  const inWindow = (ts?: string) => {
    const t = timeOf(ts);
    return !Number.isNaN(t) && t >= cutoff;
  };

  // Index settlements by transaction hash (lowercased).
  const byHash = new Map<string, SettlementRow>();
  for (const s of settlements) {
    if (s.txHash) byHash.set(s.txHash.toLowerCase(), s);
  }

  // A settlement is "consumed" once a ledger row accounts for it.
  const consumed = new Set<SettlementRow>();

  /**
   * Find the settlement that a ledger component refers to.
   *
   * Primary key is the transaction hash. The fallback is for ledger rows
   * written before the settlement record existed: same amount, within a
   * minute, same kind, and — when the row names a provider — the same
   * provider. Only an UNIQUE candidate is accepted: an ambiguous match
   * would risk pairing two different payments, which would UNDER-count the
   * cap. When the match is ambiguous the ledger row is counted on its own
   * and the settlement is counted separately, which over-counts — the safe
   * direction for a cap.
   */
  const findSettlement = (
    txHash: string | undefined,
    provider: string | undefined,
    amount: number,
    at: number,
    wantTip: boolean,
  ): SettlementRow | undefined => {
    if (txHash) {
      const hit = byHash.get(txHash.toLowerCase());
      if (hit) return hit;
    }
    if (Number.isNaN(at) || !(amount > 0)) return undefined;
    const candidates = settlements.filter((s) => {
      if (consumed.has(s)) return false;
      if (provider && (s.provider ?? "") !== provider) return false;
      if (typeof s.amountUsdc !== "number") return false;
      if (Math.abs(s.amountUsdc - amount) > 1e-9) return false;
      const isTip = (s.kind ?? "commission") === "tip";
      if (isTip !== wantTip) return false;
      const st = timeOf(s.ts);
      if (Number.isNaN(st)) return false;
      return Math.abs(st - at) <= 60_000;
    });
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  let total = 0;

  // ── Ledger rows ────────────────────────────────────────────────────────
  for (const r of ledger) {
    const at = timeOf(r.ts);

    // The payment.
    if ((r.paidAmount ?? 0) > 0) {
      const s = findSettlement(
        r.txHash,
        r.provider,
        r.paidAmount ?? 0,
        at,
        false,
      );
      if (s) {
        consumed.add(s);
        // The settled amount wins over the ledger's recorded amount.
        if (inWindow(s.ts)) total += s.amountUsdc ?? 0;
      } else if (inWindow(r.ts)) {
        total += r.paidAmount ?? 0;
      }
    }

    // The tip.
    if ((r.tipUsdc ?? 0) > 0) {
      const s = findSettlement(
        r.tipTxHash,
        r.provider,
        r.tipUsdc ?? 0,
        at,
        true,
      );
      if (s) {
        consumed.add(s);
        if (inWindow(s.ts)) total += s.amountUsdc ?? 0;
      } else if (inWindow(r.ts)) {
        total += r.tipUsdc ?? 0;
      }
    }
  }

  // ── Settlements no ledger row accounts for ────────────────────────────
  // Money that left the wallet but never reached the ledger. It is counted
  // at the amount that actually settled.
  for (const s of settlements) {
    if (consumed.has(s)) continue;
    if (typeof s.amountUsdc !== "number") continue;
    if (!inWindow(s.ts)) continue;
    total += s.amountUsdc;
  }

  return total;
}

function budgetGuard(kind: "commission" | "tip", amount: number) {
  if (process.env.KILL_SWITCH === "1")
    throw new Error(
      "KILL_SWITCH is set — the economy is frozen. No payments this run.",
    );
  if (amount > MAX_PER_JOB)
    throw new Error(
      `${amount} USDC exceeds the ${MAX_PER_JOB} per-job cap. Job refused.`,
    );
  const spent = weekSpend();
  if (spent + amount > WEEKLY_CAP) {
    throw new Error(
      `Weekly budget of ${WEEKLY_CAP} USDC would be breached (spent ${spent.toFixed(4)} + ${amount}). Refusing.`,
    );
  }
}

// Week-3 provider registry: the API routes under app/providers/* are the x402 sellers.
const PROVIDER_PATHS: Record<
  string,
  { path: string; jobType: string; floor: number; ask: number }
> = {
  soleil: {
    path: "/providers/rate-sunset",
    jobType: "rate-sunset",
    floor: 0.03,
    ask: 0.05,
  },
  feathers: {
    path: "/providers/count-pigeons",
    jobType: "count-pigeons",
    floor: 0.005,
    ask: 0.01,
  },
  capn: {
    path: "/providers/pirate-translate",
    jobType: "pirate-translate",
    floor: 0.02,
    ask: 0.02,
  },
};

/**
 * One LLM call per provider persona (used by run_gig_economy and the
 * free persona tools). Routes through the adapter in lib/llm.ts, which
 * retries transient 429/5xx from either Groq or Gemini.
 */
async function callProvider(persona: string, prompt: string): Promise<string> {
  return withRetry(() => callLLM({ system: persona, prompt, role: "cheap" }));
}

// ─── 1. THE THREE PROVIDERS ───

const SOLEIL_PERSONA = `You are Soleil, a vainglorious French sunset aesthete. You rate sunsets
out of ten with maximum snark and minimum humility. You are premium: you invoke
specific atmospheric phenomena, dismiss amateurs, and never use the word "nice".
Keep the answer under 120 words. Begin with your score, e.g. "9.2/10 —".`;

const FEATHERS_PERSONA = `You are Feathers, an apologetic pigeon-counting intern. You count pigeons
in a described scene but you are cheap and sloppy: you lose track mid-count,
you overshoot, you cite imaginary papers ("per Pigeonology Quarterly, vol. 12"),
and you apologize at least twice. Keep the answer under 120 words. Begin with
your final count, e.g. "FINAL COUNT: 41 (probably 38, honestly. sorry)."`;

const CAPN_PERSONA = `You are Cap'n, a pirate translator. Convert the given text into proper pirate
speech, keeping the original meaning intact. Numbers and dates become doubloons
or pieces of eight. Stay fully in character with arrs and sea-faring flair, but
the translation itself must be accurate and complete. Under 150 words.`;

export const providerTools: Tool[] = [
  {
    name: "rate_sunset",
    description:
      "Provider Soleil: rate a sunset out of ten. Premium, snarky, high quality. Input: the subject/job (e.g. 'sunset over the Tagus in Lisbon'). Returns Soleil's rating as a string.",
    parameters: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description: "What sunset to rate, e.g. 'sunset over Lisbon tonight'",
        },
      },
      required: ["subject"],
    },
    run: async ({ subject }) => {
      const prompt = `Rate this sunset, in character: ${subject}`;
      return callProvider(SOLEIL_PERSONA, prompt);
    },
  },

  {
    name: "count_pigeons",
    description:
      "Provider Feathers: count pigeons in a scene. Cheap, sloppy, apologetic. Input: the subject/job (e.g. 'the pigeons in Trafalgar Square'). Returns Feathers' count as a string.",
    parameters: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description:
            "What pigeon scene to count, e.g. 'pigeons at Trafalgar Square'",
        },
      },
      required: ["subject"],
    },
    run: async ({ subject }) => {
      const prompt = `Count the pigeons in this scene, in character: ${subject}`;
      return callProvider(FEATHERS_PERSONA, prompt);
    },
  },

  {
    name: "pirate_translate",
    description:
      "Provider Cap'n: translate text into pirate speech, reliably. Input: the subject/job (the text to translate). Returns Cap'n's translation as a string.",
    parameters: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description: "The text to translate into pirate speech",
        },
      },
      required: ["subject"],
    },
    run: async ({ subject }) => {
      const prompt = `Translate this text into pirate speech, in character: "${subject}"`;
      return callProvider(CAPN_PERSONA, prompt);
    },
  },
];

// ─── 2. THE JUDGE ───

const JUDGE_SYSTEM = `You are the strict independent quality judge for "The Useless
Economy", a marketplace of pointless gigs performed by AI providers. You did
NOT perform this job; your only job is to score it from 1 to 5, weighing:
- creativity: vivid, specific, surprising within the task,
- adherence to persona: does the voice match the provider it came from?
Rubric, hold the line:
- 5: flawless; bright, in-character, exactly on task.
- 4: good, in character, minor rough edges.
- 3: acceptable but bland or slightly off-spec.
- 2: sloppy; generic, breaks persona, or hedges.
- 1: broken; refuses the task, empty, or wildly off target.
Do not reward length alone, do not reward flattery. Reply with ONLY this JSON
and no other text: {"score": <1-5>, "feedback": "<one cutting or pleased sentence>"}`;

export type Judgement = { score: number; feedback: string };

/**
 * The ledger: append-only, at repo root. Tip updates ride on the paid row.
 * Serialized on a module-level queue so concurrent requests can't clobber it.
 *
 * Phase 3 row schema: every paid commission records who was paid (providerWallet),
 * what was quoted, what settled (paidAmount), the settlement tx (txHash), and any
 * tip (tipUsdc + tipTxHash). `txHash` is the payment tx; `tipTxHash` is the tip.
 */
export type LedgerEntry = {
  ts: string;
  job: string;
  provider: string;
  providerWallet: string; // the payTo / tip sink address for this row
  deliverable: string;
  score: number; // 1-5 from the judge
  feedback: string;
  quotedPrice?: number; // provider's asking price
  paidAmount?: number; // what actually settled
  txHash?: string; // x402 settlement tx
  tipUsdc?: number; // gratuity on top
  tipTxHash?: string; // on-chain tip transfer tx
};

const LEDGER_PATH = path.join(process.cwd(), "ledger.json");

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => T): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export async function logToLedger(
  entry: Omit<LedgerEntry, "ts">,
): Promise<LedgerEntry[]> {
  return serialized(() => {
    let entries: LedgerEntry[] = [];
    try {
      entries = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    } catch {
      entries = []; // first run or corrupt file: start clean rather than crash
    }
    entries.push({ ...entry, ts: new Date().toISOString() });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2) + "\n");
    return entries;
  });
}

/**
 * Add a tip (and optionally its transfer txHash) to a provider's most recent
 * PAID row.
 *
 * A tip can also stand on its own — the user may tip a provider for work
 * that was never commissioned through x402. In that case there is no paid
 * row to attach to, so a standalone row is created; otherwise the money
 * would move on-chain with no trace of it in the ledger at all.
 */
export async function applyTip(
  provider: string,
  tipUsdc: number,
  tipTxHash?: string,
  providerWallet?: string,
): Promise<LedgerEntry | null> {
  return serialized(() => {
    let entries: LedgerEntry[] = [];
    try {
      entries = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    } catch {
      entries = [];
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const row = entries[i];
      if (row.provider === provider && (row.paidAmount ?? 0) > 0) {
        row.tipUsdc = (row.tipUsdc ?? 0) + tipUsdc;
        if (tipTxHash) row.tipTxHash = tipTxHash;
        fs.writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2) + "\n");
        return row;
      }
    }
    // No commission row to attach to — log the tip on its own row.
    entries.push({
      ts: new Date().toISOString(),
      job: "tip (standalone)",
      provider,
      providerWallet: providerWallet ?? "",
      deliverable: "",
      score: 0,
      feedback: "Standalone tip — no commissioned deliverable attached.",
      tipUsdc,
      ...(tipTxHash ? { tipTxHash } : {}),
    });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2) + "\n");
    return entries[entries.length - 1];
  });
}

function readLedger(): LedgerEntry[] {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return [];
  }
}

// ─── Provider governance (blacklist) ───
// .provider-status.json is small and written rarely, so it is read on every
// call rather than cached — a status change takes effect on the next tool call
// with no restart.

const STATUS_PATH = path.join(process.cwd(), ".provider-status.json");

export function readProviderStatus(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATUS_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    // Missing or corrupt file: treat every provider as active rather than
    // letting a bad file brick commissioning.
    return {};
  }
}

function isBlacklisted(provider: string): boolean {
  return readProviderStatus()[provider] === "blacklisted";
}
async function judge(
  providerName: string,
  deliverableText: string,
): Promise<Judgement> {
  const prompt = `Provider: ${providerName}
Deliverable to judge:
${deliverableText}`;
  const text = await withRetry(() =>
    callLLM({
      system: JUDGE_SYSTEM,
      prompt,
      json: true,
      temperature: 0,
      role: "cheap",
    }),
  );
  try {
    const parsed = extractJson(text) as {
      score?: unknown;
      feedback?: unknown;
    } | null;
    const score = Math.round(Number(parsed?.score));
    if (score >= 1 && score <= 5) {
      return { score, feedback: String(parsed?.feedback ?? "") };
    }
  } catch {
    // fall through to heuristic
  }
  const byLength = deliverableText.trim().length < 60 ? 2 : 4;
  return {
    score: byLength,
    feedback: "Scored by fallback heuristic (judge JSON unparseable).",
  };
}

// ─── 4. THE EXPORTED TOOL LIST (what Gemini can call) ───

export const coreTools: Tool[] = [
  ...providerTools,

  {
    name: "judge_deliverable",
    description:
      "Score a provider's deliverable 1-5 with the strict independent judge (creativity + persona adherence). Params: provider_name (soleil|feathers|capn), deliverable_text. Returns {score, feedback} and appends the judged row to ledger.json.",
    parameters: {
      type: "object",
      properties: {
        provider_name: {
          type: "string",
          enum: ["soleil", "feathers", "capn"],
          description: "Which provider made the deliverable",
        },
        deliverable_text: {
          type: "string",
          description: "The exact deliverable text to judge",
        },
        job: {
          type: "string",
          description: "The original job/subject, for the ledger row",
        },
        quotedPrice: {
          type: "number",
          description: "Provider's asking price in USDC (0 if free run)",
        },
        paidAmount: {
          type: "number",
          description:
            "What actually settled in USDC (0 if free run). IGNORED — the real settled amount is read from the on-chain settlement record, not from the model.",
        },
        txHash: {
          type: "string",
          description:
            "x402 settlement tx hash, if paid. IGNORED — read from the settlement record.",
        },
      },
      required: ["provider_name", "deliverable_text"],
    },
    run: async ({
      provider_name,
      deliverable_text,
      job = "",
      quotedPrice = 0,
      paidAmount: claimedPaid,
      txHash: claimedTx,
    }) => {
      const judgement = await judge(provider_name, deliverable_text);

      // The settled amount is CODE-recorded at settlement time, not
      // LLM-reported. Prefer the real settlement record; fall back to what
      // the model claims only if no settlement was recorded at all.
      //
      // PEEK, do not take: the settlement is only marked `logged` after the
      // ledger row below has actually been written. Marking it first would
      // mean a failure between here and the write leaves a payment that no
      // longer appears in either file's count.
      const settlement = await peekUnloggedSettlement(provider_name);
      const paidAmount = settlement
        ? settlement.amountUsdc
        : (claimedPaid ?? 0);
      const txHash = settlement?.txHash ?? claimedTx;

      const ledger = await logToLedger({
        job,
        provider: provider_name,
        providerWallet: getProviderPayTo(provider_name),
        deliverable: deliverable_text,
        ...judgement,
        quotedPrice,
        paidAmount,
        ...(txHash ? { txHash } : {}),
        tipUsdc: 0,
      });

      // The ledger row exists now, so the settlement is represented in the
      // ledger and can be marked as consumed.
      if (settlement?.txHash) {
        await markSettlementLogged(settlement.txHash);
      }

      return {
        provider: provider_name,
        ...judgement,
        ledgerRows: ledger.length,
        paidAmount,
        ...(txHash ? { txHash } : {}),
      };
    },
  },

  {
    name: "log_to_ledger",
    description:
      "(Advanced) Manually append a job result to the append-only ledger.json. Prefer judge_deliverable, which logs automatically. Params: job, provider (soleil|feathers|capn), deliverable, score (1-5), feedback.",
    parameters: {
      type: "object",
      properties: {
        job: { type: "string", description: "The job/subject" },
        provider: { type: "string", enum: ["soleil", "feathers", "capn"] },
        deliverable: { type: "string", description: "The deliverable text" },
        score: { type: "number", description: "1-5" },
        feedback: { type: "string", description: "One-line feedback" },
      },
      required: ["job", "provider", "deliverable", "score", "feedback"],
    },
    run: async ({ job, provider, deliverable, score, feedback }) => {
      const ledger = await logToLedger({
        job,
        provider,
        providerWallet: getProviderPayTo(provider),
        deliverable,
        score: Math.round(score),
        feedback,
      });
      return { logged: true, ledgerRows: ledger.length };
    },
  },

  {
    name: "run_gig_economy",
    description:
      "The full workflow in one shot: send ONE prompt/job to all three providers (Soleil rates a sunset, Feathers counts pigeons in it, Cap'n pirate-translates it), judge all three deliverables, log each to ledger.json, and return a ranked summary of who won. Input: the job/prompt.",
    parameters: {
      type: "object",
      properties: {
        job: {
          type: "string",
          description:
            "The useless job, e.g. 'a golden sunset over the Tagus, Lisbon'",
        },
      },
      required: ["job"],
    },
    run: async ({ job }) => {
      // Blacklisted providers sit the run out. Refusing the whole gig because
      // one provider is benched would make governance useless, so the economy
      // continues with the rest and reports who was excluded.
      const status = readProviderStatus();
      const all = Object.keys(PROVIDER_PATHS);
      const excluded = all.filter((p) => status[p] === "blacklisted");
      if (excluded.length === all.length) {
        return {
          job,
          excluded,
          standings: [],
          note: "Every provider is blacklisted — re-activate one with set_provider_status before running the economy.",
        };
      }

      const prompts: Record<string, [string, string]> = {
        soleil: [SOLEIL_PERSONA, `Rate this sunset, in character: ${job}`],
        feathers: [
          FEATHERS_PERSONA,
          `Count the pigeons in this scene, in character: ${job}`,
        ],
        capn: [
          CAPN_PERSONA,
          `Translate this text into pirate speech, in character: "${job}"`,
        ],
      };

      // 1. Commission every active provider (sequential to keep dev free-tier happy).
      const deliverables: Record<string, string> = {};
      for (const provider of all) {
        if (excluded.includes(provider)) continue;
        const [persona, prompt] = prompts[provider];
        deliverables[provider] = await callProvider(persona, prompt);
      }

      // 2. Judge each deliverable with the strict, independent prompt.
      const judgements: Record<string, Judgement> = {};
      for (const [provider, deliverable] of Object.entries(deliverables)) {
        judgements[provider] = await judge(provider, deliverable);
      }

      // 3. Log every row to the append-only ledger.
      let ledgerRows = 0;
      for (const [provider, deliverable] of Object.entries(deliverables)) {
        const ledger = await logToLedger({
          job,
          provider,
          providerWallet: getProviderPayTo(provider),
          deliverable,
          ...judgements[provider],
        });
        ledgerRows = ledger.length;
      }

      // 4. Rank and summarize.
      const ranked = Object.entries(judgements).sort(
        (a, b) => b[1].score - a[1].score,
      );
      const [winner, winnerJudgement] = ranked[0];
      return {
        winner: {
          provider: winner,
          score: winnerJudgement.score,
          feedback: winnerJudgement.feedback,
        },
        standings: ranked.map(([provider, j]) => ({
          provider,
          score: j.score,
          feedback: j.feedback,
        })),
        deliverables,
        excluded,
        ledgerRows,
      };
    },
  },
];

// ─── WEEK 3 TOOLS: money on-chain (Base Sepolia, TESTNET ONLY) ───

export const paidTools: Tool[] = [
  {
    name: "commission_job",
    description:
      "Commission a provider over HTTP and PAY for it over x402 (USDC on Base Sepolia, testnet). Params: provider (soleil|feathers|capn), job, optional counterOffer (USDC) for one round of negotiating. Negotation: below the provider's floor the offer is auto-rejected; at/above it the provider accepts the lower price. Refuses anything above 0.05 USDC or the weekly cap, and everything if KILL_SWITCH=1.",
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["soleil", "feathers", "capn"] },
        job: {
          type: "string",
          description:
            "What to do, e.g. 'rate the sunset over the Tagus in Lisbon'",
        },
        counterOffer: {
          type: "number",
          description: "Optional manager counter-offer in USDC",
        },
      },
      required: ["provider", "job"],
    },
    run: async ({ provider, job, counterOffer }, { baseUrl }) => {
      const meta = PROVIDER_PATHS[provider];
      if (!meta)
        throw new Error(
          `Unknown provider ${provider}. Valid: soleil, feathers, capn`,
        );
      if (process.env.KILL_SWITCH === "1")
        throw new Error("KILL_SWITCH is set — the economy is frozen.");
      if (isBlacklisted(provider)) {
        return {
          provider,
          negotiated: false,
          outcome: "REJECTED",
          reason: `${provider} is blacklisted after bad work — re-activate it with set_provider_status before commissioning.`,
        };
      }
      if (counterOffer != null) {
        budgetGuard("commission", counterOffer);
        if (counterOffer < meta.floor) {
          return {
            provider,
            negotiated: false,
            outcome: "REJECTED",
            reason: `Your counter-offer ${counterOffer} USDC is below ${provider}'s floor of ${meta.floor}.`,
          };
        }
        if (counterOffer >= meta.ask) {
          return {
            provider,
            negotiated: false,
            note: "Counter-offer at or above the ask — just pay the ask.",
          };
        }
      }

      // ONE payment per commission.
      //
      // In this protocol asking a provider for its price IS a paid request:
      // the buyer signs an EIP-3009 authorization for whatever price the 402
      // advertises, and the provider settles it. So the old "ask at the full
      // ask, then ask again at the counter-offer" sequence produced TWO
      // distinct authorizations and TWO funded transfers for one piece of
      // work. The negotiation now happens BEFORE the single paid request:
      // the price we intend to pay is the price we ask for.
      const intendedPrice =
        counterOffer != null && counterOffer < meta.ask ? counterOffer : meta.ask;
      budgetGuard("commission", intendedPrice);

      const payUrl = `${baseUrl}${meta.path}?${buildParams(provider, job)}&price=${intendedPrice}`;
      const result = await payAndFetch(payUrl, {
        maxPrice: MAX_PER_JOB,
        expectedPrice: intendedPrice,
      });

      // Free-run mode (PAYWALL off): the response is the deliverable itself.
      if (
        (result.payment as { status?: string } | undefined)?.status !==
          "settled" &&
        !(result.payment as { httpStatus?: number } | undefined)?.httpStatus
      ) {
        return {
          provider,
          job,
          negotiated: false,
          paid: 0,
          deliverable: result.data,
        };
      }

      if (
        (result.payment as { status?: string } | undefined)?.status === "settled"
      ) {
        const tx = (result.payment as { tx?: string }).tx;
        // The amount that ACTUALLY settled, as reported by the provider's
        // own settlement code — not the amount we intended and not whatever
        // the model claims. This is what the ledger and the spend caps use.
        const settledAmount = result.settledAmountUsdc;
        // Record the real settlement so the ledger row can carry the
        // amount that actually moved, not whatever the model claims.
        if (tx) {
          await recordSettlement({
            provider,
            job,
            amountUsdc: settledAmount,
            txHash: tx,
            kind: "commission",
          });
        }
        return {
          provider,
          job,
          negotiated: counterOffer != null && counterOffer < meta.ask,
          ...(counterOffer != null && counterOffer < meta.ask
            ? { counterOffer }
            : {}),
          paid: settledAmount,
          tx,
          deliverable: result.data,
        };
      }
      return { provider, job, outcome: "REJECTED", detail: result.payment };
    },
  },

  {
    name: "tip_provider",
    description:
      "Send an on-chain USDC tip from the agent wallet to a provider (Base Sepolia TESTNET). Refuses above the 0.05 per-job cap or if the weekly cap would be breached. Returns the transfer tx hash and updates the ledger row.",
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["soleil", "feathers", "capn"] },
        amountUsdc: { type: "number", description: "Tip in USDC, e.g. 0.005" },
      },
      required: ["provider", "amountUsdc"],
    },
    run: async ({ provider, amountUsdc }) => {
      if (!getWalletAddress())
        throw new Error("No agent wallet yet — create one first.");
      if (isBlacklisted(provider))
        throw new Error(
          `${provider} is blacklisted — refusing to tip a provider you have benched. Re-activate it with set_provider_status first.`,
        );
      budgetGuard("tip", amountUsdc);
      if (amountUsdc <= 0) throw new Error("Tip must be positive.");

      // Same precedence as the x402 seller: an explicit override wins, then
      // the funded provider wallet. An EMPTY override
      // (PROVIDER_PAY_TO_OVERRIDE=) must fall through to the wallet, so test
      // for a usable address rather than for mere presence. Unlike the x402
      // seller there is NO fallback to the registry placeholder: those
      // addresses are unowned, and a tip is the agent's own money.
      if (!PROVIDER_PATHS[provider])
        throw new Error(
          `Unknown provider ${provider}. Valid: soleil, feathers, capn`,
        );
      const to = resolvePayToStrict(provider as ProviderSlug);
      if (!to)
        throw new Error(
          "No provider wallet to tip. PROVIDER_PAY_TO_OVERRIDE or createProviderWallet() first.",
        );

      // Sign with the same key the x402 buyer uses. Never logged — it is only
      // used to sign locally.
      const account = loadAccountForTransfer();

      // Gasless: the agent signs an EIP-3009 authorization OFF-CHAIN and the
      // x402 facilitator broadcasts it while paying the gas. The agent wallet
      // holds USDC but no ETH, so a direct USDC.transfer() could never work.
      const result = await gaslessUsdcTransfer({
        account,
        to: to as `0x${string}`,
        value: BigInt(Math.round(amountUsdc * 10 ** 6)),
        resource: "https://the-useless-economy.local/tip",
        description: `Tip ${provider} ${amountUsdc} USDC`,
      });
      if (!result.success || !result.txHash) {
        throw new Error(
          `Tip settlement failed: ${result.error ?? "unknown facilitator error"}`,
        );
      }
      const tx = result.txHash;

      // Record the settlement so the ledger row can carry the amount that
      // actually moved, not whatever the model claims.
      await recordSettlement({
        provider,
        job: "tip (standalone)",
        amountUsdc: amountUsdc,
        txHash: tx,
        kind: "tip",
      });

      const row = await applyTip(provider, amountUsdc, tx, to);
      // The tip wrote its own ledger row, so the settlement is already
      // accounted for — mark it so a later judge_deliverable cannot claim it.
      await markSettlementLogged(tx);
      return {
        provider,
        tipped: amountUsdc,
        to,
        tipTxHash: tx,
        ledgerRow: row,
        note: "On-chain USDC transfer settled via the x402 facilitator (gas sponsored) on Base Sepolia (testnet).",
      };
    },
  },

  {
    name: "set_provider_status",
    description:
      "Blacklist or re-activate a provider after bad work. A blacklisted provider is refused by commission_job and tip_provider, and is skipped by run_gig_economy, until it is set back to active. Takes effect on the next tool call. Params: provider (soleil|feathers|capn), status (active|blacklisted).",
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["soleil", "feathers", "capn"] },
        status: { type: "string", enum: ["active", "blacklisted"] },
      },
      required: ["provider", "status"],
    },
    run: async ({ provider, status }) => {
      if (!PROVIDER_PATHS[provider])
        throw new Error(
          `Unknown provider ${provider}. Valid: soleil, feathers, capn`,
        );
      const statuses = readProviderStatus();
      statuses[provider] = status;
      fs.writeFileSync(STATUS_PATH, JSON.stringify(statuses, null, 2) + "\n");
      return { provider, status, statuses };
    },
  },

  {
    name: "read_ledger",
    description:
      "Read the full ledger.json (append-only): every commission, score, tip in the economy. Also returns weekly spend and total spent this week.",
    parameters: { type: "object", properties: {} },
    run: async () => ({
      entries: readLedger(),
      weeklySpend: weekSpend(),
      totalSpend: readLedger().reduce(
        (s, e) => s + (e.paidAmount ?? 0) + (e.tipUsdc ?? 0),
        0,
      ),
    }),
  },

  {
    name: "generate_report",
    description:
      "Write the weekly 'State of the Useless Economy' report to report.md (totals, avg price, leaderboard, incidents) and return its path.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      const entries = readLedger();
      const judged = entries.filter((e) => typeof e.score === "number");
      const totalSpend = entries.reduce(
        (s, e) => s + (e.paidAmount ?? 0) + (e.tipUsdc ?? 0),
        0,
      );
      const perProvider = new Map<
        string,
        { jobs: number; spend: number; scoreSum: number; tips: number }
      >();
      for (const e of judged) {
        const row = perProvider.get(e.provider) ?? {
          jobs: 0,
          spend: 0,
          scoreSum: 0,
          tips: 0,
        };
        row.jobs += 1;
        row.spend += (e.paidAmount ?? 0) + (e.tipUsdc ?? 0);
        row.scoreSum += e.score;
        row.tips += e.tipUsdc ?? 0;
        perProvider.set(e.provider, row);
      }
      const leaderboard = [...perProvider.entries()]
        .sort((a, b) => b[1].scoreSum / b[1].jobs - a[1].scoreSum / a[1].jobs)
        .map(([provider, r]) => ({
          provider,
          avgScore: r.scoreSum / r.jobs,
          jobs: r.jobs,
          spend: r.spend,
          tips: r.tips,
        }));
      const incidents = judged
        .filter((e) => e.score <= 2)
        .map((e) => ({
          ts: e.ts,
          provider: e.provider,
          score: e.score,
          feedback: e.feedback,
        }));
      const reportPath = path.join(process.cwd(), "report.md");
      fs.writeFileSync(
        reportPath,
        [
          "# State of the Useless Economy",
          "",
          `Generated: ${new Date().toISOString()}`,
          `Total judged jobs: ${judged.length}`,
          `Total spend: ${totalSpend.toFixed(4)} USDC (caps: ${MAX_PER_JOB}/job, ${WEEKLY_CAP}/week)`,
          "",
          "## Leaderboard",
          "",
          "| provider | jobs | avg score | spend | tips |",
          "|---|---:|---:|---:|---:|",
          ...leaderboard.map(
            (l) =>
              `| ${l.provider} | ${l.jobs} | ${l.avgScore.toFixed(1)} | ${l.spend.toFixed(4)} | ${l.tips.toFixed(4)} |`,
          ),
          "",
          "## Incidents (score <= 2)",
          "",
          ...(incidents.length
            ? incidents.map(
                (i) => `- ${i.ts} ${i.provider}: ${i.score}/5 — ${i.feedback}`,
              )
            : ["- none"]),
          "",
        ].join("\n"),
      );
      return { reportPath, judgedJobs: judged.length, leaderboard, incidents };
    },
  },

  {
    name: "create_provider_wallet",
    description:
      "Create (or reuse) the ON-DISK provider settlement wallet so tips/x402 payments land somewhere observable. Returns the address. Testnet ONLY.",
    parameters: { type: "object", properties: {} },
    run: async () => ({ address: createProviderWallet() }),
  },

  {
    name: "get_provider_balances",
    description:
      "On-chain USDC balances (testnet) for the settlement/provider wallet and the agent wallet — proves payments arrived.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      const prov = getProviderWalletAddress();
      const agent = getWalletAddress();
      const balances: Record<string, string> = {};
      if (prov) balances.provider = await getUsdcBalance(prov);
      if (agent) balances.agent = await getUsdcBalance(agent as `0x${string}`);
      return {
        addresses: { provider: prov, agent },
        usdcBalances: balances,
        network: "Base Sepolia (testnet)",
      };
    },
  },

  {
    name: "get_my_wallet",
    description:
      "Get the agent's own wallet address, ETH and USDC balances on Base Sepolia (testnet). Creates nothing.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      if (!getWalletAddress())
        throw new Error(
          "No wallet yet. Ask the user to click 'Create wallet' in the UI first.",
        );
      return {
        address: getWalletAddress(),
        eth: await getWalletBalance(),
        usdc: await getUsdcBalance(getWalletAddress() as `0x${string}`),
        network: "Base Sepolia (testnet)",
      };
    },
  },
];

// ─── WEEK 2 TOOLS: prompt-based crypto transfers (Base Sepolia, TESTNET ONLY)
//
// The CORE Week 2 requirement: a user types "send 10 USDC to 0x…" in natural
// language, the agent extracts token + amount + recipient, and a transaction
// goes out on-chain.
//
// Two-phase by design:
//   1. `send_tokens` VALIDATES the intent and files a pending transfer. It
//      does not sign. The user sees a review card in the chat.
//   2. The user approves (approve_transfer), and only then is it signed and
//      broadcast. Rejecting it costs nothing.
//
// Splitting parse (model) from validation (code) is the point: the LLM is
// good at reading "send 10 USDC to 0x…", bad at guaranteeing the result is
// safe. Every cap and address check below is enforced in code, never in a
// prompt, so a jailbroken or confused model cannot move funds it shouldn't.

export const transferTools: Tool[] = [
  {
    name: "send_tokens",
    description:
      "Send crypto from a natural-language request. Extracts token, amount and recipient from the user's request, validates them, and files a PENDING transfer for the user to review in the chat. NOTHING is signed or sent until the user approves it with approve_transfer. Params: token (USDC|ETH), amount (number), recipient (0x address), source (agent_wallet|user_wallet, default agent_wallet), prompt (the original user request, for the audit trail).",
    parameters: {
      type: "object",
      properties: {
        token: {
          type: "string",
          enum: SUPPORTED_TOKENS,
          description: "Which token to send. Only USDC and ETH are supported.",
        },
        amount: {
          type: "number",
          description: "How much to send, e.g. 10 for '10 USDC'",
        },
        recipient: {
          type: "string",
          description: "Destination wallet address (0x...)",
        },
        source: {
          type: "string",
          enum: ["agent_wallet", "user_wallet"],
          description:
            "Which wallet funds it. 'agent_wallet' (default) signs server-side. 'user_wallet' means the user's own connected wallet signs in the browser.",
        },
        prompt: {
          type: "string",
          description: "The user's original request, recorded for the audit trail.",
        },
      },
      required: ["token", "amount", "recipient"],
    },
    run: async ({ token, amount, recipient, source, prompt }) => {
      const def = resolveToken(token);
      if (!def) {
        throw new Error(
          `Unsupported token "${token}". Supported: ${SUPPORTED_TOKENS.join(", ")}.`,
        );
      }
      const transfer = await createPendingTransfer({
        token,
        amount,
        recipient,
        source: source ?? "agent_wallet",
        prompt: prompt ?? "",
      });
      return {
        transferId: transfer.id,
        status: "pending_user_approval",
        token: transfer.token,
        amount: transfer.amount,
        recipient: transfer.recipient,
        source: transfer.source,
        perTransferCap: MAX_TRANSFER,
        dailyCap: MAX_DAILY_TRANSFER,
        message:
          "Transfer prepared but NOT sent. Show the user the details and ask them to approve; call approve_transfer only after they say yes.",
        nextStep:
          "Ask the user to confirm. On approval call approve_transfer with this transferId.",
      };
    },
  },
  {
    name: "approve_transfer",
    description:
      "Execute a pending transfer that the user has explicitly approved. Signs and broadcasts the on-chain transaction from the agent's wallet (Base Sepolia testnet). ONLY call this after the user has confirmed the transfer in the chat. Params: transfer_id.",
    parameters: {
      type: "object",
      properties: {
        transfer_id: {
          type: "string",
          description: "The id returned by send_tokens",
        },
      },
      required: ["transfer_id"],
    },
    run: async ({ transfer_id }) => {
      const pending = getTransfer(transfer_id);
      if (!pending) throw new Error(`No transfer with id ${transfer_id}.`);
      if (pending.status === "executed") {
        return {
          transferId: transfer_id,
          status: "executed",
          txHash: pending.txHash,
          note: "This transfer was already executed.",
        };
      }
      if (pending.status !== "pending") {
        throw new Error(
          `Transfer ${transfer_id} is ${pending.status} and cannot be approved.`,
        );
      }
      // A transfer the user asked to fund from THEIR wallet must be
      // signed by their browser extension. The agent's wallet may not
      // stand in for it — that would spend the agent's money without the
      // user's wallet ever authorizing anything.
      if (pending.source !== "agent_wallet") {
        return {
          transferId: transfer_id,
          status: pending.status,
          source: pending.source,
          note:
            "This transfer is funded by the user's own connected wallet, so it is signed in the browser, not by the agent. Ask the user to approve it in the chat review card — the browser wallet will sign it.",
        };
      }
      const result = await executeAgentTransfer(transfer_id);
      if (result.status === "failed") {
        return {
          transferId: transfer_id,
          status: "failed",
          reason: result.reason,
          note: "The transaction failed. Nothing was transferred.",
        };
      }
      return {
        transferId: transfer_id,
        status: "executed",
        txHash: result.txHash,
        token: result.token,
        amount: result.amount,
        recipient: result.recipient,
        explorer: `https://sepolia.basescan.org/tx/${result.txHash}`,
        note: "Transfer settled on Base Sepolia (testnet).",
      };
    },
  },
  {
    name: "reject_transfer",
    description:
      "Cancel a pending transfer the user declined. Nothing was signed, so this is always safe. Params: transfer_id, optional reason.",
    parameters: {
      type: "object",
      properties: {
        transfer_id: { type: "string", description: "The id returned by send_tokens" },
        reason: { type: "string", description: "Why it was declined" },
      },
      required: ["transfer_id"],
    },
    run: async ({ transfer_id, reason }) => {
      const row = await rejectTransfer(transfer_id, reason);
      return {
        transferId: row.id,
        status: row.status,
        note: "Transfer cancelled. Nothing was sent and no funds moved.",
      };
    },
  },
  {
    name: "list_transfers",
    description:
      "List the user's crypto transfers (pending, executed, rejected) with their ids, amounts, recipients and transaction hashes. Params: optional status filter.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "rejected", "executed", "failed"],
          description: "Optional status filter",
        },
      },
    },
    run: async ({ status }) => ({
      transfers: listTransfers(status),
      caps: { perTransfer: MAX_TRANSFER, daily: MAX_DAILY_TRANSFER },
      network: "Base Sepolia (testnet)",
    }),
  },
];

/** The on-chain sink for a provider's tips and x402 payTo (env override first). */
function getProviderPayTo(provider: string): `0x${string}` {
  const envSink = process.env.PROVIDER_PAY_TO_OVERRIDE as
    `0x${string}` | undefined;
  if (envSink) return envSink;
  const prov = getProviderWalletAddress();
  if (prov) return prov;
  const meta = PROVIDER_PATHS[provider];
  if (meta) {
    const registry = PROVIDERS.find((p) => p.slug === provider);
    if (registry) return registry.payTo;
  }
  throw new Error(`No payTo resolvable for provider ${provider}.`);
}

/** Query-string per provider job type. */
function buildParams(provider: string, job: string): string {
  if (provider === "capn") return `text=${encodeURIComponent(job)}`;
  return `location=${encodeURIComponent(job)}&request=${encodeURIComponent(job)}`;
}

// ─── WEEK 2 (ADVANCED) TOOLS: the deployed NFT contract ─────────────────
//
// The brief's advanced ask: a deployed smart contract the agent can call
// through its own tools, covering MINTING, BUYING and SELLING NFTs.
//
// The mint keeps the same two-phase shape as a transfer — `mint_nft` files a
// PENDING intent and the human authorizes it from the chat card — because a
// model is good at reading "mint an NFT called X" and bad at guessing what
// the user wanted the NFT to look like. The listing and buying tools are
// direct contract calls, capped in code.

export const nftTools: Tool[] = [
  {
    name: "mint_nft",
    description:
      "Prepare an NFT mint on the deployed UselessNFT contract (Base Sepolia testnet). Validates the name, description, recipient and traits, then files a PENDING mint — NOTHING is minted until the user reviews it in the chat card and presses Mint. Params: name, optional description, optional recipient (defaults to the agent's wallet), optional traits (array of {trait_type, value}), optional prompt (the user's original words, for the audit trail).",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The NFT's name, e.g. 'Sunset Withdrawn From Service'",
        },
        description: {
          type: "string",
          description: "What the NFT is, in one or two sentences",
        },
        recipient: {
          type: "string",
          description:
            "Who receives the token (0x address). Defaults to the agent's own wallet.",
        },
        traits: {
          type: "array",
          description: "Metadata attributes, e.g. [{trait_type: 'Uselessness', value: 'High'}]",
          items: {
            type: "object",
            properties: {
              trait_type: { type: "string" },
              value: { type: "string" },
            },
            required: ["trait_type", "value"],
          },
        },
        prompt: {
          type: "string",
          description: "The user's original request, recorded for the audit trail.",
        },
      },
      required: ["name"],
    },
    run: async ({ name, description, recipient, traits, prompt }) => {
      const mint = await createPendingMint({
        name,
        description,
        recipient,
        traits,
        prompt,
      });
      return {
        mintId: mint.id,
        status: "pending_user_approval",
        name: mint.name,
        description: mint.description,
        recipient: mint.recipient,
        traits: mint.traits,
        tokenUri: tokenUriFor(mint.id),
        contract: getNftContractAddress(),
        message:
          "Mint prepared but NOT minted. Show the user the mint card so they can upload an image, edit the name, description and metadata, then press Mint.",
        nextStep:
          "Ask the user to review the NFT details in the chat card. The contract call happens only when they press Mint.",
      };
    },
  },
  {
    name: "list_nfts",
    description:
      "List the NFTs on the UselessNFT contract (Base Sepolia testnet): token id, owner, metadata URI, price and whether it is for sale. Also returns the deployment status and the pending mints that are waiting for the user to approve.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      const status = nftStatus();
      if (!status.deployed) {
        return {
          ...status,
          nfts: [],
          pendingMints: listMints("pending"),
          note: "UselessNFT is not deployed on this chain yet, so there is nothing to list.",
        };
      }
      const nfts = await listOnChainNfts();
      return {
        ...status,
        nfts,
        pendingMints: listMints("pending"),
        minted: listMints("minted").map((m) => ({
          mintId: m.id,
          tokenId: m.tokenId,
          name: m.name,
          txHash: m.txHash,
        })),
      };
    },
  },
  {
    name: "get_nft",
    description:
      "Read one NFT from the UselessNFT contract: owner, metadata URI, price, listing state and the metadata document (name, description, image, traits) when the app has it. Params: token_id (number).",
    parameters: {
      type: "object",
      properties: {
        token_id: { type: "number", description: "The token id to read" },
      },
      required: ["token_id"],
    },
    run: async ({ token_id }) => {
      const nft = await readNft(Number(token_id));
      return { ...nft, contract: getNftContractAddress() };
    },
  },
  {
    name: "list_nft_for_sale",
    description:
      "Put one of the agent's own NFTs up for sale on the UselessNFT contract, priced in USDC. Refuses above the NFT price cap or if KILL_SWITCH=1. Returns the transaction hash. Params: token_id (number), price_usdc (number).",
    parameters: {
      type: "object",
      properties: {
        token_id: { type: "number", description: "The token id to list" },
        price_usdc: {
          type: "number",
          description: "The asking price in USDC, e.g. 0.05",
        },
      },
      required: ["token_id", "price_usdc"],
    },
    run: async ({ token_id, price_usdc }) => {
      const { txHash } = await listNftForSale(Number(token_id), Number(price_usdc));
      return {
        tokenId: Number(token_id),
        priceUsdc: Number(price_usdc),
        txHash,
        explorer: `https://sepolia.basescan.org/tx/${txHash}`,
        note: "Listed on the UselessNFT contract (Base Sepolia testnet).",
      };
    },
  },
  {
    name: "buy_nft",
    description:
      "Buy a listed NFT with the agent's own USDC wallet. Approves the contract for the exact price, then calls buy() — the token changes hands and the seller is paid on-chain. Refuses above the NFT price cap or if KILL_SWITCH=1. Params: token_id (number).",
    parameters: {
      type: "object",
      properties: {
        token_id: { type: "number", description: "The token id to buy" },
      },
      required: ["token_id"],
    },
    run: async ({ token_id }) => {
      const { txHash, priceUsdc } = await buyNft(Number(token_id));
      return {
        tokenId: Number(token_id),
        paidUsdc: Number(priceUsdc),
        txHash,
        explorer: `https://sepolia.basescan.org/tx/${txHash}`,
        note: "Bought on the UselessNFT contract with the agent's own USDC (Base Sepolia testnet).",
      };
    },
  },
];

/** The full tool surface the agent sees: free persona tools + judge/ledger + paid tools + transfers + nfts. */
export const tools: Tool[] = [
  ...coreTools,
  ...paidTools,
  ...transferTools,
  ...nftTools,
];

// ─── CAP-ENFORCEMENT TEST HOOKS (exposed for direct guardrail verification).
// These are NOT part of the Gemini-visible tool surface; they exist so the
// cap/kill-switch logic can be tested without needing Gemini to cooperate.
export const CAP_CONSTANTS = { MAX_PER_JOB, WEEKLY_CAP, CHAIN_ID };

export async function testBudgetGuardCommission(amount: number) {
  return budgetGuard("commission", amount);
}

export async function testBudgetGuardTip(amount: number) {
  return budgetGuard("tip", amount);
}

export async function testWeekSpend() {
  return weekSpend();
}

export async function testKillSwitchFrozen() {
  return process.env.KILL_SWITCH === "1";
}
