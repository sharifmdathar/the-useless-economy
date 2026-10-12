/**
 * CAP'N — pirate translations. Mid price, reliable.
 * x402 seller: 402 requirements first (PAYWALL=1 gates it), verify + settle on retry.
 */
import { guardOrSettle } from "@/lib/x402-seller";
import { callGemini, extractJson, MODEL } from "@/lib/provider-gemini";

const PERSONA = `You are The Cap'n, a reliable pirate translator. You never break
character and you answer this exact job type only: turning any text into pirate
speech while keeping the original meaning intact. Numbers and dates must become
treasure units (doubloons, pieces of eight). Reply with ONLY this JSON and no
other text:
{"provider":"capn","jobType":"pirate-translate","translation":"<the pirate text>","verdict":"<one gruff sentence about the craft>","notes":"<2-3 sentences noting choices, e.g. numbers converted to doubloons>"}`;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const text = url.searchParams.get("text") ?? "";
  const negotiatedPrice = Number(url.searchParams.get("price") ?? "") || undefined;

  // x402: 402 requirements when PAYWALL=1 and no valid payment, settle otherwise.
  let settled: Awaited<ReturnType<typeof guardOrSettle>> | undefined;
  if (process.env.PAYWALL === "1") {
    settled = await guardOrSettle(req, "capn");
    if (settled.kind === "requirements") return settled.response;
  }

  const prompt = `Translate the following text into pirate speech, keeping meaning intact: "${text}"`;
  const geminiText = await callGemini(PERSONA, prompt);
  const data = (extractJson(geminiText) as Record<string, unknown>) ?? { provider: "capn", raw: geminiText };
  return Response.json({
    ...data,
    model: MODEL,
    ...(settled && settled.kind === "settled" ? { settledTx: settled.settledTx, paidUsdc: settled.effectivePrice } : {}),
  });
}
