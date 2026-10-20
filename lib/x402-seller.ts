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
  getProviderWalletAddress,
  USDC_ADDRESS,
  type X402PaymentBody,
} from "@/agent/wallet";
import { PROVIDERS, type ProviderSlug } from "./providers";
import { isRelayerCollision } from "./facilitator-retry";

export function providerBySlug(slug: string) {
  const found = PROVIDERS.find((p) => p.slug === slug);
  if (!found) throw new Error(`Unknown provider ${slug}`);
  return found;
}

/**
 * Where a provider's USDC actually lands.
 *
 * Order: explicit env override -> the funded provider wallet -> the registry
 * address. The registry addresses are PLACEHOLDERS (0x...01/02/03) that
 * nobody controls, so paying them burns the money with no recipient able to
 * ever spend it. The funded wallet wins whenever it exists.
 */
export function resolvePayTo(slug: ProviderSlug): `0x${string}` {
  const override = process.env.PROVIDER_PAY_TO_OVERRIDE;
  if (override && override.startsWith("0x")) return override as `0x${string}`;
  const funded = getProviderWalletAddress();
  if (funded) return funded;
  return providerBySlug(slug).payTo;
}

/**
 * Where a provider's USDC must ACTUALLY land, or null if there is nowhere
 * safe to send it.
 *
 * Unlike resolvePayTo, this never falls back to the registry placeholder
 * addresses (0x...01/02/03), which nobody controls — paying one would burn
 * the money with no recipient able to ever spend it. Use this when the
 * payment is a one-way spend of the agent's own funds (tips), where burning
 * it is worse than refusing.
 */
export function resolvePayToStrict(
  slug: ProviderSlug,
): `0x${string}` | null {
  const override = process.env.PROVIDER_PAY_TO_OVERRIDE;
  if (override && override.startsWith("0x")) return override as `0x${string}`;
  return getProviderWalletAddress();
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
  const payTo = resolvePayTo(slug);

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
    // Typical causes: the facilitator's relayer lost a nonce race, the
    // network is unreachable, or the settlement wallet is unusable. Return a
    // clear error instead of a 500 crash.
    const reason = err instanceof Error ? err.message : String(err);
    // A relayer nonce collision is transient — the same authorization is
    // still valid, so the client can retry. Signal that with 503 rather
    // than a permanent-looking 502.
    const transient = isRelayerCollision(reason);
    return {
      kind: "requirements",
      response: Response.json(
        {
          error: transient ? "Settlement temporarily unavailable" : "Settlement failed",
          reason,
          retryable: transient,
        },
        { status: transient ? 503 : 502 },
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
