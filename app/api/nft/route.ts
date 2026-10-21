import {
  approveMint,
  createPendingMint,
  listMints,
  nftStatus,
  rejectMint,
} from "@/agent/nft";

/**
 * GET /api/nft -> the deployment status, every mint intent, and the ones
 *                  still waiting for the user.
 * POST /api/nft { action, ... }
 *   action="create"  -> file a pending mint (no contract call)
 *   action="approve" -> the user pressed Mint: write the metadata and call
 *                       the contract's mint()
 *   action="reject"  -> the user cancelled; nothing was signed
 */
export async function GET() {
  return Response.json({
    ...nftStatus(),
    mints: listMints(),
  });
}

export async function POST(req: Request) {
  let body: {
    action?: string;
    mintId?: string;
    name?: string;
    description?: string;
    traits?: { trait_type: string; value: string }[];
    image?: string;
    prompt?: string;
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

  const { action } = body;
  if (!action) {
    return Response.json(
      { error: "An 'action' is required." },
      { status: 400 },
    );
  }

  try {
    if (action === "create") {
      const mint = await createPendingMint({
        name: body.name ?? "",
        description: body.description,
        recipient: undefined,
        traits: body.traits,
        prompt: body.prompt,
      });
      return Response.json({ mint });
    }

    if (action === "approve") {
      if (!body.mintId) {
        return Response.json(
          { error: "approve requires a mintId." },
          { status: 400 },
        );
      }
      const mint = await approveMint(body.mintId, {
        name: body.name,
        description: body.description,
        traits: body.traits,
        image: body.image,
      });
      return Response.json({ mint });
    }

    if (action === "reject") {
      if (!body.mintId) {
        return Response.json(
          { error: "reject requires a mintId." },
          { status: 400 },
        );
      }
      const mint = await rejectMint(body.mintId, body.reason);
      return Response.json({ mint });
    }

    return Response.json(
      { error: `Unknown action "${action}". Use "create", "approve" or "reject".` },
      { status: 400 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
