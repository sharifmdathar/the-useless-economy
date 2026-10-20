import {
  createWallet,
  getWalletAddress,
  getWalletBalance,
  getUsdcBalance,
} from "@/agent/wallet";

// GET /api/wallet -> the agent's wallet address and balances (or null if none yet)
export async function GET() {
  const address = getWalletAddress();
  if (!address) return Response.json({ address: null });

  const [eth, usdc] = await Promise.all([
    getWalletBalance().catch(() => "unavailable"),
    // USDC is what the agent actually spends (payments, tips, transfers), so
    // the balance that matters is the one that moves.
    getUsdcBalance(address as `0x${string}`).catch(() => "unavailable"),
  ]);
  return Response.json({ address, balance: eth, usdc });
}

// POST /api/wallet -> create the agent's wallet
export async function POST() {
  return Response.json({ address: createWallet() });
}
