import type { LicenseId } from "./types.js";

export interface LicenseVerdict {
  id: LicenseId;
  attributionRequired: boolean;
}

/**
 * Maps a provider's licence label to one we accept, or null.
 *
 * Accepted: CC0, public domain, CC BY (any version), the Pexels licence, and licences the owner states for their own
 * library. Rejected on purpose: NC (the account may be monetised), ND (a compilation edits the clip), SA (a share-alike
 * clip would pull the whole video under its licence), GFDL, "fair use", all-rights-reserved and anything unrecognised —
 * a missing or odd label means we don't know, and not knowing is a no.
 */
export function classifyLicense(label: string | null | undefined): LicenseVerdict | null {
  const l = (label ?? "").trim().toLowerCase();
  if (!l) return null;
  if (/\b(all rights reserved|fair use|gfdl|unknown|unspecified)\b/.test(l)) return null;

  const cc = l.match(/^cc[- ]?(zero|0|by)(.*)$/);
  if (cc) {
    if (cc[1] === "zero" || cc[1] === "0") return { id: "cc0", attributionRequired: false };
    // "CC BY 4.0" is fine; "CC BY-SA 4.0", "CC BY-NC 2.0", "CC BY-ND 3.0" are not
    if (/(^|[-\s])(nc|nd|sa)\b/.test(cc[2]!)) return null;
    return { id: "cc_by", attributionRequired: true };
  }
  if (/^public domain|^pd([-\s]|$)|\bpdm\b|public domain mark/.test(l) && !/\bnot\b/.test(l)) return { id: "public_domain", attributionRequired: false };
  if (/^pexels( license)?$/.test(l)) return { id: "pexels", attributionRequired: false };
  if (l === "owned" || l === "licensed") return { id: "owned", attributionRequired: false };
  return null;
}
