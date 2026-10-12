/**
 * CAP'N — pirate translations. Mid price, reliable.
 *
 * Same shape as the others: free deliverable in Phase 1, 402-gated later.
 */
import { PROVIDERS, type ProviderSlug } from "@/lib/providers";
import { callGemini, extractJson, MODEL } from "@/lib/provider-gemini";

const CAPN = PROVIDERS.find((p) => p.slug === ("capn" satisfies ProviderSlug))!;
const FLOOR = CAPN.discounted;
const PERSONA = `You are The Cap'n, a ${CAPN.personality}. You never break character and
you answer this exact job type only: turning any text into pirate speech while
keeping the original meaning intact. Numbers and dates must become treasure
units (doubloons, pieces of eight). Reply with ONLY this JSON and no other text:
{"provider":"capn","jobType":"pirate-translate","translation":"<the pirate text>","verdict":"<one gruff sentence about the craft>","notes":"<2-3 sentences noting choices you made, e.g. converted numbers to doubloons>"}

Your pricing policy: ${CAPN.pricingPolicy}. A below-floor counter-offer gets a
theatrical scoff but zero discount.`;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const text = url.searchParams.get("text") ?? "";
  const paymentHeader = req.headers.get("X-PAYMENT");
  const negotiatedPrice = Number(url.searchParams.get("price") ?? CAPN.basePrice);

  // Phase 1: workstation runs free. Payment wall is dormant until PAYWALL=1
  // (Phase 3 flips this via .env) so the free economy stays testable.
  if (process.env.PAYWALL === "1" && paymentHeader === null && negotiatedPrice > 0) {
    return Response.json(
      { error: "Payment Required", price: CAPN.basePrice, asset: "USDC", payTo: "capn-placeholder" },
      { status: 402 },
    );
  }
  if (paymentHeader !== null && negotiatedPrice < FLOOR) {
    return Response.json(
      { error: "Payment below floor", floor: FLOOR },
      { status: 402 },
    );
  }

  const prompt = `Translate the following text into pirate speech, keeping meaning intact: "${text}"`;
  const geminiText = await callGemini(PERSONA, prompt);
  const data = (extractJson(geminiText) as Record<string, unknown>) ?? { provider: "capn", raw: geminiText };
  return Response.json({ ...data, model: MODEL, price: negotiatedPrice });
}
