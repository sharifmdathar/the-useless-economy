/**
 * THE JUDGE — a strict, separate Gemini Flash call for quality control.
 *
 * Deliberately NOT the manager's voice, not the provider's persona, and
 * not soft — the judge scores 1-5 from the deliverable text plus job type.
 * Falls back to a length/shape heuristic if GEMINI_API_KEY is absent.
 */
import { GoogleGenAI } from "@google/genai";
import { MODEL } from "./provider-gemini";

const JUDGE_SYSTEM = `You are a stern quality-assurance auditor for "The Useless
Economy", a marketplace for pointless gigs scored 1-5 by you, and only you.
Rubric, hold the line:
- 5: flawless for the job type, in character, follows every stated convention of the role.
- 4: correct and in character, small rough edges.
- 3: acceptable but bland or slightly off-spec.
- 2: sloppy: generic, missing required fields, breaks persona, or hedging.
- 1: broken: refuses the job, is empty, or loudly wrong about the task.

Judge only the deliverable. Do NOT reward length alone, do NOT reward flattery,
do NOT average two jobs into one score. Reply with ONLY this JSON:
{"score":<1-5>,"verdict":"<one cutting or pleased sentence>","notes":"<2-3 sentences citing specifics of the deliverable>"}`;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });

const GEMINI_RETRYABLE = new Set([
  "UNAVAILABLE",
  "RATE_LIMIT_EXCEEDED",
  "SERVICE_UNSPECIFIED",
  "DEADLINE_EXCEEDED",
]);

function isRetryableStatus(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // The @google/genai SDK throws an ApiError carrying the HTTP status
  // directly on the error object (err.status), e.g. { name: "ApiError", status: 503 }.
  if ("status" in err) {
    const s = (err as { status?: unknown }).status;
    if (s === 503 || s === 429) return true;
    if (typeof s === "string" && GEMINI_RETRYABLE.has(s)) return true;
  }

  // Some surfaces serialize/wrap the same failure under err.error.
  if ("error" in err) {
    const e = (err as { error?: unknown }).error;
    if (e && typeof e === "object") {
      if ("status" in e && typeof e.status === "string") {
        if (GEMINI_RETRYABLE.has(e.status as string)) return true;
      }
      if ("code" in e && typeof e.code === "number") {
        if (e.code === 503 || e.code === 429) return true;
      }
    }
  }

  return false;
}

async function geminiWithRetry(
  fn: () => Promise<{ text?: string }>,
): Promise<string> {
  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fn();
      return res.text ?? "";
    } catch (err) {
      lastErr = err;
      if (!isRetryableStatus(err)) throw err;
      if (attempt === maxAttempts) throw err;
      const backoff = Math.min(2 ** attempt * 1000, 20_000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/** Heuristic fallback when we can't call Gemini (no API key). */
function heuristicScore(deliverable: string) {
  const trimmed = deliverable.trim();
  const len = trimmed.length;
  const score = len < 60 ? 2 : len < 200 ? 3 : len < 700 ? 4 : 5;
  return {
    score,
    verdict: score >= 4 ? "Substantial and orderly." : "Too thin to trust.",
    notes: "Scored by the length heuristic (no GEMINI_API_KEY present).",
  };
}

export async function judgeDeliverable(jobType: string, deliverable: string) {
  if (!process.env.GEMINI_API_KEY) return heuristicScore(deliverable);
  const prompt = `Job type: ${jobType}
Deliverable (may be JSON or plain text, judge both):
${deliverable}`;
  const text = await geminiWithRetry(async () =>
    ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { systemInstruction: JUDGE_SYSTEM },
    }),
  );
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
    const score = Math.round(Number(parsed.score));
    if (score >= 1 && score <= 5) {
      return {
        score,
        verdict: String(parsed.verdict ?? ""),
        notes: String(parsed.notes ?? ""),
      };
    }
  } catch {
    // fall through to heuristic
  }
  return heuristicScore(deliverable);
}
