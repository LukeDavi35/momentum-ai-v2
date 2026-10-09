import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/index.js";

export type MediaKind = "video" | "cover";

function sign(secret: string, contentId: string, regen: number, kind: MediaKind, exp: number): string {
  return createHmac("sha256", secret).update(`${contentId}.${regen}.${kind}.${exp}`).digest("hex");
}

/** Time-limited, HMAC-signed public URL (Instagram must fetch the video; nothing else is exposed). */
export function signedMediaUrl(cfg: AppConfig, contentId: string, regen: number, kind: MediaKind, ttlMs = 6 * 3600_000, now = Date.now()): string | undefined {
  const { PUBLIC_BASE_URL: base, MEDIA_SIGNING_SECRET: secret } = cfg.env;
  if (!base || !secret) return undefined;
  const exp = now + ttlMs;
  const ext = kind === "video" ? "mp4" : "jpg";
  return `${base.replace(/\/$/, "")}/media/${contentId}/${regen}/${kind}.${ext}?exp=${exp}&sig=${sign(secret, contentId, regen, kind, exp)}`;
}

export function verifyMediaSignature(cfg: AppConfig, contentId: string, regen: number, kind: MediaKind, exp: number, sig: string, now = Date.now()): boolean {
  const secret = cfg.env.MEDIA_SIGNING_SECRET;
  if (!secret || !Number.isFinite(exp) || exp < now) return false;
  const want = Buffer.from(sign(secret, contentId, regen, kind, exp), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}
