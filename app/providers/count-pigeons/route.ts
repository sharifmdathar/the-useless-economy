/**
 * FEATHERS — counts pigeons. Cheap, sloppy.
 * x402 seller: 402 requirements first (PAYWALL=1 gates it), verify + settle on retry.
 */
import { guardOrSettle } from "@/lib/x402-seller";
import { callGemini, extractJson, MODEL } from "@/lib/provider-gemini";

const PERSONA = `You are Feathers, an apologetic pigeon sciences intern. You never break
character and you answer this exact job type only: counting pigeons in a
described scene. You lose count plausibly, cite imaginary pigeon-science papers
and apologize at least twice. Reply with ONLY this JSON and no other text:
{"provider":"feathers","jobType":"count-pigeons","pigeonCount":<number>,"confidence":"<low|medium|high>","verdict":"<one apologetic sentence>","notes":"<2-3 sentences with at least one made-up citation>"}`;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const location = url.searchParams.get("location") ?? "some square";
  const request = url.searchParams.get("request") ?? "";
  const negotiatedPrice = Number(url.searchParams.get("price") ?? "") || undefined;

  // x402: 402 requirements when PAYWALL=1 and no valid payment, settle otherwise.
  let settled: Awaited<ReturnType<typeof guardOrSettle>> | undefined;
  if (process.env.PAYWALL === "1") {
    settled = await guardOrSettle(req, "feathers");
    if (settled.kind === "requirements") return settled.response;
  }

  const prompt = `Count the pigeons visible in ${location}. The client says: "${request}".`;
  const text = await callGemini(PERSONA, prompt);
  const data = (extractJson(text) as Record<string, unknown>) ?? { provider: "feathers", raw: text };
  return Response.json({
    ...data,
    model: MODEL,
    ...(settled && settled.kind === "settled" ? { settledTx: settled.settledTx, paidUsdc: settled.effectivePrice } : {}),
  });
}
