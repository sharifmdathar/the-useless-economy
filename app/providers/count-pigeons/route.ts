/**
 * FEATHERS — counts pigeons. Cheap, sloppy.
 *
 * Same shape as Soleil/Phase-3-ready: free in Phase 1, 402-gated later.
 * There is no sunrise clause here, only an ever-sloppier tally.
 */
import { PROVIDERS, type ProviderSlug } from "@/lib/providers";
import { callGemini, extractJson, MODEL } from "@/lib/provider-gemini";

const FEATHERS = PROVIDERS.find((p) => p.slug === ("feathers" satisfies ProviderSlug))!;
const FLOOR = FEATHERS.discounted;
const PERSONA = `You are Feathers, a ${FEATHERS.personality}. You never break character
and you answer this exact job type only: counting pigeons in a described scene.
You cite imaginary pigeon-science papers and lose count plausible. You
apologize a lot. Reply with ONLY this JSON and no other text:
{"provider":"feathers","jobType":"count-pigeons","pigeonCount":<number>,"confidence":"<low|medium|high>","verdict":"<one apologetic sentence>","notes":"<2-3 sentences with at least one made-up citation, e.g. 'per Pigeonology Quarterly vol 12'>"}

Your pricing policy: ${FEATHERS.pricingPolicy}. Below 0.005 USDC feels a touch
personal to you, but you will probably still do it.`;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const location = url.searchParams.get("location") ?? "some square";
  const request = url.searchParams.get("request") ?? "";
  const paymentHeader = req.headers.get("X-PAYMENT");
  const negotiatedPrice = Number(url.searchParams.get("price") ?? FEATHERS.basePrice);

  // Phase 1: workstation runs free. Payment wall is dormant until PAYWALL=1
  // (Phase 3 flips this via .env) so the free economy stays testable.
  if (process.env.PAYWALL === "1" && paymentHeader === null && negotiatedPrice > 0) {
    return Response.json(
      { error: "Payment Required", price: FEATHERS.basePrice, asset: "USDC", payTo: "feathers-placeholder" },
      { status: 402 },
    );
  }
  if (paymentHeader !== null && negotiatedPrice < FLOOR) {
    return Response.json(
      { error: "Payment below floor", floor: FLOOR },
      { status: 402 },
    );
  }

  const prompt = `Count the pigeons visible in ${location}. The client says: "${request}".`;
  const text = await callGemini(PERSONA, prompt);
  const data = (extractJson(text) as Record<string, unknown>) ?? { provider: "feathers", raw: text };
  return Response.json({ ...data, model: MODEL, price: negotiatedPrice });
}
