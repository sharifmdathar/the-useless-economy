import { readMetadata } from "@/agent/nft";

/**
 * GET /api/nfts/[id] -> the ERC-721 metadata document for a minted token.
 *
 * This is what the tokenURI stored on-chain points at: the app writes the
 * metadata (with the image embedded as a data URI) when the mint is approved,
 * and this route serves it back. The document is self-contained, so a client
 * that fetches the tokenURI gets the picture with it.
 *
 * The id is the MINT id, not the on-chain token id, because the metadata is
 * written before the contract call and the token id only exists afterwards.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const metadata = readMetadata(id);
  if (!metadata) {
    return Response.json(
      { error: `No metadata for mint ${id}.` },
      { status: 404 },
    );
  }
  return Response.json(metadata, {
    headers: {
      // The metadata of a given token never changes, so it can be cached.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
