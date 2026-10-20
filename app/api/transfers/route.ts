import {
  listTransfers,
  getTransfer,
  rejectTransfer,
  recordUserTransfer,
  claimTransferForSigning,
  releaseTransferClaim,
  type TransferStatus,
} from "@/agent/transfers";

/**
 * GET /api/transfers -> every transfer (optionally filtered by status)
 * POST /api/transfers { action, transferId, txHash? } -> claim, approve or reject
 *
 * The browser-wallet path is a two-step exchange with the server:
 *
 *   1. action="claim" — the browser asks permission to sign. The server
 *      re-checks the transfer caps against the CURRENT committed spend and
 *      hands out a one-shot claim, so the caps hold at the moment the money
 *      moves and one transfer cannot be signed twice.
 *   2. action="approve" — the browser reports the hash it broadcast, and
 *      the server records it.
 *
 * The agent-wallet path does not come here: the server signs it, and
 * /api/transfers/approve owns that path.
 */
export async function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status") as
    | TransferStatus
    | null;
  return Response.json({
    transfers: listTransfers(status ?? undefined),
  });
}

export async function POST(req: Request) {
  let body: {
    action?: string;
    transferId?: string;
    txHash?: string;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "Expected a JSON body." },
      { status: 400 },
    );
  }

  const { action, transferId, txHash, reason } = body;
  if (!action || !transferId) {
    return Response.json(
      { error: "Both 'action' and 'transferId' are required." },
      { status: 400 },
    );
  }

  try {
    if (action === "reject") {
      const row = await rejectTransfer(transferId, reason);
      return Response.json({ transfer: row });
    }

    if (action === "claim") {
      const existing = getTransfer(transferId);
      if (!existing) {
        return Response.json(
          { error: `No transfer with id ${transferId}.` },
          { status: 404 },
        );
      }
      if (existing.source !== "user_wallet") {
        return Response.json(
          {
            error:
              "Only transfers funded by the user's own wallet are claimed here. Agent-wallet transfers are signed by the server.",
          },
          { status: 400 },
        );
      }
      const row = await claimTransferForSigning(transferId);
      return Response.json({ transfer: row });
    }

    if (action === "release") {
      const existing = getTransfer(transferId);
      if (!existing) {
        return Response.json(
          { error: `No transfer with id ${transferId}.` },
          { status: 404 },
        );
      }
      if (existing.source !== "user_wallet") {
        return Response.json(
          {
            error:
              "Only transfers funded by the user's own wallet are claimed here. Agent-wallet transfers are signed by the server.",
          },
          { status: 400 },
        );
      }
      const row = await releaseTransferClaim(transferId);
      return Response.json({ transfer: row });
    }

    if (action === "approve") {
      if (!txHash) {
        return Response.json(
          {
            error:
              "approve requires a txHash — the browser wallet signs and sends the transaction, then reports the hash here.",
          },
          { status: 400 },
        );
      }
      const existing = getTransfer(transferId);
      if (!existing) {
        return Response.json(
          { error: `No transfer with id ${transferId}.` },
          { status: 404 },
        );
      }
      if (existing.status === "executed") {
        return Response.json({ transfer: existing });
      }
      const row = await recordUserTransfer(transferId, txHash);
      return Response.json({ transfer: row });
    }

    return Response.json(
      { error: `Unknown action "${action}". Use "claim", "approve" or "reject".` },
      { status: 400 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
