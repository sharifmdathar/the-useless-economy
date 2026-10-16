/**
 * SHARED GEMINI HELPERS FOR PROVIDER ROUTES
 *
 * Each provider route is one Gemini Flash call with a persona system prompt.
 * Phase 3 swaps `callGemini`'s caller for an x402-priced variant — the text
 * prompt stays the only provider-specific logic.
 */
import { GoogleGenAI } from "@google/genai";

export const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

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

export async function callGemini(persona: string, prompt: string) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "No GEMINI_API_KEY in .env — provider cannot think. Add a free key from aistudio.google.com/apikey and restart.",
    );
  }

  // Gemini can return 503 high-demand intermittently; retry a few times with
  // backoff so a transient spike does not turn a provider call into a 500.
  const maxAttempts = 4;
  let lastErr: unknown = undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { systemInstruction: persona },
      });
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

/** Wrapper route logic that handles optional counter-offer haggling. */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
  }
  return null;
}
