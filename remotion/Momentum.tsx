import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { MomentumProps } from "./types";

const FONT = "'DejaVu Sans', 'Helvetica Neue', Arial, sans-serif";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Animated gradient + drifting translucent orbs: depth without any stock footage. */
const Background = ({ c0, c1 }: { c0: string; c1: string }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = frame / durationInFrames;
  const angle = 155 + 25 * Math.sin(t * Math.PI * 2);
  const orb = (i: number, size: number, hueShift: number) => {
    const x = 50 + 38 * Math.sin(t * Math.PI * 2 + i * 2.1);
    const y = 30 + 28 * Math.cos(t * Math.PI * 2 * 0.8 + i * 1.7);
    return <div key={i} style={{ position: "absolute", left: `${x}%`, top: `${y + i * 22}%`, width: size, height: size, borderRadius: "50%", background: `radial-gradient(circle, rgba(255,255,255,${0.16 - i * 0.03}) 0%, rgba(255,255,255,0) 70%)`, transform: `translate(-50%, -50%) scale(${1 + hueShift * Math.sin(t * 6 + i)})` }} />;
  };
  return (
    <AbsoluteFill style={{ background: `linear-gradient(${angle}deg, ${c0}, ${c1})` }}>
      {orb(0, 900, 0.06)}
      {orb(1, 700, 0.08)}
      {orb(2, 520, 0.1)}
      <AbsoluteFill style={{ background: "repeating-linear-gradient(115deg, rgba(255,255,255,0.025) 0 2px, transparent 2px 46px)" }} />
    </AbsoluteFill>
  );
};

const Pop = ({ at, children, style }: { at: number; children: React.ReactNode; style?: React.CSSProperties }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - Math.round(at * fps), fps, config: { damping: 14, stiffness: 120, mass: 0.7 } });
  const visible = frame >= Math.round(at * fps);
  return <div style={{ opacity: visible ? interpolate(s, [0, 0.4], [0, 1], clamp) : 0, transform: `translateY(${(1 - s) * 50}px) scale(${0.92 + 0.08 * s})`, ...style }}>{children}</div>;
};

export const Momentum = (p: MomentumProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;
  const headlineIn = spring({ frame, fps, config: { damping: 16, stiffness: 100 } });
  const showStat = p.template === "stat_spotlight" && p.stat;

  return (
    <AbsoluteFill style={{ fontFamily: FONT, color: "#fff" }}>
      <Background c0={p.theme.c0} c1={p.theme.c1} />

      <div style={{ position: "absolute", top: 70, left: 70, right: 70, display: "flex", justifyContent: "space-between", fontSize: 38, fontWeight: 700, letterSpacing: 6 }}>
        <span style={{ color: p.theme.accent }}>MOMENTUM</span>
        <span>{p.theme.label}</span>
      </div>

      <div style={{ position: "absolute", top: 190, left: 80, right: 80, textAlign: "center", fontSize: 88, fontWeight: 800, lineHeight: 1.1, textShadow: "0 6px 24px rgba(0,0,0,0.45)", opacity: headlineIn, transform: `translateY(${(1 - headlineIn) * -40}px)` }}>
        {p.headline}
        <div style={{ margin: "26px auto 0", width: interpolate(headlineIn, [0, 1], [0, 220], clamp), height: 10, borderRadius: 5, background: p.theme.accent }} />
      </div>

      {showStat && (
        <div style={{ position: "absolute", top: 640, left: 0, right: 0, textAlign: "center" }}>
          <Pop at={p.statAt}>
            <div style={{ fontSize: 250, fontWeight: 900, color: p.theme.accent, lineHeight: 1, textShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>{p.stat}</div>
          </Pop>
          {p.statLabel && (
            <Pop at={p.statAt + 0.25}>
              <div style={{ marginTop: 34, fontSize: 60, fontWeight: 700, padding: "0 110px", textShadow: "0 4px 18px rgba(0,0,0,0.5)" }}>{p.statLabel}</div>
            </Pop>
          )}
        </div>
      )}

      {!showStat && p.items.length > 0 && (
        <div style={{ position: "absolute", top: 640, left: 80, right: 80, display: "flex", flexDirection: "column", gap: 34 }}>
          {p.items.map((item, i) => (
            <Pop key={i} at={p.itemTimes[i] ?? 2 + i * 2.5}>
              <div style={{ display: "flex", alignItems: "center", gap: 28, padding: "30px 36px", borderRadius: 28, background: "rgba(255,255,255,0.14)", border: "2px solid rgba(255,255,255,0.22)", backdropFilter: "blur(6px)" }}>
                <div style={{ flex: "0 0 84px", height: 84, borderRadius: 42, background: p.theme.accent, color: "#101418", fontSize: 50, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</div>
                <div style={{ fontSize: 56, fontWeight: 700, lineHeight: 1.15 }}>{item}</div>
              </div>
            </Pop>
          ))}
        </div>
      )}

      {!showStat && p.items.length === 0 && p.cards.map((c, i) => sec >= c.start && sec <= c.end + 0.2 && (
        <div key={i} style={{ position: "absolute", top: 760, left: 90, right: 90, textAlign: "center" }}>
          <Pop at={c.start}><div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.15, padding: "40px 50px", borderRadius: 36, background: "rgba(0,0,0,0.28)", border: "2px solid rgba(255,255,255,0.2)" }}>{c.text}</div></Pop>
        </div>
      ))}

      <div style={{ position: "absolute", bottom: 70, left: 70, fontSize: 30, opacity: 0.6, letterSpacing: 2 }}>AI-assisted video · synthetic voice</div>
    </AbsoluteFill>
  );
};
