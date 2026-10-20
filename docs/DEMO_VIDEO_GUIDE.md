# Week 1 Demo Video Guide: "The Gig Economy"

**Video:** `docs/demo-week1-gig-economy.mp4` — 2:07, 1920×1080, H.264 + AAC, narrated.

## Overview
Week 1 is the original product: one prompt dispatched to three provider AIs,
each deliverable judged, the standings ranked, and a winner announced. The
video also opens the raw tool call so the mechanism is visible, not just the
answer.

Every frame is a genuine render of the running app (Playwright/Chromium against
`localhost:3000`). Nothing is mocked.

The standings shown are read from the judge's recorded result, not from the
agent's own retelling of it, so the table in scene 4 always agrees with the
raw tool output opened up in scene 6.

## Scenes

| # | Time | What is on screen |
|---|---|---|
| 1 | 0:00 | The app — Foreman chat, setup panel, agent wallet address. |
| 2 | 0:16 | The cast: `rate_sunset`, `count_pigeons`, `pirate_translate`, `judge_deliverable`. |
| 3 | 0:36 | The job being typed: `a golden sunset over the Tagus, Lisbon`. |
| 4 | 0:50 | The result — standings table with scores and feedback, and the winner. |
| 5 | 1:12 | The full tool surface the agent can call. |
| 6 | 1:33 | The expanded `run_gig_economy` tool call: raw Input and Output JSON. |
| 7 | 1:52 | The completed run on screen, closing the demo. |

## The transcript

> The Useless Economy. An agent-to-agent gig market where a manager AI hires
> three provider AIs to do pointless jobs, judges the work, and settles tips
> on-chain.
>
> The cast is three AI providers, and every one of them is gloriously,
> pointlessly specialised. Soleil rates sunsets out of ten. Feathers counts
> pigeons in a scene. And Cap'n translates any text into pirate speech.
>
> You ask for one job. Here — a golden sunset over the Tagus, Lisbon. One
> prompt, and the manager AI fans it out to all three providers at once.
>
> All three deliver. Each one is scored out of five by an independent judge,
> with written feedback, and the standings you see here are read straight from
> the judge's record — the agent does not get to retell them. A winner is
> named, and the rest get a note explaining where they fell short.
>
> All of it runs through one agent with real tools. Rate a sunset, count
> pigeons, pirate-translate, judge a deliverable, log to the ledger, run the
> whole gig economy in one shot, generate the weekly report, and tip a
> provider on-chain.
>
> And every step is inspectable. Here is the actual tool call the agent made,
> with the job it sent in and the raw output it got back — the winner, the
> standings, and every deliverable in full. Nothing is hidden behind the chat
> bubble.
>
> That is week one of The Useless Economy. A market for work that has no
> business existing — except that it does, and it pays. The Useless Economy.

## How it was cut

- `capture_week1.py` — Playwright/Chromium against `localhost:3000`, 1600×900
  at 2× scale, waiting on the agent's own result block rather than a fixed
  sleep (the provider ranking changes run to run, so the wait matches
  `Standings|Winner:`).
- `voiceover_week1.md` — the narration script, one block per scene.
- `build_video.py` — slow Ken Burns push on each still, 0.45 s cross-fades,
  Piper narration (`en_US-amy-medium`) laid under each scene, then an
  `alimiter` pass so the narration peaks at −1 dB instead of clipping at 0 dB.

---

# Week 2 Demo Video Guide: "Natural-Language Transfers"

**Video:** `docs/demo-week2-transfers.mp4` — 2:42, 1920×1080, H.264 + AAC, narrated.

## Overview
The agent is *told* to move money in plain English. The video shows the full
two-phase lifecycle: the prompt, the code-enforced validation, the pending
review card, the explicit approval, the on-chain settlement, the browser-wallet
path, and a cap that the code refuses.

Every frame is a genuine render of the running app (Playwright/Chromium against
`localhost:3000`). Nothing is mocked except the injected EIP-1193 provider in
scene 8, which stands in for MetaMask and never holds a key.

## Scenes

| # | Time | What is on screen |
|---|---|---|
| 1 | 0:00 | The app — Foreman chat, tool list, agent wallet address. |
| 2 | 0:16 | Week 2 feature framing: transfers join the existing gig market. |
| 3 | 0:29 | The prompt being typed: `send 1 USDC to 0x…dEaD`. |
| 4 | 0:42 | The **TRANSFER REVIEW** card — amount, recipient, source, network, pending. |
| 5 | 0:57 | Nothing signed yet: the intent is pending, awaiting approval. |
| 6 | 1:11 | **APPROVE & SEND** pressed. |
| 7 | 1:25 | **EXECUTED** — transaction hash and explorer link, now visible and copyable. |
| 8 | 1:40 | The browser-wallet path: *FROM: Your connected browser wallet (you sign)*. The extension signs; the server only records the hash. |
| 9 | 1:58 | The code refusing an over-cap transfer (500 USDC vs. a 100 USDC cap). |
| 10 | 2:12 | The full tool surface, closing the demo. |

## The transcript

1. "The Useless Economy is an agent-to-agent gig market. Three AI providers do
   pointless jobs. The Foreman hires them, judges them, and pays them."
2. "Week two: the agent can be told to move money, in plain English."
3. "You type: send one USDC to this address. No forms, no wallet plumbing."
4. "The agent parses the token, the amount, and the recipient — then validates
   all three in code. Not in the prompt. In code."
5. "Here is the review card. Amount, recipient, source wallet, network. The
   status is pending. Nothing has been signed. Nothing has been broadcast."
6. "One click. Approve and send."
7. "And it settles. Here is the transaction hash on Base Sepolia. Real USDC,
   real chain, real receipt."
8. "Or bring your own wallet. The card says: your connected browser wallet,
   you sign. The extension signs the transaction. This app never sees a
   private key — it only records the hash."
9. "And the limits are not suggestions. Ask for five hundred USDC and the
   code refuses, because the cap is one hundred. A prompt cannot raise a cap."
10. "That is week two of The Useless Economy. Natural-language transfers with
    an approval gate, on-chain on Base Sepolia. Built with RiseIn."

## How it was made

- Frames: `scripts` in the demo scratch dir — Playwright/Chromium, 1600×900 at 2×.
- Voice: Piper TTS (local ONNX), one WAV per scene.
- Assembly: ffmpeg — slow Ken Burns push per still, 0.45s cross-fades, AAC audio.

## What proves it works

- ✅ The transfer in scene 7 is a real on-chain USDC transfer (receipt status `0x1`).
- ✅ The rejection in scene 9 is the real per-transfer cap firing in `agent/transfers.ts`.
- ✅ The browser-wallet path produced a real ERC-20 `transfer` call through `window.ethereum`.
- ✅ `npx tsc --noEmit` and `npm run build` both pass.

---

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