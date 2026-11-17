import type { Platform } from "../config/index.js";

export interface FetchedComment {
  externalId: string;
  author: string;
  authorId: string;
  text: string;
  postedAt: Date | null;
}

/**
 * Deliberately separate from Publisher (src/publish/types.ts), which stays untouched. Not every
 * platform implements this: TikTok's and X's APIs have no comment access, so neither gets one.
 */
export interface CommentSource {
  readonly platform: Platform;
  readonly supportsHide: boolean;
  /** Top-level comments on a published post, newest-first is not required - the caller dedupes by (platform, externalId). */
  fetchComments(externalId: string): Promise<FetchedComment[]>;
  /** Returns the new reply's external id. */
  reply(commentId: string, text: string): Promise<string>;
  hide(commentId: string): Promise<void>;
}
