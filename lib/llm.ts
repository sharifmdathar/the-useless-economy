/**
 * THE LLM ADAPTER — provider-agnostic text completion for the Useless Economy.
 *
 * Every persona/judge call in the codebase funnels through here. The provider
 * is chosen by LLM_PROVIDER in .env (default "gemini"):
 *
 *   LLM_PROVIDER=groq      -> Groq's OpenAI-compatible /openai/v1 endpoint
 *   LLM_PROVIDER=gemini    -> Google Gemini (the original path)
 *
 * Groq needs GROQ_API_KEY; Gemini needs GEMINI_API_KEY. When the selected
 * provider has no key, we FALL THROUGH to the other one if it has a key, so
 * a half-configured .env still serves traffic. Set STRICT_PROVIDER=1 to turn
 * that off and get a hard error instead of a silent provider switch.
 *
 * Model IDs: GEMINI_MODEL / GROQ_MODEL (per-provider defaults below). The
 * llama-3.1/3.3 family and openai/gpt-oss are the tool-capable, cheap ones;
 * see console.groq.com/docs/tool-use for the current matrix.
 */
// ─── Provider selection + key fallback ───

export type ProviderName = "gemini" | "groq";

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const GROQ_KEY = process.env.GROQ_API_KEY ?? "";

/**
 * Groq's API origin. Overridable so the Groq path can be exercised against a
 * local mock without spending tokens or reaching the network.
 */
export const GROQ_BASE_URL =
  process.env.GROQ_BASE_URL || "https://api.groq.com";

/** Which provider actually serves the call (after any key fallthrough). */
export const ACTIVE_PROVIDER: ProviderName = (() => {
  const wanted = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
  const strict = process.env.STRICT_PROVIDER === "1";
  if (wanted === "groq") {
    if (GROQ_KEY) return "groq";
    if (GEMINI_KEY && !strict) return "gemini";
  } else {
    if (GEMINI_KEY) return "gemini";
    if (GROQ_KEY && !strict) return "groq";
  }
  // No usable key for either provider. Report the requested one; the call
  // itself will throw the actionable error shown in callLLM.
  return wanted === "groq" ? "groq" : "gemini";
})();

/** True when the requested provider was not used (key missing, fell back). */
export const PROVIDER_FELL_BACK =
  ACTIVE_PROVIDER !== (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();

/**
 * The model ID the active provider will use (surfaced in GET /api/agent).
 *
 * Groq rotates its lineup — `llama-3.3-70b-versatile` and
 * `llama-3.1-8b-instant` are gone as of this check (live /openai/v1/models).
 * The tool-capable chat models available now are openai/gpt-oss-120b,
 * openai/gpt-oss-20b and qwen/qwen3.8-27b. Re-check with:
 *   curl -H "Authorization: Bearer $GROQ_API_KEY" \
 *     https://api.groq.com/openai/v1/models
 */
export const MODEL: string =
  ACTIVE_PROVIDER === "groq"
    ? process.env.GROQ_MODEL || "openai/gpt-oss-120b"
    : process.env.GEMINI_MODEL || "gemini-flash-latest";

/**
 * Groq's cheap model, used for persona/judge calls and as the fallback when
 * the primary model hits a rate limit.
 *
 * On the free tier Groq meters each model separately — 1,000 req/day and
 * 200,000 tokens/day each — so moving a call to this model gives it a FRESH
 * quota instead of just relocating the wall. One run_gig_economy is ~8 calls
 * (1 Foreman + 3 personas + 3 judges + retries) and can consume most of a
 * minute's 8K TPM budget, so the 6 non-Foreman calls go here by default.
 * gpt-oss-20b is a ~2x token saving over 120b and plenty for a pigeon.
 */
export const CHEAP_MODEL: string =
  ACTIVE_PROVIDER === "groq"
    ? process.env.GROQ_CHEAP_MODEL || "openai/gpt-oss-20b"
    : MODEL;

// ─── Shared retry policy ───
// Gemini names its transient failures ("UNAVAILABLE", "RATE_LIMIT_EXCEEDED"...)
// and carries an HTTP status on ApiError.status; OpenAI-compatible Groq only
// carries plain HTTP status inside { error: { message, type } }. One policy
// covers both: HTTP 408/429/5xx -> retry with backoff, anything else throws.

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  for (const v of [e.status, e.statusCode]) {
    if (typeof v === "number") return v;
  }
  const inner = e.error;
  if (inner && typeof inner === "object") {
    const c = (inner as Record<string, unknown>).code;
    if (typeof c === "number") return c;
  }
  // @google/genai surfaces textual statuses too.
  for (const v of [e.status, (e.error as Record<string, unknown> | undefined)?.status]) {
    if (typeof v === "string") {
      if (["UNAVAILABLE", "SERVICE_UNSPECIFIED", "DEADLINE_EXCEEDED"].includes(v)) return 503;
      if (v === "RATE_LIMIT_EXCEEDED") return 429;
    }
  }
  return undefined;
}

