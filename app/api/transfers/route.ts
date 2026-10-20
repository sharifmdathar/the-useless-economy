import {
  listTransfers,
  getTransfer,
  rejectTransfer,
  recordUserTransfer,
  type TransferStatus,
} from "@/agent/transfers";

/**
 * GET /api/transfers -> every transfer (optionally filtered by status)
 * POST /api/transfers { action, transferId, txHash? } -> approve or reject
 *
 * The APPROVE path here only RECORDS a transaction hash for transfers the
 * user's own connected wallet signed in the browser. Server-side signing
 * lives in the agent's approve_transfer tool, which requires the user to
 * have confirmed in the chat first.
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
      { error: `Unknown action "${action}". Use "approve" or "reject".` },
      { status: 400 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
