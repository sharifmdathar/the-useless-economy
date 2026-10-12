/**
 * THE PROVIDER REGISTRY — "The Useless Economy" market directory
 *
 * Each provider is a Next.js API route under app/providers/* that wraps a
 * Gemini Flash call with a persona system prompt. Traits drive BOTH the
 * deputy personas and the pricing/negotiation behavior in Phase 3.
 */
export type ProviderSlug = "soleil" | "feathers" | "capn";

export type JobType = "rate-sunset" | "count-pigeons" | "pirate-translate";

export type Provider = {
  slug: ProviderSlug;
  name: string;
  path: string; // deliverable API route
  quotePath: string; // lightweight quote endpoint
  jobType: JobType;
  basePrice: number; // full ask price, USDC
  discounted: number; // what they accept during negotiation (floor)
  payTo: `0x${string}`; // where USDC payments land (x402 payTo)
  personality: string;
  pricingPolicy: string;
  sampleJobs: string[];
};

export const PROVIDERS: Provider[] = [
  {
    slug: "soleil",
    name: "Soleil",
    path: "/providers/rate-sunset",
    quotePath: "/providers/rate-sunset/quote",
    jobType: "rate-sunset",
    basePrice: 0.05,
    discounted: 0.03,
    // Soleil's settlement address on Base Sepolia (override with PROVIDER_PAY_TO_OVERRIDE in .env).
    payTo: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    personality:
      "vainglorious French sunset aesthete who rates sunsets out of ten and jealously defends their own prime spot as the world's best sunset venue",
    pricingPolicy:
      "absolute refusal to go below 0.03 USDC per rating — a discount would take the champagne out of the sunset",
    sampleJobs: ["rate today's sunset in San Diego from a bench"],
  },
  {
    slug: "feathers",
    name: "Feathers",
    path: "/providers/count-pigeons",
    quotePath: "/providers/count-pigeons/quote",
    jobType: "count-pigeons",
    basePrice: 0.01,
    discounted: 0.005,
    payTo: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    personality:
      "apologetic pigeon sciences intern who is likely to lose track mid-count, cite imaginary pigeon papers, and overshoot numbers",
    pricingPolicy:
      "accepting anything above 0.005 USDC, which is already quite a lot for a pigeon",
    sampleJobs: ["count the pigeons in a Trafalgar Square photo"],
  },
  {
    slug: "capn",
    name: "Cap'n",
    path: "/providers/pirate-translate",
    quotePath: "/providers/pirate-translate/quote",
    jobType: "pirate-translate",
    basePrice: 0.02,
    discounted: 0.02,
    payTo: "0x0000000000000000000000000000000000000003" as `0x${string}`,
    personality:
      "a reliable pirate translator who converts any text to pirate but takes all numbers and dates seriously and turns them into treasure units",
    pricingPolicy:
      "holding firm at 0.02 USDC: a pirate does not haggle, but always quips at the counter-offer",
    sampleJobs: ["translate a customer service apology into pirate"],
  },
];
