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

export async function callGemini(persona: string, prompt: string) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "No GEMINI_API_KEY in .env — provider cannot think. Add a free key from aistudio.google.com/apikey and restart.",
    );
  }
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { systemInstruction: persona },
  });
  return res.text ?? "";
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
