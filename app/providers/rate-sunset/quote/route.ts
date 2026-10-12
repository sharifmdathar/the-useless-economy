/** Soleil's quote desk: what a sunset rating costs. */
import { PROVIDERS, type ProviderSlug } from "@/lib/providers";

const SOLEIL = PROVIDERS.find((p) => p.slug === ("soleil" satisfies ProviderSlug))!;

export function GET() {
  return Response.json({
    provider: SOLEIL.slug,
    name: SOLEIL.name,
    jobType: SOLEIL.jobType,
    price: SOLEIL.basePrice,
    counterFloor: SOLEIL.discounted,
    asset: "USDC",
    terms: SOLEIL.pricingPolicy,
    quip: "For that price, cher, I shall pretend the smog is artistic.",
  });
}
