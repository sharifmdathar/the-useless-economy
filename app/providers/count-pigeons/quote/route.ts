/** Feathers' quote desk: what a pigeon census costs. */
import { PROVIDERS, type ProviderSlug } from "@/lib/providers";

const FEATHERS = PROVIDERS.find((p) => p.slug === ("feathers" satisfies ProviderSlug))!;

export function GET() {
  return Response.json({
    provider: FEATHERS.slug,
    name: FEATHERS.name,
    jobType: FEATHERS.jobType,
    price: FEATHERS.basePrice,
    counterFloor: FEATHERS.discounted,
    asset: "USDC",
    terms: FEATHERS.pricingPolicy,
    quip: "0.005 if you're nice. 0.01 if you want me to pretend I double-checked.",
  });
}
