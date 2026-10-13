/**
 * X402 SELLER HELPERS — shared by all three provider routes.
 *
 * A provider route calls `guardOrSettle(req, providerSlug)`:
 *   - no X-PAYMENT header    -> 402 with the x402 requirements (price/payTo/asset)
 *   - header present         -> verify + settle on-chain, return { payment, settledTx }
 *   - below persona floor    -> 402 refusal (the negotiation rule, in code)
 */
import {
  verifyPayment,
  settlePaymentFromHeader,
  USDC_ADDRESS,
  type X402PaymentBody,
} from "@/agent/wallet";
import { PROVIDERS, type ProviderSlug } from "./providers";

export function providerBySlug(slug: string) {
  const found = PROVIDERS.find((p) => p.slug === slug);
  if (!found) throw new Error(`Unknown provider ${slug}`);
  return found;
}

export type GuardResult =
  | { kind: "requirements"; response: Response }
  | {
      kind: "settled";
      payment: X402PaymentBody;
      settledTx: string;
      effectivePrice: number;
    };

export async function guardOrSettle(
  req: Request,
  slug: ProviderSlug,
  negotiatedPrice?: number,
): Promise<GuardResult> {
  const provider = providerBySlug(slug);
  const payTo = process.env.PROVIDER_PAY_TO_OVERRIDE
    ? (process.env.PROVIDER_PAY_TO_OVERRIDE as `0x${string}`)
    : provider.payTo;

  const header = req.headers.get("X-PAYMENT");
  if (!header) {
    // Advertise the x402 requirements. Facilitator URL included per the spec.
    return {
      kind: "requirements",
      response: Response.json(
        {
          error: "Payment Required",
          scheme: "eip3009",
          price: String(negotiatedPrice ?? provider.basePrice),
          asset: USDC_ADDRESS,
          payTo,
          facilitator: "https://x402.org/facilitator",
          resource: new URL(req.url).pathname,
        },
        { status: 402 },
      ),
    };
  }

  const payment = await verifyPayment(header);
  if (!payment) {
    return {
      kind: "requirements",
      response: Response.json(
        { error: "Invalid or expired X-PAYMENT authorization" },
        { status: 402 },
      ),
    };
  }

  // Persona floor: below the floor is a refusal even with a valid signature.
  const floor = provider.discounted;
  if (Number(payment.value) < floor * 10 ** 6) {
    return {
      kind: "requirements",
      response: Response.json(
        { error: "Payment below persona floor", floor },
        { status: 402 },
      ),
    };
  }

  let tx: string;
  try {
    ({ tx } = await settlePaymentFromHeader(header));
  } catch (err) {
    // Typical causes: settlement wallet has no ETH for gas, or the network is
    // unreachable. Return a clear error instead of a 500 crash.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      kind: "requirements",
      response: Response.json(
        { error: "Settlement failed", reason },
        { status: 502 },
      ),
    };
  }
  return {
    kind: "settled",
    payment,
    settledTx: tx,
    effectivePrice: Number(payment.value) / 10 ** 6,
  };
}
