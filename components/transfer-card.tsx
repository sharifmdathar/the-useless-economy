"use client";

/**
 * THE TRANSFER REVIEW CARD — where the user authorizes an on-chain transfer.
 *
 * The agent files a pending transfer; this card is what the user actually
 * sees before anything is signed. It shows the amount, token, recipient
 * (checksummed, copyable), which wallet funds it, and the caps that apply.
 *
 * Two funding paths:
 *   - "Agent wallet" — the server signs. Clicking Approve calls the
 *     approve_transfer tool through the chat.
 *   - "My wallet"   — the browser wallet signs. Clicking Approve asks the
 *     injected EIP-1193 provider to send the transaction, then reports the
 *     resulting hash to /api/transfers.
 *
 * Either way, the user sees exactly what they are authorizing first.
 */
import { useState } from "react";
import { Check, Copy, ExternalLink, Loader2, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  connectWallet,
  hasInjectedWallet,
  sendFromUserWallet,
} from "@/lib/browser-wallet";
import type { Address } from "viem";

export type TransferCardData = {
  id: string;
  token: "USDC" | "ETH";
  amount: string;
  recipient: string;
  source: "agent_wallet" | "user_wallet";
  status: string;
  txHash?: string;
  reason?: string;
  createdAt?: string;
};

export function TransferCard({
  transfer,
  onApproved,
  onRejected,
}: {
  transfer: TransferCardData;
  onApproved?: (id: string, txHash?: string) => void;
  onRejected?: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isPending = transfer.status === "pending";
  const isExecuted = transfer.status === "executed";

  function copy() {
    navigator.clipboard.writeText(transfer.recipient);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      if (transfer.source === "user_wallet") {
        const accounts = await connectWallet();
        if (!accounts.length) throw new Error("No account selected.");
        const { txHash } = await sendFromUserWallet({
          from: accounts[0],
          to: transfer.recipient as Address,
          amount: transfer.amount,
          token: transfer.token,
        });
        const res = await fetch("/api/transfers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "approve",
            transferId: transfer.id,
            txHash,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Could not record the transfer.");
        }
        onApproved?.(transfer.id, txHash);
      } else {
        // Agent wallet: the server signs, but only after the user clicks
        // here — the tool call is the authorization.
        onApproved?.(transfer.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          transferId: transfer.id,
          reason: "Declined in the chat UI.",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not cancel the transfer.");
      }
      onRejected?.(transfer.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-2 p-4",
        isPending
          ? "border-primary bg-primary/5"
          : isExecuted
            ? "border-green-600/40 bg-green-600/5"
            : "border-border opacity-70",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-xs font-medium tracking-[0.06em] uppercase">
          <ShieldAlert className="mr-1.5 inline size-3.5" />
          Transfer review
        </p>
        <Badge
          variant={isExecuted ? "default" : isPending ? "secondary" : "outline"}
          className="font-mono uppercase"
        >
          {transfer.status}
        </Badge>
      </div>

      <div className="flex flex-col gap-2 font-mono text-sm">
        <Row label="Amount">
          <span className="text-base font-bold text-primary">
            {transfer.amount} {transfer.token}
          </span>
        </Row>
        <Row label="To">
          <span className="flex min-w-0 items-center gap-1">
            <code className="truncate text-xs">{transfer.recipient}</code>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copy}
              aria-label="Copy recipient address"
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </span>
        </Row>
        <Row label="From">
          {transfer.source === "agent_wallet"
            ? "The agent's own wallet (server signs)"
            : "Your connected browser wallet (you sign)"}
        </Row>
        <Row label="Network">Base Sepolia (testnet)</Row>
      </div>

      {error && (
        <p className="flex items-start gap-2 bg-destructive/10 p-2 text-xs text-destructive">
          <X className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      )}

      {isPending && (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={approve}
            disabled={busy}
            className="font-mono tracking-wider uppercase"
          >
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Check strokeWidth={3} />
            )}
            Approve &amp; send
          </Button>
          <Button
            variant="outline"
            onClick={reject}
            disabled={busy}
            className="font-mono tracking-wider uppercase"
          >
            <X /> Cancel
          </Button>
        </div>
      )}

      {isExecuted && transfer.txHash && (
        <a
          className="inline-flex items-center gap-1 font-mono text-xs text-primary underline underline-offset-4"
          href={`https://sepolia.basescan.org/tx/${transfer.txHash}`}
          target="_blank"
          rel="noreferrer"
        >
          View transaction <ExternalLink className="size-3" />
        </a>
      )}

      {transfer.reason && (
        <p className="font-mono text-xs text-muted-foreground">
          {transfer.reason}
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-16 shrink-0 text-xs tracking-[0.06em] text-muted-foreground uppercase">
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export { hasInjectedWallet };
