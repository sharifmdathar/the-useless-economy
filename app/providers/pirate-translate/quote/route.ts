/** Cap'n's quote desk: what a pirate translation costs. */
import { PROVIDERS, type ProviderSlug } from "@/lib/providers";

const CAPN = PROVIDERS.find((p) => p.slug === ("capn" satisfies ProviderSlug))!;

export function GET() {
  return Response.json({
    provider: CAPN.slug,
    name: CAPN.name,
    jobType: CAPN.jobType,
    price: CAPN.basePrice,
    counterFloor: CAPN.discounted,
    asset: "USDC",
    terms: CAPN.pricingPolicy,
    quip: "Two hundredths of a doubloon. The price of honor, matey. Not negotiable.",
  });
}
