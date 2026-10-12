/**
 * THE FOREMAN'S TOOLS — Week 2 build of "The Useless Economy".
 *
 * Pure TypeScript + Gemini, no crypto/viem/x402 yet (that lands in Week 3).
 * Six tools:
 *   rate_sunset / count_pigeons / pirate_translate — three distinct provider
 *     personas, each its own Gemini Flash call, input: subject/job, output: string.
 *   judge_deliverable — a SECOND, strict, independent Gemini call scoring 1-5.
 *   log_to_ledger — appends one JSON row to the append-only ledger.json.
 *   run_gig_economy — the workflow: same job to all 3 providers, judge + log
 *     all three, declare a winner.
 */
import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";

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

/**
 * One Gemini call per provider persona.
 * Kept small and single-purpose so each provider can be split into its own
 * HTTP service (Week 3) without touching the persona text.
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
 * The judge is deliberately a separate Gemini call with its own system prompt,
 * never the provider's voice. Falls back to a length heuristic without a key.
 */
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

// ─── 3. THE LEDGER ───

export type LedgerEntry = {
  ts: string; // ISO timestamp
  job: string;
  provider: string; // soleil | feathers | capn
  deliverable: string;
  score: number; // 1-5 from the judge
  feedback: string;
};

const LEDGER_PATH = path.join(process.cwd(), "ledger.json");

/** Append-only: read → push → write, serialized on a module-level queue
 * so concurrent Next.js dev requests cannot clobber ledger.json. */
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
    const row: LedgerEntry = { ...entry, ts: new Date().toISOString() };
    entries.push(row);
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2) + "\n");
    return entries;
  });
}

function readLedger(): LedgerEntry[] {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return [];
  }
}

// ─── 4. THE EXPORTED TOOL LIST (what Gemini can call) ───

export const tools: Tool[] = [
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
      },
      required: ["provider_name", "deliverable_text"],
    },
    run: async ({ provider_name, deliverable_text, job = "" }) => {
      const judgement = await judge(provider_name, deliverable_text);
      const ledger = await logToLedger({ job, provider: provider_name, deliverable: deliverable_text, ...judgement });
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
