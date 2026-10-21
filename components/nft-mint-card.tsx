"use client";

/**
 * THE NFT MINT CARD — the in-chat interface where a human turns an intent
 * into an actual token.
 *
 * The brief asks for "a small interactive interface directly within the chat
 * screen, allowing the user to upload an NFT image and enter its name,
 * description, and metadata" and then to "review the details and initiate
 * the minting transaction through the interface".
 *
 * That is exactly what this card does:
 *
 *   1. The agent has already filed a pending mint (name, description, traits
 *      it proposed, recipient).
 *   2. The user uploads an image, edits the name, the description and the
 *      traits, and can add or remove trait rows.
 *   3. "Review" shows precisely what will be written on-chain — the metadata
 *      document, the image size, the recipient, the contract.
 *   4. "Mint NFT" is the authorization. It calls the server, which writes
 *      the metadata and then calls `mint()` on the contract.
 *
 * The image never leaves the browser until the user presses Mint: it is
 * downscaled to a sane size first, so a 4 MB screenshot does not become a
 * 4 MB request body.
 */
import { useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  ImagePlus,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type NftMintCardData = {
  id: string;
  name: string;
  description: string;
  recipient: string;
  traits: { trait_type: string; value: string }[];
  status: string;
  tokenId?: number;
  txHash?: string;
  tokenUri?: string;
  reason?: string;
  createdAt?: string;
};

type Trait = { trait_type: string; value: string };

/**
 * Downscale an uploaded image to something a token can carry.
 *
 * The metadata is stored on-chain as a URI and served by this app, so the
 * image is embedded as a data URI. That means its SIZE matters: a 4 MB
 * screenshot would make a multi-megabyte metadata document. So the image is
 * drawn onto a canvas at most 512px on its long edge and re-encoded as JPEG,
 * with the quality stepped down until it fits the budget.
 */
const MAX_EDGE = 512;
const MAX_BYTES = 180_000;

async function prepareImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot process the image.");
  // JPEG has no alpha channel, so paint a background first.
  ctx.fillStyle = "#101018";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  let quality = 0.85;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length * 0.75 > MAX_BYTES && quality > 0.35) {
    quality -= 0.15;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  return dataUrl;
}

function bytesOf(dataUrl: string): number {
  return Math.round(dataUrl.length * 0.75);
}

