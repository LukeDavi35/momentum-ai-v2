import type { FootageProviderId } from "../config/index.js";

/** The only licences footage may be used under. Anything else (unknown, NC, ND, share-alike, "fair use") is rejected. */
export type LicenseId = "cc0" | "public_domain" | "cc_by" | "pexels" | "owned";

export interface FootageClip {
  provider: FootageProviderId;
  /** Provider's own id; (provider, externalId) is the clip's identity. */
  externalId: string;
  title: string;
  pageUrl: string;
  /** null for the local library (the file is already on disk). */
  downloadUrl: string | null;
  /** Library clips only: where the file already is. */
  localPath?: string;
  license: LicenseId;
  /** The licence exactly as the provider states it, for the audit trail. */
  licenseLabel: string;
  author: string;
  attributionRequired: boolean;
  durationS: number;
  width: number;
  height: number;
}

/** A clip that has been downloaded and checked; this is what gets stored in the script and rendered. */
export interface FootageRef extends FootageClip {
  localPath: string;
  /** The on-video / in-caption credit line for this clip. */
  credit: string;
}

export interface FootageContext {
  fetchImpl: typeof fetch;
  pexelsKey?: string;
  dataDir: string;
  userAgent: string;
}

export interface FootageProvider {
  id: FootageProviderId;
  /** Returns licence-classified candidates for a free-text query. May throw; the caller treats that as "no result from this provider". */
  search(query: string, ctx: FootageContext): Promise<FootageClip[]>;
}

export const clipKey = (c: Pick<FootageClip, "provider" | "externalId">): string => `${c.provider}:${c.externalId}`;
