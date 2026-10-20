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

**Video:** `docs/demo-week3-wallet.mp4` — narrated, 1920×1080, H.264 + AAC.

## Overview
The agent's own crypto wallet, and the first thing it does with it: pay for
work. The video follows one real commission and one real tip, both settled
on Base Sepolia through the x402 facilitator, and shows the balance move.

Every frame is a genuine capture of the running app. The transaction hashes
in the video are real Base Sepolia transactions.

## Scenes

| # | Scene | What is on screen |
|---|---|---|
| 1 | `01_wallet` | The agent's wallet panel — address, ETH balance, USDC balance. |
| 2 | `02_x402_challenge` | The raw HTTP 402 from the provider route. |
| 3 | `03_prompt` | The commission request being typed into the chat. |
| 4 | `04_settlement` | The expanded settlement tool call — the request, the payment, and the transaction hash. |
| 5 | `05_tip` | The expanded `tip_provider` call, with its transaction hash. |
| 6 | `06_wallet_after` | The wallet panel again, with the reduced balance. |
| 7 | `07_close` | The tip's output block, hash in view. |

## The transcript

> Week three. The agent gets its own crypto wallet, and it pays for its own
> work. This is the agent's address on Base Sepolia testnet, and the balance
> it spends from — real USDC, held in the agent's own key file, not a
> custodial account.
>
> The providers are x402 sellers. Ask one for a quote without paying, and it
> answers with a payment required challenge: the price, the USDC contract, the
> address that must be paid, and the facilitator that will settle it.
>
> You ask the agent to commission a provider. One line, and the agent goes out
> and buys the work.
>
> Here is the settlement, opened up. The agent requests the quote, gets the
> payment challenge back, signs an EIP-3009 authorisation with its own key,
> and hands it to the facilitator — which broadcasts it and pays the gas. The
> result is a real transaction hash, on chain, that anyone can verify.
>
> And because the work is good, the agent tips the provider — again, signed
> locally, again settled on chain, again with a transaction hash attached.
> The tip is recorded in the ledger against the provider, and the settlement is
> tracked separately, so a tip can never be mistaken for the price of the
> work.
>
> And the balance moves. Same wallet, same address, less USDC — every payment
> and every tip leaves the agent's own balance, verifiable on the explorer by
> anyone who opens the link.
>
> That is week three of The Useless Economy. An agent that carries its own
> money, pays for its own work, and leaves a receipt for every cent. The
> Useless Economy.

## Key technical details viewers should notice

### The x402 challenge (scene 2)
The provider route answers `402 Payment Required` with the payment
requirements:

```json
{
  "error": "Payment Required",
  "scheme": "eip3009",
  "price": "0.05",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "payTo": "0xc71DAa8fD15B713Fe27406e25bB9AdfA1fea5025",
  "facilitator": "https://x402.org/facilitator",
  "resource": "/providers/rate-sunset"
}
```

The frame in the video is the browser's own rendering of that response,
captured from the running server.

### The settlement path (scene 4)
1. **Request** — the agent asks the provider for the work and gets the 402.
2. **Sign** — the agent signs an EIP-3009 `transferWithAuthorization`
   authorisation with its own key, against the USDC domain (`name: "USDC"`,
   `version: "2"`, chain `84532`).
3. **Sponsor** — the authorisation is handed to the x402 facilitator, which
   broadcasts it and pays the gas. This is what makes it work: the agent
   wallet holds USDC but **zero ETH**, so a direct `USDC.transfer` could never
   succeed.
4. **Receipt** — the facilitator returns the transaction hash, which is
   recorded in `settlements.json` and appended to the ledger.

The recorded amount and hash come from the code that observed the settlement,
not from what the model says happened.

### Tips (scene 5)
`tip_provider` uses the same EIP-3009 + facilitator path, so a tip is
gas-sponsored too. A tip always leaves a local trace: it attaches to an
existing paid ledger row when there is one, and otherwise creates a standalone
row. Tip settlements are tagged `kind: "tip"`, and `takeUnloggedSettlement()`
only ever claims *commission* settlements — so a tip can never later be
reported as the price of commissioned work.

### Payout resolution
Tips and commissions both resolve their destination in code:
- a valid `PROVIDER_PAY_TO_OVERRIDE`, if set;
- otherwise the funded provider wallet;
- for a one-way tip, if neither is available the tip is **refused** — it never
  falls back to an unowned registry placeholder address.

### Addresses shown in the video
- **Agent:** `0xef3E983B014148c76bF0Caa64547826220543433` (from `.agent-wallet.json`)
- **Provider:** `0xc71DAa8fD15B713Fe27406e25bB9AdfA1fea5025` (from `.provider-wallet.json`)
- **USDC (Base Sepolia):** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

### Hard caps (enforced in code, not in prompts)
- **Per-job cap:** 0.05 USDC — `budgetGuard("commission", amount)` throws if exceeded.
- **Weekly cap:** 1 USDC rolling 7 days — checked via `weekSpend()` from the ledger.
- **Transfer caps:** `MAX_TRANSFER_USDC=100` per transfer, `MAX_DAILY_TRANSFER_USDC=500` per day.
- **`KILL_SWITCH=1`** freezes commissions, tips, transfer-intent creation, and transfer execution immediately.

## How to reproduce the demo

```bash
# 1. Start the app
npm run dev

# 2. View the wallet
curl http://localhost:3000/api/wallet

# 3. See the x402 challenge
curl -i "http://localhost:3000/providers/rate-sunset?location=Lisbon&request=golden+sunset+over+the+Tagus"
# → HTTP 402 with the payment requirements

# 4. Commission a job
#    - Ask the agent to hire a provider for a job
#    - Watch: 402 → sign EIP-3009 → facilitator → settle → ledger update

# 5. Tip a provider
#    - Ask the agent to tip a provider
#    - Watch: EIP-3009 → facilitator → settle → ledger row
```

## What proves the functionality works

- ✅ Typecheck passes: `npx tsc --noEmit`
- ✅ Build passes: `npm run build`
- ✅ The x402 flow is verified at the wire level (402 → sign → settle), with the provider balance delta asserted
- ✅ Settlement amounts and hashes are recorded by the code that observed them
- ✅ Tips are classified separately from commissions and cannot be claimed as income
- ✅ A tip can never be paid to an unowned placeholder address
- ✅ The agent wallet holds no ETH and still settles — gas is sponsored
- ✅ Hard caps and `KILL_SWITCH` are enforced in code
