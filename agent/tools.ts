/**
 * THE FOREMAN'S TOOLS — Week 3: the market now has real money.
 *
 * Providers are x402 sellers (EIP-3009 USDC on Base Sepolia, testnet ONLY).
 * commission_job pays via payAndFetch; tip_provider sends a plain USDC transfer
 * from the agent wallet; hard caps (0.05/job, 1/week) and KILL_SWITCH are
 * enforced HERE, in code, so the LLM cannot spend past them.
 */
import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import {
  createWallet,
  createProviderWallet,
  getWalletAddress,
  getWalletBalance,
  getUsdcBalance,
  getProviderWalletAddress,
  payAndFetch,
  USDC_ADDRESS,
} from "./wallet";
import { createPublicClient, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema describing the inputs. */
  parameters: object;
  /** The code that runs when the agent calls this tool. */
  run: (args: any, ctx: { baseUrl: string }) => Promise<unknown>;
};

export const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Week 3 constants (caps live here, not in prompts) ───
const MAX_PER_JOB = 0.05; // USDC hard cap per job
const WEEKLY_CAP = 1; // USDC hard cap per rolling 7 days

/** Rolling 7-day spend from ledger.json (paid + tips). */
function weekSpend(): number {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    const rows = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) as { ts: string; paidAmount?: number; tipUsdc?: number }[];
    return rows
      .filter((r) => new Date(r.ts).getTime() >= cutoff)
      .reduce((s, r) => s + (r.paidAmount ?? 0) + (r.tipUsdc ?? 0), 0);
  } catch {
    return 0;
  }
}

function budgetGuard(kind: "commission" | "tip", amount: number) {
  if (process.env.KILL_SWITCH === "1") throw new Error("KILL_SWITCH is set — the economy is frozen. No payments this run.");
  if (amount > MAX_PER_JOB) throw new Error(`${amount} USDC exceeds the ${MAX_PER_JOB} per-job cap. Job refused.`);
  const spent = weekSpend();
  if (spent + amount > WEEKLY_CAP) {
    throw new Error(`Weekly budget of ${WEEKLY_CAP} USDC would be breached (spent ${spent.toFixed(4)} + ${amount}). Refusing.`);
  }
}

// Week-3 provider registry: the API routes under app/providers/* are the x402 sellers.
const PROVIDER_PATHS: Record<string, { path: string; jobType: string; floor: number; ask: number }> = {
  soleil: { path: "/providers/rate-sunset", jobType: "rate-sunset", floor: 0.03, ask: 0.05 },
  feathers: { path: "/providers/count-pigeons", jobType: "count-pigeons", floor: 0.005, ask: 0.01 },
  capn: { path: "/providers/pirate-translate", jobType: "pirate-translate", floor: 0.02, ask: 0.02 },
};

/**
 * One Gemini call per provider persona (kept for the judge and for
 * non-HTTP fallback persona calls).
 */
async function callProvider(persona: string, prompt: string): Promise<string> {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { systemInstruction: persona },
  });
  return res.text ?? "";
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
        subject: { type: "string", description: "What sunset to rate, e.g. 'sunset over Lisbon tonight'" },
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
        subject: { type: "string", description: "What pigeon scene to count, e.g. 'pigeons at Trafalgar Square'" },
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
        subject: { type: "string", description: "The text to translate into pirate speech" },
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
 */
export type LedgerEntry = {
  ts: string;
  job: string;
  provider: string;
  deliverable: string;
  score: number; // 1-5 from the judge
  feedback: string;
  quotedPrice?: number; // provider's asking price
  paidAmount?: number; // what actually settled
  txHash?: string; // x402 settlement tx or tip transfer tx
  tipUsdc?: number; // gratuity on top
};

const LEDGER_PATH = path.join(process.cwd(), "ledger.json");

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => T): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export async function logToLedger(entry: Omit<LedgerEntry, "ts">): Promise<LedgerEntry[]> {
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

/** Add a tip (and optionally its transfer txHash) to a provider's most recent PAID row. */
export async function applyTip(provider: string, tipUsdc: number, txHash?: string): Promise<LedgerEntry | null> {
  return serialized(() => {
    let entries: LedgerEntry[] = [];
    try {
      entries = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    } catch {
      return null;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const row = entries[i];
      if (row.provider === provider && (row.paidAmount ?? 0) > 0) {
        row.tipUsdc = (row.tipUsdc ?? 0) + tipUsdc;
        if (txHash) row.txHash = txHash;
        fs.writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2) + "\n");
        return row;
      }
    }
    return null;
  });
}

