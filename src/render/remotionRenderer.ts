import type { Renderer } from "./agent.js";

/** Placeholder until the Remotion compositions land; selecting RENDERER=remotion before then fails loudly rather than silently falling back. */
export const remotionRenderer: Renderer = async () => {
  throw new Error("RENDERER=remotion selected but the Remotion renderer is not implemented yet; use RENDERER=ffmpeg");
};
