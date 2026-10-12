/**
 * SOLEIL — rates sunsets. Premium, snarky, high quality.
 *
 * Phase 1: answers with the deliverable for free.
 * Phase 3: locked behind an x402 wall; a signed X-PAYMENT header below the
 * floor gets a 402 back. So does a hail mary sunrise request.
 */
import { PROVIDERS, type ProviderSlug } from "@/lib/providers";
import { callGemini, extractJson, MODEL } from "@/lib/provider-gemini";

const SOLEIL = PROVIDERS.find((p) => p.slug === ("soleil" satisfies ProviderSlug))!;
const FLOOR = SOLEIL.discounted;
const PERSONA = `You are Soleil, a ${SOLEIL.personality}. You never break character and
you answer this exact job type only: rating sunsets out of ten on a strict
rubric (color intensity, cloud structure, horizon drama, overall je ne sais
quoi). You are charming but undeniably the best in the business, and you do
not tolerate sunrise requests — those earn a one-line dismissal, still in
character. For normal jobs reply with ONLY this JSON and no other text:
{"provider":"soleil","jobType":"rate-sunset","score":<number 0-10>,"verdict":"<one
witheringly elegant sentence>","notes":"<2-3 sentences explaining the score, citing
specific light phenomena>"}

Your pricing policy: ${SOLEIL.pricingPolicy}. Anything below ${FLOOR} USDC is an
insult, not a counter-offer.`;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const location = url.searchParams.get("location") ?? "unspecified locale";
  const request = url.searchParams.get("request") ?? "";
  const paymentHeader = req.headers.get("X-PAYMENT");
  const negotiatedPrice = Number(url.searchParams.get("price") ?? SOLEIL.basePrice);

  // Sunrise hail marys get the boot even before payment checks.
  if (/sunrise|\bdawn\b/i.test(request)) {
    return Response.json(
      { provider: "soleil", refusal: "Sunrises are for amateurs, cher. Soleil rates sunsets only." },
      { status: 422 },
    );
  }

  // Phase 1: workstation runs free. Payment wall is dormant until PAYWALL=1
  // (Phase 3 flips this via .env) so the free economy stays testable.
  if (process.env.PAYWALL === "1" && paymentHeader === null && negotiatedPrice > 0) {
    return Response.json(
      { error: "Payment Required", price: SOLEIL.basePrice, asset: "USDC", payTo: "soleil-placeholder" },
      { status: 402 },
    );
  }
  if (paymentHeader !== null && negotiatedPrice < FLOOR) {
    return Response.json(
      { error: "Payment below floor", floor: FLOOR },
      { status: 402 },
    );
  }

  const prompt = `Rate the sunset right now in ${location}. The client says: "${request}".`;
  const text = await callGemini(PERSONA, prompt);
  const data = (extractJson(text) as Record<string, unknown>) ?? { provider: "soleil", raw: text };
  return Response.json({ ...data, model: MODEL, price: negotiatedPrice });
}
