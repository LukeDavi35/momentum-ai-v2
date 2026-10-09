import { Composition } from "remotion";
import { Momentum } from "./Momentum";
import type { MomentumProps } from "./types";

const defaults: MomentumProps = {
  template: "news_flash",
  durationS: 20,
  fps: 30,
  theme: { label: "NEWS FLASH", c0: "#0b1736", c1: "#1d4ed8", accent: "#ffe500" },
  headline: "Headline goes here",
  stat: null,
  statLabel: null,
  items: ["First point", "Second point", "Third point"],
  itemTimes: [2, 6, 10],
  cards: [],
  statAt: 2,
};

export const Root = () => (
  <Composition
    id="Momentum"
    component={Momentum}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={600}
    defaultProps={defaults}
    // the real length comes from the voiceover: duration is a prop, not a constant
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(30, Math.round(props.durationS * props.fps)), fps: props.fps })}
  />
);
