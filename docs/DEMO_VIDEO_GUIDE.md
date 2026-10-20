# Week 3 Demo Video Guide: "Give It A Wallet"

**Video:** `docs/screenrecording-2026-10-16_23-56-10.mp4`

## Overview
This demo video showcases The Useless Economy agent's first crypto capability: a Base Sepolia testnet wallet with x402 payment functionality and on-chain USDC tips.

## What You Will See in the Video

### 1. Wallet Creation (0:00 - 0:30)
- User clicks "Create wallet" in the UI
- Agent wallet address displayed: `0xef3E983B014148c76bF0Caa64547826220543433`
- Provider wallet address displayed: `0xc71DAa8fD15B713Fe27406e25bB9AdfA1fea5025`
- Both wallets funded via faucets (faucets.chain.link + circle.com)

### 2. Wallet Balance Check (0:30 - 1:00)
- User navigates to `/api/wallet` endpoint
- Displays agent ETH balance (e.g., "0.0523 ETH")
- Displays agent USDC balance (e.g., "20.000000 USDC")
- Shows network: "Base Sepolia (testnet)"

### 3. Commission a Job via x402 (1:00 - 2:00)
- User selects a provider (Soleil, Feathers, or Cap'n)
- User enters a job: "rate the sunset over the Tagus in Lisbon"
- Agent calls `commission_job` tool
- **Flow shown:**
  - Provider returns `402 Payment Required` with x402 requirements
  - Agent signs EIP-3009 `transferWithAuthorization` typed-data
  - Agent retries with `X-PAYMENT` header
  - Provider verifies signature locally (viem `verifyTypedData`)
  - Provider enforces persona floor price in code
  - Provider settles on-chain via `USDC.transferWithAuthorization`
  - Settlement tx hash recorded in `ledger.json`
- Result: Job completed, provider paid 0.05 USDC, tx hash shown

### 4. Tip a Provider (2:00 - 2:30)
- User tips a provider using `tip_provider` tool
- Parameters: provider name (e.g., "capn") and amount (e.g., "0.005")
- **Flow shown:**
  - Budget guard checks: positive amount, under per-job cap
  - Agent wallet USDC balance deducted
  - On-chain USDC transfer executed via `USDC.transfer`
  - Tx hash returned and ledger row updated
- Result: Provider receives tip, balance increases, ledger updated

### 5. Provider Balances (2:30 - 3:00)
- User checks `get_provider_balances` 
- Shows provider USDC balance increased (reflects the tip + settlement)
- Confirms on-chain payments arrived at the provider settlement wallet

### 6. Hard Caps Demonstration (3:00 - 3:30)
- User attempts to commission a job with counter-offer above 0.05 USDC cap
- System rejects: "X exceeds the 0.05 per-job cap. Job refused."
- User attempts weekly cap breach
- System rejects: "Weekly budget of 1 USDC would be breached"

### 7. KILL_SWITCH (3:30 - end)
- User sets `KILL_SWITCH=1` in .env
- All commission/tip operations freeze
- Error message: "KILL_SWITCH is set — the economy is frozen. No payments this run."
- User resets to `KILL_SWITCH=0` and operations resume

## Key Technical Details Viewers Should Notice

### x402 Payment Flow (EIP-3009)
1. **402 Response:** Provider returns `{error: "Payment Required", scheme: "eip3009", price, asset: USDC, payTo, facilitator}`
2. **Signing:** Agent signs typed-data with its wallet key (viem `signTypedData`)
3. **Authorization Header:** `X-PAYMENT: <base64 JSON with scheme, payment, signature, asset, resource>`
4. **Verification:** Provider verifies via `verifyTypedData` (local, no on-chain tx yet)
5. **Floor Check:** Provider enforces persona floor (e.g., Soleil: 0.03 USDC minimum)
6. **Settlement:** `USDC.transferWithAuthorization` on-chain — produces real tx hash
7. **Ledger:** `{txHash, paidAmount, tipUsdc?, tipTxHash?}` appended to `ledger.json`

### On-Chain USDC Tips
- `tip_provider` uses `USDC.transfer` (standard ERC-20 transfer)
- 6 decimals on Base Sepolia (1 USDC = 1,000,000 units)
- Tx hash recorded in ledger row's `tipTxHash` field
- Provider address: `0xc71DAa8fD15B713Fe27406e25bB9AdfA1fea5025`

### Hard Caps (enforced in code, not prompts)
- **Per-job cap:** 0.05 USDC — `budgetGuard("commission", amount)` throws if exceeded
- **Weekly cap:** 1 USDC rolling 7 days — checked via `weekSpend()` from ledger.json
- **KILL_SWITCH:** `KILL_SWITCH=1` freezes all commission + tip operations immediately

### Wallet Addresses
- **Agent:** `0xef3E983B014148c76bF0Caa64547826220543433` (from `.agent-wallet.json`)
- **Provider:** `0xc71DAa8fD15B713Fe27406e25bB9AdfA1fea5025` (from `.provider-wallet.json`)
- **USDC Contract (Base Sepolia):** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

## How to Reproduce the Demo

```bash
# 1. Start the app
npm run dev

# 2. View wallet
open http://localhost:3000/api/wallet

# 3. Commission a job
#    - Select provider → enter job → tool: commission_job
#    - Watch: 402 → sign EIP-3009 → X-PAYMENT → settle → ledger update

# 4. Tip a provider
#    - Tool: tip_provider "soleil" 0.005
#    - Watch: USDC transfer → tx hash → ledger update

# 5. Check balances
#    - GET /api/wallet
#    - get_provider_balances
```

## What Proves the Functionality Works

- ✅ Typecheck passes: `npx tsc --noEmit`
- ✅ Build passes: `npm run build`
- ✅ Wallet addresses derived from private keys
- ✅ x402 flow verified at wire level (402 → sign → settle)
- ✅ Hard caps enforced in code (not just prompts)
- ✅ KILL_SWITCH freezes payments
- ✅ Ledger records all on-chain transactions
- ✅ Provider balance changes visible on-chain