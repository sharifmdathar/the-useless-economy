/**
 * PROVIDER-ROUTE SHIM — previously this file called Gemini directly.
 *
 * Every persona/judge call now funnels through lib/llm.ts behind
 * LLM_PROVIDER, so the provider routes (x402 sellers under app/providers/*)
 * run on Groq or Gemini without edits. This file re-exports the adapter
 * under the names those routes already import.
 */
import { callLLM } from "./llm";
export {
  ACTIVE_PROVIDER,
  MODEL,
  PROVIDER_FELL_BACK,
  extractJson,
  withRetry,
} from "./llm";

/**
 * Persona call used by the provider routes, which pass (persona, prompt)
 * positionally. callLLM takes an options object, so this wraps it.
 */
export async function callGemini(
  persona: string,
  prompt: string,
): Promise<string> {
  return callLLM({ system: persona, prompt, role: "cheap" });
}