export function NftMintCard({
  mint,
  onMinted,
  onRejected,
}: {
  mint: NftMintCardData;
  onMinted?: (id: string, result: NftMintCardData) => void;
  onRejected?: (id: string) => void;
}) {
  const [name, setName] = useState(mint.name);
  const [description, setDescription] = useState(mint.description);
  const [traits, setTraits] = useState<Trait[]>(
    mint.traits?.length ? mint.traits : [{ trait_type: "", value: "" }],
  );
  const [image, setImage] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<NftMintCardData>(mint);
  const fileRef = useRef<HTMLInputElement>(null);

  const isPending = minted.status === "pending";
  const isMinted = minted.status === "minted";
  const live = minted.status === "minted" ? minted : { ...minted, name, description, traits };

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      setImage(await prepareImage(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function setTrait(index: number, key: keyof Trait, value: string) {
    setTraits((prev) =>
      prev.map((t, i) => (i === index ? { ...t, [key]: value } : t)),
    );
  }

  async function mintNow() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          mintId: mint.id,
          name,
          description,
          traits: traits.filter((t) => t.trait_type.trim()),
          image: image ?? undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? "The mint failed.");
      }
      setMinted(body.mint);
      onMinted?.(mint.id, body.mint);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          mintId: mint.id,
          reason: "Cancelled in the chat UI.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? "Could not cancel the mint.");
      }
      setMinted({ ...minted, status: "rejected" });
      onRejected?.(mint.id);
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
        isMinted
          ? "border-green-600/40 bg-green-600/5"
          : isPending
            ? "border-primary bg-primary/5"
            : "border-border opacity-70",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-xs font-medium tracking-[0.06em] uppercase">
          <Sparkles className="mr-1.5 inline size-3.5" />
          NFT mint
        </p>
        <Badge
          variant={isMinted ? "default" : isPending ? "secondary" : "outline"}
          className="font-mono uppercase"
        >
          {minted.status}
        </Badge>
      </div>

      {isMinted ? (
        <div className="flex flex-col gap-2 font-mono text-sm">
          <Row label="Token">
            <span className="text-base font-bold text-primary">
              #{minted.tokenId}
            </span>
          </Row>
          <Row label="Name">{live.name}</Row>
          <Row label="To">
            <code className="break-all text-xs">{live.recipient}</code>
          </Row>
          <Row label="URI">
            <code className="break-all text-xs">{minted.tokenUri}</code>
          </Row>
          {minted.txHash && (
            <Row label="TX">
              <a
                className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-4"
                href={`https://sepolia.basescan.org/tx/${minted.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {minted.txHash.slice(0, 10)}…{minted.txHash.slice(-8)}
                <ExternalLink className="size-3" />
              </a>
            </Row>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* The image: uploaded, or the placeholder the agent proposes. */}
          <div className="flex gap-3">
            <div className="relative size-28 shrink-0 overflow-hidden border bg-muted">
              {image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={image}
                  alt="NFT preview"
                  className="size-full object-cover"
                />
              ) : (
                <div className="flex size-full items-center justify-center text-muted-foreground">
                  <ImagePlus className="size-6" />
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label className="font-mono text-xs tracking-[0.06em] text-muted-foreground uppercase">
                Image
              </label>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onPick(e.target.files?.[0])}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                >
                  <ImagePlus /> Upload
                </Button>
                {image && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setImage(null)}
                    disabled={busy}
                  >
                    <X /> Clear
                  </Button>
                )}
              </div>
              <p className="font-mono text-[11px] text-muted-foreground">
                {image
                  ? `${(bytesOf(image) / 1024).toFixed(0)} KB · embedded in the metadata`
                  : "No image — the agent will generate a placeholder."}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-xs tracking-[0.06em] text-muted-foreground uppercase">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={busy}
              className="w-full border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:border-primary focus-visible:outline-none"
              placeholder="Sunset Withdrawn From Service"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-xs tracking-[0.06em] text-muted-foreground uppercase">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
              disabled={busy}
              className="w-full resize-y border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:border-primary focus-visible:outline-none"
              placeholder="What is this NFT? Nobody knows. That is the point."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-xs tracking-[0.06em] text-muted-foreground uppercase">
              Metadata / traits
            </label>
            {traits.map((t, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={t.trait_type}
                  onChange={(e) => setTrait(i, "trait_type", e.target.value)}
                  placeholder="trait"
                  disabled={busy}
                  className="w-1/3 border border-input bg-background px-2 py-1.5 font-mono text-xs focus-visible:border-primary focus-visible:outline-none"
                />
                <input
                  value={t.value}
                  onChange={(e) => setTrait(i, "value", e.target.value)}
                  placeholder="value"
                  disabled={busy}
                  className="flex-1 border border-input bg-background px-2 py-1.5 font-mono text-xs focus-visible:border-primary focus-visible:outline-none"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Remove trait"
                  onClick={() =>
                    setTraits((prev) =>
                      prev.length === 1
                        ? [{ trait_type: "", value: "" }]
                        : prev.filter((_, j) => j !== i),
                    )
                  }
                  disabled={busy}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() =>
                setTraits((prev) => [...prev, { trait_type: "", value: "" }])
              }
              disabled={busy}
            >
              <Plus /> Add trait
            </Button>
          </div>

          {/* The review step: exactly what will go on-chain. */}
          {reviewing && (
            <div className="flex flex-col gap-1 border border-dashed p-3 font-mono text-xs">
              <p className="tracking-[0.06em] text-muted-foreground uppercase">
                On-chain metadata
              </p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-foreground">
                {JSON.stringify(
                  {
                    name,
                    description,
                    image: image ? `<${bytesOf(image)} KB image>` : "<generated placeholder>",
                    attributes: traits.filter((t) => t.trait_type.trim()),
                  },
                  null,
                  2,
                )}
              </pre>
              <p className="text-muted-foreground">
                To: {live.recipient}
              </p>
            </div>
          )}

          {error && (
            <p className="flex items-start gap-2 bg-destructive/10 p-2 text-xs text-destructive">
              <X className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {reviewing ? (
              <Button
                onClick={mintNow}
                disabled={busy || !name.trim()}
                className="font-mono tracking-wider uppercase"
              >
                {busy ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Check strokeWidth={3} />
                )}
                Mint NFT
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => setReviewing(true)}
                disabled={busy}
                className="font-mono tracking-wider uppercase"
              >
                Review
              </Button>
            )}
            <Button
              variant="outline"
              onClick={cancel}
              disabled={busy}
              className="font-mono tracking-wider uppercase"
            >
              <X /> Cancel
            </Button>
          </div>
        </div>
      )}

      {minted.reason && (
        <p className="font-mono text-xs text-muted-foreground">{minted.reason}</p>
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
      <span className="w-14 shrink-0 text-xs tracking-[0.06em] text-muted-foreground uppercase">
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
