import { executeAgentTransfer, getTransfer } from "@/agent/transfers";

/**
 * POST /api/transfers/approve { transferId }
 *
 * The AGENT-WALLET approval path. The user clicks "Approve & send" in the
 * transfer review card in the chat; that click is the authorization, and
 * this endpoint signs and broadcasts the transaction.
 *
 * The user-wallet path does NOT come here: in that case the browser wallet
 * signs, and /api/transfers only records the resulting hash.
 */
export async function POST(req: Request) {
  let body: { transferId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const { transferId } = body;
  if (!transferId) {
    return Response.json(
      { error: "'transferId' is required." },
      { status: 400 },
    );
  }

  const pending = getTransfer(transferId);
  if (!pending) {
    return Response.json(
      { error: `No transfer with id ${transferId}.` },
      { status: 404 },
    );
  }
  if (pending.status === "executed") {
    return Response.json({
      status: "executed",
      txHash: pending.txHash,
      transfer: pending,
    });
  }
  if (pending.status !== "pending") {
    return Response.json(
      { error: `Transfer ${transferId} is ${pending.status}, not pending.` },
      { status: 400 },
    );
  }
  if (pending.source !== "agent_wallet") {
    return Response.json(
      {
        error:
          "This transfer is funded by the user's own wallet — the browser wallet must sign it, not the server.",
      },
      { status: 400 },
    );
  }

  try {
    const result = await executeAgentTransfer(transferId);
    if (result.status === "failed") {
      return Response.json(
        { error: result.reason, status: "failed", transfer: result },
        { status: 500 },
      );
    }
    return Response.json({
      status: "executed",
      txHash: result.txHash,
      explorer: `https://sepolia.basescan.org/tx/${result.txHash}`,
      transfer: result,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
