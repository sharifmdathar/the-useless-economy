import { isAddress } from "viem";
import {
  isValidRecipient,
  resolveToken,
  amountToUnits,
  unitsToAmount,
} from "../agent/tokens";

const cases = [
  "0x000000000000000000000000000000000000dEaD", // checksummed
  "0x000000000000000000000000000000000000dead", // all lowercase
  "0xdEAD00000000000000000000000000000000beef", // mixed case, wrong checksum
  "0x123",
  "not-an-address",
  "",
];

for (const c of cases) {
  console.log(
    JSON.stringify(c).padEnd(68),
    "isAddress(strict):", String(isAddress(c, { strict: true })).padEnd(5),
    "isValidRecipient:", isValidRecipient(c),
  );
}

console.log("\n--- token resolution ---");
for (const t of ["USDC", "usdc", "usd coin", "ETH", "ether", "DAI", ""]) {
  const r = resolveToken(t);
  console.log(JSON.stringify(t).padEnd(12), "->", r ? `${r.symbol} (${r.decimals}dp, native=${r.isNative})` : "null");
}

console.log("\n--- amount parsing ---");
const usdc = resolveToken("USDC")!;
for (const a of [10, "10", 0.5, "0.000001", "0.0000001", 0, -5, "abc", 1e12]) {
  const u = amountToUnits(usdc, a as any);
  console.log(String(a).padEnd(14), "->", u === null ? "null (rejected)" : `${u} units = ${unitsToAmount(usdc, u)} USDC`);
}