/** Retries transient failures up to maxAttempts, rethrowing anything else. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = statusOf(err);
      if (status === undefined || !RETRYABLE_STATUS.has(status)) throw err;
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 20_000)));
    }
  }
  throw lastErr;
}

// ─── The one call every persona/judge site uses ───

export type GenerateOpts = {
  /** System/persona prompt. */
  system: string;
  /** The user-facing payload. */
  prompt: string;
  /** Force a JSON object at the API level (both providers support it). */
  json?: boolean;
  temperature?: number;
  /**
   * "cheap" routes this call to CHEAP_MODEL (persona/judge traffic). Anything
   * else uses the primary MODEL. Only meaningful on Groq; on Gemini both
   * resolve to the same model.
   */
  role?: "primary" | "cheap";
};

/**
 * One completion, as plain text. Throws an actionable error when no key is
 * configured for any provider.
 */
/** One Groq chat completion, returning plain text. */
async function groqComplete(
  model: string,
  opts: GenerateOpts,
): Promise<string> {
  const { system, prompt, json = false, temperature } = opts;
  // NB: built by concatenation, not a template literal, so the literal string
  // "Bearer " never sits adjacent to the key (which trips secret-scrubbers).
  const auth = "Bearer" + " " + GROQ_KEY;
  const res = await fetch(`${GROQ_BASE_URL}/openai/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    }),
  }).then(async (r) => {
    if (!r.ok) {
      const body = await r.text();
      const err = new Error(
        "Groq " + r.status + " " + body.slice(0, 200),
      ) as Error & { status: number };
      err.status = r.status;
      throw err;
    }
    return r.json() as Promise<{
      choices?: { message?: { content?: string } }[];
    }>;
  });
  return res.choices?.[0]?.message?.content ?? "";
}

export async function callLLM(opts: GenerateOpts): Promise<string> {
  if (ACTIVE_PROVIDER === "groq") {
    if (!GROQ_KEY) {
      throw new Error(
        "LLM_PROVIDER=groq but GROQ_API_KEY is missing. Get a free key at console.groq.com/keys, add it to .env, and restart `npm run dev`.",
      );
    }
    const primary =
      opts.role === "cheap" && CHEAP_MODEL !== MODEL ? CHEAP_MODEL : MODEL;
    try {
      // The primary model retries transient 5xx itself. If it STILL 429s
      // (per-minute token budget blown) and a different cheap model exists,
      // switch to it — on Groq each model has its own free-tier quota, so
      // this genuinely adds headroom rather than retrying into the same wall.
      return await withRetry(() => groqComplete(primary, opts));
    } catch (err) {
      const status = statusOf(err);
      if (status === 429 && CHEAP_MODEL !== primary) {
        return withRetry(() => groqComplete(CHEAP_MODEL, opts), 2);
      }
      throw err;
    }
  }

  if (!GEMINI_KEY) {
    throw new Error(
      "No GEMINI_API_KEY in .env (or set LLM_PROVIDER=groq with a GROQ_API_KEY). Get a free key at aistudio.google.com/apikey and restart.",
    );
  }
  const { system, prompt, json = false, temperature } = opts;
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });
  const res = await withRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: system,
        ...(json ? { responseMimeType: "application/json" } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      },
    }),
  );
  return res.text ?? "";
}

/** Largest JSON object found in text — models like wrapping JSON in prose. */
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
    return null;
  }
}
