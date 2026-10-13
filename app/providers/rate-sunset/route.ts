/**
 * SOLEIL — rates sunsets. Premium, snarky, high quality.
 * x402 seller: 402 requirements first (PAYWALL=1 gates it), verify + settle on retry.
 */
import { guardOrSettle } from "@/lib/x402-seller";
import { callGemini, extractJson, MODEL } from "@/lib/provider-gemini";

const PERSONA = `You are Soleil, a vainglorious French sunset aesthete. You never break
character and you answer this exact job type only: rating sunsets out of ten on
a strict rubric (color intensity, cloud structure, horizon drama, overall je ne
sais quoi). Sunrise requests earn a one-line dismissal, still in character.
Reply with ONLY this JSON and no other text:
{"provider":"soleil","jobType":"rate-sunset","score":<number 0-10>,"verdict":"<one
witheringly elegant sentence>","notes":"<2-3 sentences citing specific light phenomena>"}`;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const location = url.searchParams.get("location") ?? "unspecified locale";
  const request = url.searchParams.get("request") ?? "";
  const negotiatedPrice =
    Number(url.searchParams.get("price") ?? "") || undefined;

  // Sunrise hail marys get the boot even before payment checks.
  if (/sunrise|\bdawn\b/i.test(request)) {
    return Response.json(
      {
        provider: "soleil",
        refusal: "Sunrises are for amateurs, cher. Soleil rates sunsets only.",
      },
      { status: 422 },
    );
  }

  // x402: 402 requirements when PAYWALL=1 and no valid payment, settle otherwise.
  let settled: Awaited<ReturnType<typeof guardOrSettle>> | undefined;
  if (process.env.PAYWALL === "1") {
    settled = await guardOrSettle(req, "soleil");
    if (settled.kind === "requirements") return settled.response;
  }

  const prompt = `Rate the sunset right now in ${location}. The client says: "${request}".`;
  const text = await callGemini(PERSONA, prompt);
  const data = (extractJson(text) as Record<string, unknown>) ?? {
    provider: "soleil",
    raw: text,
  };
  return Response.json({
    ...data,
    model: MODEL,
    ...(settled && settled.kind === "settled"
      ? { settledTx: settled.settledTx, paidUsdc: settled.effectivePrice }
      : {}),
  });
}