function readLedger(): LedgerEntry[] {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return [];
  }
}
async function judge(providerName: string, deliverableText: string): Promise<Judgement> {
  const prompt = `Provider: ${providerName}
Deliverable to judge:
${deliverableText}`;
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { systemInstruction: JUDGE_SYSTEM },
  });
  const text = res.text ?? "";
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
    const score = Math.round(Number(parsed.score));
    if (score >= 1 && score <= 5) {
      return { score, feedback: String(parsed.feedback ?? "") };
    }
  } catch {
    // fall through to heuristic
  }
  const byLength = deliverableText.trim().length < 60 ? 2 : 4;
  return { score: byLength, feedback: "Scored by fallback heuristic (judge JSON unparseable)." };
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
        provider_name: { type: "string", enum: ["soleil", "feathers", "capn"], description: "Which provider made the deliverable" },
        deliverable_text: { type: "string", description: "The exact deliverable text to judge" },
        job: { type: "string", description: "The original job/subject, for the ledger row" },
        quotedPrice: { type: "number", description: "Provider's asking price in USDC (0 if free run)" },
        paidAmount: { type: "number", description: "What actually settled in USDC (0 if free run)" },
        txHash: { type: "string", description: "x402 settlement tx hash, if paid" },
      },
      required: ["provider_name", "deliverable_text"],
    },
    run: async ({ provider_name, deliverable_text, job = "", quotedPrice = 0, paidAmount = 0, txHash }) => {
      const judgement = await judge(provider_name, deliverable_text);
      const ledger = await logToLedger({
        job,
        provider: provider_name,
        deliverable: deliverable_text,
        ...judgement,
        quotedPrice,
        paidAmount,
        ...(txHash ? { txHash } : {}),
        tipUsdc: 0,
      });
      return { provider: provider_name, ...judgement, ledgerRows: ledger.length };
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
      const ledger = await logToLedger({ job, provider, deliverable, score: Math.round(score), feedback });
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
        job: { type: "string", description: "The useless job, e.g. 'a golden sunset over the Tagus, Lisbon'" },
      },
      required: ["job"],
    },
    run: async ({ job }) => {
      // 1. Commission all three providers (sequential to keep dev free-tier happy).
      const deliverables: Record<string, string> = {
        soleil: await callProvider(SOLEIL_PERSONA, `Rate this sunset, in character: ${job}`),
        feathers: await callProvider(FEATHERS_PERSONA, `Count the pigeons in this scene, in character: ${job}`),
        capn: await callProvider(CAPN_PERSONA, `Translate this text into pirate speech, in character: "${job}"`),
      };

      // 2. Judge each deliverable with the strict, independent prompt.
      const judgements: Record<string, Judgement> = {};
      for (const [provider, deliverable] of Object.entries(deliverables)) {
        judgements[provider] = await judge(provider, deliverable);
      }

      // 3. Log every row to the append-only ledger.
      let ledgerRows = 0;
      for (const [provider, deliverable] of Object.entries(deliverables)) {
        const ledger = await logToLedger({ job, provider, deliverable, ...judgements[provider] });
        ledgerRows = ledger.length;
      }

      // 4. Rank and summarize.
      const ranked = Object.entries(judgements).sort((a, b) => b[1].score - a[1].score);
      const [winner, winnerJudgement] = ranked[0];
      return {
        winner: { provider: winner, score: winnerJudgement.score, feedback: winnerJudgement.feedback },
        standings: ranked.map(([provider, j]) => ({ provider, score: j.score, feedback: j.feedback })),
        deliverables,
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
        job: { type: "string", description: "What to do, e.g. 'rate the sunset over the Tagus in Lisbon'" },
        counterOffer: { type: "number", description: "Optional manager counter-offer in USDC" },
      },
      required: ["provider", "job"],
    },
    run: async ({ provider, job, counterOffer }, { baseUrl }) => {
      const meta = PROVIDER_PATHS[provider];
      if (!meta) throw new Error(`Unknown provider ${provider}. Valid: soleil, feathers, capn`);
      if (process.env.KILL_SWITCH === "1") throw new Error("KILL_SWITCH is set — the economy is frozen.");
      if (counterOffer != null) {
        budgetGuard("commission", counterOffer);
        if (counterOffer < meta.floor) {
          return { provider, negotiated: false, outcome: "REJECTED", reason: `Your counter-offer ${counterOffer} USDC is below ${provider}'s floor of ${meta.floor}.` };
        }
        if (counterOffer >= meta.ask) {
          return { provider, negotiated: false, note: "Counter-offer at or above the ask — just pay the ask." };
        }
      }
      budgetGuard("commission", meta.ask);

      // Phase 1: ask price attempt; Phase 3 (PAYWALL=1): real 402 -> settle.
      const askUrl = `${baseUrl}${meta.path}?${buildParams(provider, job)}&price=${meta.ask}`;
      const first = await payAndFetch(askUrl, { maxPrice: MAX_PER_JOB });
      // Free-run mode (PAYWALL off): the first response is the deliverable itself.
      if ((first.payment as { status?: string } | undefined)?.status !== "settled" && !(first.payment as { httpStatus?: number } | undefined)?.httpStatus) {
        return { provider, job, negotiated: false, paid: 0, deliverable: first.data };
      }

      // PAYWALL on: if a counter-offer was accepted by the floors above, retry at lower price.
      if (counterOffer != null && counterOffer < meta.ask) {
        const counterUrl = `${baseUrl}${meta.path}?${buildParams(provider, job)}&price=${counterOffer}`;
        const second = await payAndFetch(counterUrl, { maxPrice: MAX_PER_JOB });
        if ((second.payment as { status?: string } | undefined)?.status === "settled") {
          return {
            provider,
            job,
            negotiated: true,
            counterOffer,
            paid: counterOffer,
            tx: (second.payment as { tx?: string }).tx,
            deliverable: second.data,
          };
        }
        return { provider, job, negotiated: false, outcome: "REJECTED", detail: second.payment };
      }

      // No counter: settle at the ask (payAndFetch already signed + retried).
      if ((first.payment as { status?: string } | undefined)?.status === "settled") {
        return {
          provider,
          job,
          negotiated: false,
          paid: meta.ask,
          tx: (first.payment as { tx?: string }).tx,
          deliverable: first.data,
        };
      }
      return { provider, job, outcome: "REJECTED", detail: first.payment };
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
      if (!getWalletAddress()) throw new Error("No agent wallet yet — create one first.");
      budgetGuard("tip", amountUsdc);
      if (amountUsdc <= 0) throw new Error("Tip must be positive.");

      const envSink = process.env.PROVIDER_PAY_TO_OVERRIDE as `0x${string}` | undefined;
      const to = envSink ?? getProviderWalletAddress();
      if (!to) throw new Error("No provider wallet to tip. PROVIDER_PAY_TO_OVERRIDE or createProviderWallet() first.");

      const { privateKeyToAccount } = await import("viem/accounts");
      const { createWalletClient, http } = await import("viem");
      const key = process.env.WALLET_PRIVATE_KEY
        ? (process.env.WALLET_PRIVATE_KEY.trim() as `0x${string}`)
        : ((JSON.parse(fs.readFileSync(path.join(process.cwd(), ".agent-wallet.json"), "utf8")) as { privateKey: `0x${string}` }).privateKey.trim() as `0x${string}`);
      // Never log the key — it is only used to sign locally.
      const account = privateKeyToAccount(key);
      const client = createWalletClient({ account, chain: baseSepolia, transport: http() });
      const tx = await client.writeContract({
        address: USDC_ADDRESS,
        abi: [
          {
            name: "transfer",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
            ],
            outputs: [],
          },
        ] as const,
        functionName: "transfer",
        args: [to, BigInt(Math.round(amountUsdc * 10 ** 6))],
      });

      const row = await applyTip(provider, amountUsdc, tx);
      return {
        provider,
        tipped: amountUsdc,
        to,
        txHash: tx,
        ledgerRow: row,
        note: "On-chain USDC transfer submitted on Base Sepolia (testnet).",
      };
    },
  },

  {
    name: "set_provider_status",
    description:
      "Blacklist or re-activate a provider after bad work. Blacklisted providers are refused by commission. Params: provider (soleil|feathers|capn), status (active|blacklisted).",
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["soleil", "feathers", "capn"] },
        status: { type: "string", enum: ["active", "blacklisted"] },
      },
      required: ["provider", "status"],
    },
    run: async ({ provider, status }) => {
      const file = path.join(process.cwd(), ".provider-status.json");
      let statuses: Record<string, string> = {};
      try {
        statuses = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        // first write
      }
      statuses[provider] = status;
      fs.writeFileSync(file, JSON.stringify(statuses, null, 2) + "\n");
      return { provider, status };
    },
  },

  {
    name: "read_ledger",
    description: "Read the full ledger.json (append-only): every commission, score, tip in the economy. Also returns weekly spend.",
    parameters: { type: "object", properties: {} },
    run: async () => ({ entries: readLedger(), weeklySpend: weekSpend() }),
  },

  {
    name: "generate_report",
    description: "Write the weekly 'State of the Useless Economy' report to report.md (totals, avg price, leaderboard, incidents) and return its path.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      const entries = readLedger();
      const judged = entries.filter((e) => typeof e.score === "number");
      const totalSpend = entries.reduce((s, e) => s + (e.paidAmount ?? 0) + (e.tipUsdc ?? 0), 0);
      const perProvider = new Map<string, { jobs: number; spend: number; scoreSum: number; tips: number }>();
      for (const e of judged) {
        const row = perProvider.get(e.provider) ?? { jobs: 0, spend: 0, scoreSum: 0, tips: 0 };
        row.jobs += 1;
        row.spend += (e.paidAmount ?? 0) + (e.tipUsdc ?? 0);
        row.scoreSum += e.score;
        row.tips += e.tipUsdc ?? 0;
        perProvider.set(e.provider, row);
      }
      const leaderboard = [...perProvider.entries()]
        .sort((a, b) => b[1].scoreSum / b[1].jobs - a[1].scoreSum / a[1].jobs)
        .map(([provider, r]) => ({ provider, avgScore: r.scoreSum / r.jobs, jobs: r.jobs, spend: r.spend, tips: r.tips }));
      const incidents = judged
        .filter((e) => e.score <= 2)
        .map((e) => ({ ts: e.ts, provider: e.provider, score: e.score, feedback: e.feedback }));
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
          ...leaderboard.map((l) => `| ${l.provider} | ${l.jobs} | ${l.avgScore.toFixed(1)} | ${l.spend.toFixed(4)} | ${l.tips.toFixed(4)} |`),
          "",
          "## Incidents (score <= 2)",
          "",
          ...(incidents.length ? incidents.map((i) => `- ${i.ts} ${i.provider}: ${i.score}/5 — ${i.feedback}`) : ["- none"]),
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
    description: "On-chain USDC balances (testnet) for the settlement/provider wallet and the agent wallet — proves payments arrived.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      const prov = getProviderWalletAddress();
      const agent = getWalletAddress();
      const balances: Record<string, string> = {};
      if (prov) balances.provider = await getUsdcBalance(prov);
      if (agent) balances.agent = await getUsdcBalance(agent as `0x${string}`);
      return { addresses: { provider: prov, agent }, usdcBalances: balances, network: "Base Sepolia (testnet)" };
    },
  },

  {
    name: "get_my_wallet",
    description: "Get the agent's own wallet address, ETH and USDC balances on Base Sepolia (testnet). Creates nothing.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      if (!getWalletAddress()) throw new Error("No wallet yet. Ask the user to click 'Create wallet' in the UI first.");
      return {
        address: getWalletAddress(),
        eth: await getWalletBalance(),
        usdc: await getUsdcBalance(getWalletAddress() as `0x${string}`),
        network: "Base Sepolia (testnet)",
      };
    },
  },
];

/** Query-string per provider job type. */
function buildParams(provider: string, job: string): string {
  if (provider === "capn") return `text=${encodeURIComponent(job)}`;
  return `location=${encodeURIComponent(job)}&request=${encodeURIComponent(job)}`;
}

/** The full tool surface the agent sees: free persona tools + judge/ledger + paid tools. */
export const tools: Tool[] = [...coreTools, ...paidTools];
