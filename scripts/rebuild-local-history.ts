/**
 * Rebuild ledger.json and settlements.json from the on-chain truth.
 *
 * The local runtime history is gitignored, so it is not recoverable from the
 * repository. This script reconstructs it from the audit dump taken from the
 * Base Sepolia chain plus the recorded rows, so the account's local history
 * is not silently truncated.
 *
 *   node --experimental-strip-types scripts/run-test.ts \
 *     scripts/rebuild-local-history.ts
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LEDGER = path.join(ROOT, "ledger.json");
const SETTLEMENTS = path.join(ROOT, "settlements.json");

// The settlement rows as they were on the chain (from the audit dump).
const SETTLEMENT_ROWS = [
  ["2026-10-20T12:41:47", "capn", 0.02, "legacy", true, "0x98d7159822064c6762c7b7c44a79f7b80e7bfb9195e0a17a82a9f5b193b8ac52"],
  ["2026-10-20T12:41:55", "capn", 0.02, "legacy", true, "0xaa3001123e21f808a1b98a0cea330af0a61c9fafc4b3c28b4f3c0d9b051915ee"],
  ["2026-10-20T13:04:27", "capn", 0.02, "legacy", true, "0x8e7a49fd5f12a972f1d5d8cfd0205aeed5c2a148ecfc62724c50e35b9c4952bf"],
  ["2026-10-20T13:43:11", "capn", 0.02, "legacy", true, "0x581eea2055b6e3c8cffc645ec9376d8420fb0edb34603cdee47b2708caaeed45"],
  ["2026-10-20T13:45:29", "capn", 0.02, "legacy", true, "0x289b968ce14e5b5ae67f94134dc08b9bd9b119220b73c3706bedfb83b144cccf"],
  ["2026-10-20T14:48:37", "capn", 0.004, "tip", true, "0x2e297462b9a1ef487d7b3d18be5b1b91c67accdb7da052c3703d3fa6d7571381"],
  ["2026-10-20T14:50:47", "feathers", 0.003, "tip", true, "0xf24cfbf9c9f3aea276e03fecf176263de787f5ec5a24bdc4ee58f005d8148551"],
  ["2026-10-20T14:51:05", "capn", 0.02, "legacy", true, "0xc240f5633f71a299e175e5c302f3b6f76bf47c955da147d1abbb097a286904f3"],
  ["2026-10-20T14:56:24", "soleil", 0.04, "commission", true, "0x84588d58884b668235b0ac5cb46f986244836d16548c287762654784b8122972"],
  ["2026-10-20T14:58:05", "soleil", 0.04, "commission", true, "0x75c445468faba6cd2572be38ffec143955a21b34c48e70ffc6b7de061085d899"],
  ["2026-10-20T15:00:51", "soleil", 0.04, "commission", true, "0x020e3552a445bb0f73a5ff5e3a04b5dd0fff976e38b2b66101058c096d0744dc"],
  ["2026-10-20T15:01:03", "soleil", 0.005, "tip", true, "0xf73c1d03ddc5dfdf3adb45474f9c30ab434088ff4d7aa3b1ee7a4dcfc7e5777e"],
  ["2026-10-20T15:06:41", "soleil", 0.04, "commission", true, "0x6954fe0295a50b2cc18890dc96e2063d055a76c5d3850d5734a3eccf952cbddc"],
  ["2026-10-20T15:10:45", "soleil", 0.005, "tip", true, "0xb372362f9f65be178034e8feff540933f5c302a8fb75fe1031f3c640f74a260e"],
  ["2026-10-20T15:11:51", "soleil", 0.04, "commission", true, "0x0d4d9f82e152437e6618fd5b3277a2297e401a3ddb95b516500f591cebfb3fd3"],
  ["2026-10-20T15:15:51", "soleil", 0.005, "tip", true, "0x7e57d51158cbd5c4bb4299602b7997aae59f972f4bdf0891d6903dce04c39d8c"],
  ["2026-10-20T15:18:59", "feathers", 0.002, "tip", true, "0xbc7af8926f601412974518b6043466b6c55f9c0a35dfbc25c7e210373ed80dd8"],
  ["2026-10-20T15:33:22", "capn", 0.02, "legacy", true, "0xb8566caa32b179e54e646204fa791451f22072a5ec53fc741d3c9faeca7b502a"],
  ["2026-10-20T16:20:25", "capn", 0.02, "legacy", true, "0x95ef5a06d125f4ab07c7f8b7c9479b26a9cb9189e0bbdd5c207aca4fd3c3f5d8"],
  // The duplicate commission — real money that left the wallet. It is NOT in
  // the ledger (it was never judged) but it IS on the chain.
  ["2026-10-20T15:12:20", "soleil", 0.05, "commission", null, "0x1e05c209d7f67f40f3ecd6a51134c5e3ef6a1259ce58589341a23ea01e58a1e4"],
] as const;

// The ledger rows as they were recorded (from the audit dump). The shape is
// the Phase 3 `LedgerEntry` schema in agent/tools.ts: `txHash` is the
// payment tx, `tipTxHash` is the tip tx.
const LEDGER_ROWS = [
  ["2026-10-20T12:41:47", "capn", 0.02, 0, 0.02, "0x98d7159822064c6762c7b7c44a79f7b80e7bfb9195e0a17a82a9f5b193b8ac52", null],
  ["2026-10-20T12:41:55", "capn", 0.02, 0, 0.02, "0xaa3001123e21f808a1b98a0cea330af0a61c9fafc4b3c28b4f3c0d9b051915ee", null],
  ["2026-10-20T13:04:27", "capn", 0.02, 0, 0.02, "0x8e7a49fd5f12a972f1d5d8cfd0205aeed5c2a148ecfc62724c50e35b9c4952bf", null],
  ["2026-10-20T13:43:11", "capn", 0.02, 0, 0.02, "0x581eea2055b6e3c8cffc645ec9376d8420fb0edb34603cdee47b2708caaeed45", null],
  ["2026-10-20T13:45:29", "capn", 0.02, 0.004, 0.02, "0x289b968ce14e5b5ae67f94134dc08b9bd9b119220b73c3706bedfb83b144cccf", "0x2e297462b9a1ef487d7b3d18be5b1b91c67accdb7da052c3703d3fa6d7571381"],
  ["2026-10-20T14:50:47", "feathers", 0, 0.003, null, null, "0xf24cfbf9c9f3aea276e03fecf176263de787f5ec5a24bdc4ee58f005d8148551"],
  ["2026-10-20T14:51:05", "capn", 0.02, 0, 0.02, "0xc240f5633f71a299e175e5c302f3b6f76bf47c955da147d1abbb097a286904f3", null],
  ["2026-10-20T14:56:25", "soleil", 0.04, 0, 0.04, "0x84588d58884b668235b0ac5cb46f986244836d16548c287762654784b8122972", null],
  ["2026-10-20T14:58:07", "soleil", 0.04, 0, 0.04, "0x75c445468faba6cd2572be38ffec143955a21b34c48e70ffc6b7de061085d899", null],
  ["2026-10-20T15:00:53", "soleil", 0.04, 0.005, 0, "0x020e3552a445bb0f73a5ff5e3a04b5dd0fff976e38b2b66101058c096d0744dc", "0xf73c1d03ddc5dfdf3adb45474f9c30ab434088ff4d7aa3b1ee7a4dcfc7e5777e"],
  ["2026-10-20T15:06:44", "soleil", 0.04, 0.005, 0, "0x6954fe0295a50b2cc18890dc96e2063d055a76c5d3850d5734a3eccf952cbddc", "0xb372362f9f65be178034e8feff540933f5c302a8fb75fe1031f3c640f74a260e"],
  ["2026-10-20T15:11:53", "soleil", 0.04, 0.005, 0.04, "0x0d4d9f82e152437e6618fd5b3277a2297e401a3ddb95b516500f591cebfb3fd3", "0x7e57d51158cbd5c4bb4299602b7997aae59f972f4bdf0891d6903dce04c39d8c"],
  ["2026-10-20T15:18:59", "feathers", 0, 0.002, null, null, "0xbc7af8926f601412974518b6043466b6c55f9c0a35dfbc25c7e210373ed80dd8"],
  ["2026-10-20T15:33:22", "capn", 0.02, 0, 0.02, "0xb8566caa32b179e54e646204fa791451f22072a5ec53fc741d3c9faeca7b502a", null],
  ["2026-10-20T16:20:25", "capn", 0.02, 0, 0.02, "0x95ef5a06d125f4ab07c7f8b7c9479b26a9cb9189e0bbdd5c207aca4fd3c3f5d8", null],
] as const;

const settlements = SETTLEMENT_ROWS.map(
  ([ts, provider, amountUsdc, kind, logged, txHash]) => ({
    ts,
    provider,
    amountUsdc,
    ...(kind === "legacy" ? {} : { kind }),
    ...(logged === null ? {} : { logged }),
    txHash,
  }),
);

const ledger = LEDGER_ROWS.map(
  ([ts, provider, paidAmount, tipUsdc, quotedPrice, txHash, tipTxHash]) => ({
    ts,
    job: `${provider} commission`,
    provider,
    providerWallet: "0xc71DAa8fD15B713Fe27406e25bB9AdfA1fea5025",
    deliverable: "(rebuilt from the on-chain audit)",
    score: 0,
    feedback: "(rebuilt from the on-chain audit)",
    paidAmount,
    tipUsdc,
    ...(quotedPrice !== null ? { quotedPrice } : {}),
    ...(txHash ? { txHash } : {}),
    ...(tipTxHash ? { tipTxHash } : {}),
  }),
);

fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
fs.writeFileSync(SETTLEMENTS, JSON.stringify(settlements, null, 2));

console.log(
  `rebuilt: ${ledger.length} ledger rows, ${settlements.length} settlement rows`,
);
