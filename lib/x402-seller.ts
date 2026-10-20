/**
 * X402 SELLER HELPERS — shared by all three provider routes.
 *
 * A provider route calls `guardOrSettle(req, providerSlug)`:
 *   - no X-PAYMENT header    -> 402 with the x402 requirements (price/payTo/asset)
 *   - header present         -> verify + settle on-chain, return { payment, settledTx }
 *   - below persona floor    -> 402 refusal (the negotiation rule, in code)
 *
 * EXACTLY-ONCE SETTLEMENT
 * -----------------------
 * A provider is paid through an EIP-3009 authorization. The authorization's
 * nonce is what makes it single-use: the USDC contract refuses to spend the
 * same authorization twice, so a replayed X-PAYMENT header can never move the
 * money a second time.
 *
 * The danger is not replay of the SAME authorization (the contract stops
 * that) — it is signing a SECOND, DIFFERENT authorization for the same job.
 * That is what happened before this guard: `commission_job` asked the
 * provider for its price (which the provider settled and paid for) and then
 * asked AGAIN at a counter-offer price, producing two distinct nonces and
 * two funded transfers for one piece of work.
 *
 * So settlement is keyed by the PAYMENT IDENTITY (payer + nonce), and the
 * ledger amount is the amount the chain actually moved.
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

/**
 * The identity of a single x402 payment: the payer's address plus the
 * EIP-3009 nonce. Two requests with the same identity are the SAME payment
 * and must settle at most once.
 */
export function paymentIdentity(
  payment: Pick<X402PaymentBody, "from" | "nonce">,
): string {
  return `${payment.from.toLowerCase()}:${payment.nonce.toLowerCase()}`;
}

/**
 * Settlements this process already performed, keyed by payment identity.
 *
 * This is an in-process memo of payments the provider has ALREADY paid for.
 * It is not a substitute for the contract's own single-use guarantee (that is
 * the real defence against a replayed header) — it exists so the provider
 * refuses to even attempt a second settlement of the same authorization and
 * can answer with the ORIGINAL transaction hash instead.
 */
const settledPayments = new Map<string, string>();

/** Test hook: forget every memoized settlement. */
export function resetSettlementMemo() {
  settledPayments.clear();
}

/** Test hook: the settlement memo, for assertions. */
export function listSettledPayments(): { identity: string; tx: string }[] {
  return [...settledPayments.entries()].map(([identity, tx]) => ({
    identity,
    tx,
  }));
}

/**
 * Settle a payment AT MOST ONCE for a given payment identity.
 *
 * This is the single choke point for provider settlement. The first call for
 * an identity runs `settle` and remembers the transaction. Every later call
 * for the same identity returns the ORIGINAL transaction without calling
 * `settle` again — so a replayed request can never move money a second time.
 *
 * The EIP-3009 nonce gives a second, on-chain guarantee (the USDC contract
 * refuses to spend one authorization twice). This memo is the application
 * guarantee: it stops the SECOND ATTEMPT rather than merely failing it.
 */
export async function settleOnce(
  identity: string,
  settle: () => Promise<{ tx: string }>,
): Promise<{ tx: string; replay: boolean }> {
  const already = settledPayments.get(identity);
  if (already) return { tx: already, replay: true };
  const { tx } = await settle();
  settledPayments.set(identity, tx);
  return { tx, replay: false };
}

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

  // EXACTLY-ONCE: this authorization has already been paid for. Do not
  // attempt to settle it again — answer with the original transaction.
  const identity = paymentIdentity(payment);
  const alreadySettled = settledPayments.get(identity);
  if (alreadySettled) {
    return {
      kind: "settled",
      payment,
      settledTx: alreadySettled,
      effectivePrice: Number(payment.value) / 10 ** 6,
    };
  }

  let tx: string;
  try {
    // EXACTLY-ONCE choke point. The first settlement for this payment
    // identity runs; every later attempt for the same identity returns the
    // ORIGINAL transaction without touching the chain.
    const settledOnce = await settleOnce(identity, async () => {
      const { tx: settledTx } = await settlePaymentFromHeader(header);
      return { tx: settledTx };
    });
    if (settledOnce.replay) {
      return {
        kind: "settled",
        payment,
        settledTx: settledOnce.tx,
        effectivePrice: Number(payment.value) / 10 ** 6,
      };
    }
    tx = settledOnce.tx;
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
