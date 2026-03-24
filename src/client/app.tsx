import {
  AnimatePresence,
  motion,
  useReducedMotion
} from "motion/react";
import {
  startTransition,
  useEffect,
  useRef,
  useState
} from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import {
  bootstrapResponseSchema,
  clientEventSchema,
  createRoomResponseSchema,
  roomIdSchema,
  serverEventSchema,
  type ClientEvent,
  type RoomState,
  type SeatId
} from "@shared/protocol";
import {
  type BannerCelebration,
  type BannerTone,
  type ConnectionState,
  useRoomStore
} from "@client/store";
import { useRoomCardSounds } from "@client/card-sound";

type RouteState =
  | {
      kind: "landing";
    }
  | {
      kind: "room";
      roomId: string;
      token: string | null;
    };

const ROOM_TOKEN_STORAGE_PREFIX = "quiet-signal:room-token:";

function roomTokenStorageKey(roomId: string): string {
  return `${ROOM_TOKEN_STORAGE_PREFIX}${roomId}`;
}

function readStoredRoomToken(roomId: string): string | null {
  try {
    return window.sessionStorage.getItem(roomTokenStorageKey(roomId));
  } catch {
    return null;
  }
}

function persistRoomToken(roomId: string, token: string): void {
  try {
    window.sessionStorage.setItem(roomTokenStorageKey(roomId), token);
  } catch {
    // Ignore storage failures in private browsing modes.
  }
}

function clearStoredRoomToken(roomId: string): void {
  try {
    window.sessionStorage.removeItem(roomTokenStorageKey(roomId));
  } catch {
    // Ignore storage failures in private browsing modes.
  }
}

function parseRoute(url: URL): RouteState {
  const match = /^\/room\/([a-z0-9]+)$/u.exec(url.pathname);
  if (!match) {
    return {
      kind: "landing"
    };
  }

  const roomId = roomIdSchema.safeParse(match[1] ?? "");
  if (!roomId.success) {
    return {
      kind: "landing"
    };
  }

  return {
    kind: "room",
    roomId: roomId.data,
    token: url.hash ? url.hash.slice(1) : readStoredRoomToken(roomId.data)
  };
}

function selfAndOther(snapshot: RoomState) {
  const self = snapshot.players[snapshot.viewerSeatId];
  const otherSeatId: SeatId = snapshot.viewerSeatId === "host" ? "guest" : "host";
  return {
    self,
    other: snapshot.players[otherSeatId]
  };
}

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isImmersivePhase(phase: RoomState["phase"]): boolean {
  return phase === "focus_transition" || phase === "in_round" || phase === "paused";
}

function describeConnectionState(state: ConnectionState): string {
  switch (state) {
    case "open":
      return "Connected";
    case "bootstrapping":
    case "connecting":
      return "Connecting";
    case "reconnecting":
    case "closed":
      return "Reconnecting";
    case "error":
      return "Problem";
    case "idle":
      return "Waiting";
  }
}

function buttonClass(kind: "primary" | "secondary" | "ghost"): string {
  const base = "ui-button";
  if (kind === "primary") {
    return `${base} ui-button-primary`;
  }
  if (kind === "secondary") {
    return `${base} ui-button-secondary`;
  }
  return `${base} ui-button-ghost`;
}

function bannerToneLabel(tone: BannerTone): string {
  switch (tone) {
    case "success":
      return "Good";
    case "warning":
      return "Heads up";
    case "danger":
      return "Alert";
    case "neutral":
      return "Update";
  }
}

function bannerClass(tone: BannerTone): string {
  return classes(
    "banner-pill",
    tone === "neutral" && "banner-pill-neutral",
    tone === "success" && "banner-pill-success",
    tone === "warning" && "banner-pill-warning",
    tone === "danger" && "banner-pill-danger"
  );
}

function describeTablePhase(phase: RoomState["phase"], focusRemainingMs: number): string {
  if (phase === "focus_transition") {
    return focusRemainingMs === 0 ? "live" : "focus";
  }

  switch (phase) {
    case "waiting":
      return "lobby";
    case "between_levels":
      return "next level";
    case "in_round":
      return "live";
    case "paused":
      return "paused";
    case "won":
      return "complete";
    case "lost":
      return "over";
  }
}

function describeLevelRewards(rewards: { life: boolean; scan: boolean }): string {
  const labels: string[] = [];

  if (rewards.life) {
    labels.push("+1 life");
  }
  if (rewards.scan) {
    labels.push("+1 scan");
  }

  return labels.join(" and ");
}

function waitingOverlayBody(snapshot: RoomState): string {
  if (snapshot.inviteLink) {
    return "Share the invite link with your partner. The room opens as soon as both players join.";
  }

  return "Waiting for both players to join the room.";
}

function betweenLevelsBody(snapshot: RoomState): string {
  if (snapshot.summary?.kind === "level_cleared") {
    const rewards = describeLevelRewards(snapshot.summary.rewards);
    return rewards
      ? `${snapshot.summary.message} Reward: ${rewards}. Press ready when you're both set.`
      : `${snapshot.summary.message} Press ready when you're both set.`;
  }

  return "Press ready when you're both set for the next level.";
}

type BannerBurstPiece = {
  color: string;
  delayMs: number;
  durationMs: number;
  height: string;
  originX: string;
  originY: string;
  radius: string;
  rotate: string;
  width: string;
  x: string;
  y: string;
};

const levelClearBurst: BannerBurstPiece[] = [
  {
    color: "var(--accent)",
    delayMs: 0,
    durationMs: 980,
    height: "0.9rem",
    originX: "48%",
    originY: "52%",
    radius: "999px",
    rotate: "-48deg",
    width: "0.9rem",
    x: "-7.6rem",
    y: "-3.1rem"
  },
  {
    color: "var(--card-front)",
    delayMs: 30,
    durationMs: 920,
    height: "0.34rem",
    originX: "49%",
    originY: "50%",
    radius: "999px",
    rotate: "26deg",
    width: "0.34rem",
    x: "-5.8rem",
    y: "-4.3rem"
  },
  {
    color: "var(--signal)",
    delayMs: 20,
    durationMs: 1040,
    height: "1rem",
    originX: "50%",
    originY: "51%",
    radius: "999px",
    rotate: "34deg",
    width: "0.26rem",
    x: "-2.7rem",
    y: "-4.9rem"
  },
  {
    color: "var(--accent-soft)",
    delayMs: 50,
    durationMs: 1080,
    height: "0.92rem",
    originX: "50%",
    originY: "52%",
    radius: "0.16rem",
    rotate: "-12deg",
    width: "0.28rem",
    x: "-0.8rem",
    y: "-5.7rem"
  },
  {
    color: "var(--signal-soft)",
    delayMs: 0,
    durationMs: 1100,
    height: "0.4rem",
    originX: "51%",
    originY: "51%",
    radius: "999px",
    rotate: "48deg",
    width: "0.4rem",
    x: "2.4rem",
    y: "-5rem"
  },
  {
    color: "var(--accent)",
    delayMs: 60,
    durationMs: 1020,
    height: "0.98rem",
    originX: "50%",
    originY: "52%",
    radius: "0.18rem",
    rotate: "52deg",
    width: "0.28rem",
    x: "5.6rem",
    y: "-3.7rem"
  },
  {
    color: "var(--card-front)",
    delayMs: 35,
    durationMs: 980,
    height: "0.34rem",
    originX: "52%",
    originY: "51%",
    radius: "999px",
    rotate: "-18deg",
    width: "0.34rem",
    x: "7.5rem",
    y: "-2.2rem"
  },
  {
    color: "var(--signal)",
    delayMs: 15,
    durationMs: 960,
    height: "0.96rem",
    originX: "48%",
    originY: "53%",
    radius: "0.16rem",
    rotate: "-68deg",
    width: "0.26rem",
    x: "-6.8rem",
    y: "1.9rem"
  },
  {
    color: "var(--accent-soft)",
    delayMs: 45,
    durationMs: 990,
    height: "0.3rem",
    originX: "49%",
    originY: "54%",
    radius: "999px",
    rotate: "20deg",
    width: "0.3rem",
    x: "-3.7rem",
    y: "3rem"
  },
  {
    color: "var(--signal-soft)",
    delayMs: 20,
    durationMs: 1040,
    height: "0.96rem",
    originX: "51%",
    originY: "54%",
    radius: "0.16rem",
    rotate: "22deg",
    width: "0.26rem",
    x: "0.6rem",
    y: "3.4rem"
  },
  {
    color: "var(--card-front)",
    delayMs: 55,
    durationMs: 1060,
    height: "0.34rem",
    originX: "52%",
    originY: "53%",
    radius: "999px",
    rotate: "-32deg",
    width: "0.34rem",
    x: "4.8rem",
    y: "2.6rem"
  },
  {
    color: "var(--accent)",
    delayMs: 25,
    durationMs: 1080,
    height: "0.92rem",
    originX: "51%",
    originY: "52%",
    radius: "0.18rem",
    rotate: "68deg",
    width: "0.28rem",
    x: "7.2rem",
    y: "1.3rem"
  }
];

const runCompleteBurst: BannerBurstPiece[] = [
  ...levelClearBurst,
  {
    color: "var(--accent)",
    delayMs: 85,
    durationMs: 1160,
    height: "1.04rem",
    originX: "50%",
    originY: "50%",
    radius: "0.16rem",
    rotate: "-82deg",
    width: "0.28rem",
    x: "-9rem",
    y: "-0.8rem"
  },
  {
    color: "var(--signal-soft)",
    delayMs: 75,
    durationMs: 1180,
    height: "0.44rem",
    originX: "50%",
    originY: "50%",
    radius: "999px",
    rotate: "10deg",
    width: "0.44rem",
    x: "0.2rem",
    y: "-6.4rem"
  },
  {
    color: "var(--card-front)",
    delayMs: 95,
    durationMs: 1150,
    height: "0.98rem",
    originX: "50%",
    originY: "50%",
    radius: "0.16rem",
    rotate: "84deg",
    width: "0.28rem",
    x: "8.8rem",
    y: "-1.1rem"
  },
  {
    color: "var(--signal)",
    delayMs: 70,
    durationMs: 1120,
    height: "0.98rem",
    originX: "50%",
    originY: "52%",
    radius: "999px",
    rotate: "-12deg",
    width: "0.34rem",
    x: "-0.3rem",
    y: "4.1rem"
  }
];

function BannerCelebrationBurst(props: {
  kind: Exclude<BannerCelebration, null>;
  reducedMotion: boolean;
}) {
  if (props.reducedMotion) {
    return null;
  }

  const pieces = props.kind === "run_complete" ? runCompleteBurst : levelClearBurst;

  return (
    <span
      aria-hidden="true"
      className={classes(
        "banner-confetti",
        props.kind === "run_complete" && "banner-confetti-grand"
      )}
    >
      {pieces.map((piece, index) => {
        const style = {
          "--particle-color": piece.color,
          "--particle-delay": `${piece.delayMs}ms`,
          "--particle-duration": `${piece.durationMs}ms`,
          "--particle-height": piece.height,
          "--particle-origin-x": piece.originX,
          "--particle-origin-y": piece.originY,
          "--particle-radius": piece.radius,
          "--particle-rotate": piece.rotate,
          "--particle-width": piece.width,
          "--particle-x": piece.x,
          "--particle-y": piece.y
        } as CSSProperties;

        return <span className="banner-confetti-piece" key={`${props.kind}-${index}`} style={style} />;
      })}
    </span>
  );
}

function connectionPillClass(state: ConnectionState): string {
  return classes(
    "status-pill rounded-full px-3 py-2 text-sm font-semibold capitalize",
    state === "open" && "status-pill-open",
    state === "error" && "status-pill-error"
  );
}

function statPillClass(tone: "danger" | "warning"): string {
  return classes(
    "metric-pill rounded-full px-3 py-2 text-sm",
    tone === "danger" && "metric-pill-danger",
    tone === "warning" && "metric-pill-warning"
  );
}

function updateLiveCardPointer(event: ReactPointerEvent<HTMLElement>): void {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width;
  const y = (event.clientY - bounds.top) / bounds.height;
  const rotateY = (x - 0.5) * 12;
  const rotateX = (0.5 - y) * 14;

  event.currentTarget.style.setProperty("--signal-card-rotate-x", `${rotateX.toFixed(2)}deg`);
  event.currentTarget.style.setProperty("--signal-card-rotate-y", `${rotateY.toFixed(2)}deg`);
  event.currentTarget.style.setProperty("--signal-card-glow-x", `${(x * 100).toFixed(1)}%`);
  event.currentTarget.style.setProperty("--signal-card-glow-y", `${(y * 100).toFixed(1)}%`);
}

function resetLiveCardPointer(event: ReactPointerEvent<HTMLElement>): void {
  event.currentTarget.style.removeProperty("--signal-card-rotate-x");
  event.currentTarget.style.removeProperty("--signal-card-rotate-y");
  event.currentTarget.style.removeProperty("--signal-card-glow-x");
  event.currentTarget.style.removeProperty("--signal-card-glow-y");
}

function useHandFanLayout(measureRef: RefObject<HTMLDivElement | null>, cardCount: number) {
  const [availableWidth, setAvailableWidth] = useState(640);

  useEffect(() => {
    const element = measureRef.current;
    if (!element) {
      return undefined;
    }

    const updateWidth = () => {
      setAvailableWidth(element.getBoundingClientRect().width);
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [measureRef]);

  const compact = availableWidth < 560;
  const usableWidth = Math.max(availableWidth - (compact ? 10 : 16), 0);
  const maxCardWidth = compact ? 96 : 104;
  const minCardWidth = compact ? 60 : 68;
  const preferredVisibleStep = compact ? 20 : 26;
  const relaxedGap = compact ? 10 : 14;
  const overlapCount = Math.max(cardCount - 1, 0);
  const cardWidth =
    cardCount <= 1
      ? maxCardWidth
      : clampNumber(
          Math.round(usableWidth - preferredVisibleStep * overlapCount),
          minCardWidth,
          maxCardWidth
        );
  const fittedStep =
    cardCount <= 1
      ? cardWidth
      : Math.max(0, Math.min(cardWidth + relaxedGap, (usableWidth - cardWidth) / overlapCount));
  const cardHeight = Math.round(cardWidth * (compact ? 1.34 : 1.38));
  const totalWidth = cardCount === 0 ? 0 : cardWidth + fittedStep * overlapCount;
  const valueFontSize = clampNumber(
    Math.round(cardWidth * (compact ? 0.44 : 0.42)),
    compact ? 24 : 28,
    compact ? 42 : 54
  );
  const cornerValueFontSize = clampNumber(
    Math.round(cardWidth * (compact ? 0.28 : 0.24)),
    compact ? 15 : 16,
    compact ? 21 : 22
  );
  const useInsetValues = fittedStep < cardWidth * 0.78;

  return {
    cardWidth,
    cardHeight,
    totalWidth,
    valueFontSize,
    cornerValueFontSize,
    step: fittedStep,
    useInsetValues
  };
}

const revealEase = [0.22, 1, 0.36, 1] as const;
const layoutSpring = {
  type: "spring",
  stiffness: 320,
  damping: 30,
  mass: 0.82
} as const;

function revealMotion(
  reducedMotion: boolean,
  options: {
    delay?: number;
    duration?: number;
    x?: number;
    y?: number;
  } = {}
) {
  if (reducedMotion) {
    return {};
  }

  return {
    initial: {
      opacity: 0,
      x: options.x ?? 0,
      y: options.y ?? 18
    },
    animate: {
      opacity: 1,
      x: 0,
      y: 0
    },
    transition: {
      duration: options.duration ?? 0.56,
      delay: options.delay ?? 0,
      ease: revealEase
    }
  };
}

async function readJsonOrThrow(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error("Empty response.");
  }
  return JSON.parse(text);
}

export function App() {
  const [route, setRoute] = useState<RouteState>(() => parseRoute(new URL(window.location.href)));

  useEffect(() => {
    const handleLocation = () => {
      setRoute(parseRoute(new URL(window.location.href)));
    };
    window.addEventListener("popstate", handleLocation);
    window.addEventListener("hashchange", handleLocation);
    return () => {
      window.removeEventListener("popstate", handleLocation);
      window.removeEventListener("hashchange", handleLocation);
    };
  }, []);

  useEffect(() => {
    if (route.kind !== "room" || !route.token) {
      return;
    }

    persistRoomToken(route.roomId, route.token);

    if (!window.location.hash) {
      return;
    }

    const cleanUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(window.history.state, "", cleanUrl);
  }, [route]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      useRoomStore.getState().tickRealClock();
    }, 200);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="app-shell grain-overlay min-h-screen px-4 py-6 text-stone-50 sm:px-6 lg:px-8">
      {route.kind === "landing" ? (
        <LandingScreen />
      ) : (
        <RoomScreen roomId={route.roomId} token={route.token} />
      )}
    </main>
  );
}

function LandingScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = Boolean(useReducedMotion());

  const createRoom = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      if (!response.ok) {
        throw new Error("Couldn't start the room.");
      }
      const payload = createRoomResponseSchema.parse(await readJsonOrThrow(response));
      window.location.assign(payload.hostInviteUrl);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Couldn't start the room.");
      setBusy(false);
    }
  };

  const scrollToHowToPlay = () => {
    document.getElementById("how-to-play")?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "start"
    });
  };

  return (
    <section className="mx-auto max-w-7xl pb-8">
      <div className="grid min-h-[calc(100vh-3rem)] w-full items-center gap-8 lg:grid-cols-[1.02fr_0.98fr]">
        <motion.div
          {...revealMotion(reducedMotion, {
            x: -22,
            y: 20
          })}
          className="hero-panel panel-surface rounded-[2.35rem] p-8 sm:p-10 lg:p-12"
        >
          <p className="mb-3 text-sm uppercase tracking-[0.32em] text-[var(--accent-soft)]">Quiet Signal</p>
          <h1 className="display-face max-w-3xl text-balance text-4xl font-black tracking-tight text-[var(--card-front)] sm:text-6xl">
            A private timing game for two.
          </h1>
          <p className="mt-5 max-w-xl text-balance text-lg leading-8 text-[var(--muted)]">
            Open a room. Share the link. Play in silence.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <div className="hero-note">Best while on a call</div>
            <div className="hero-note">No accounts</div>
            <div className="hero-note">Private link</div>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              className={buttonClass("primary")}
              disabled={busy}
              onClick={() => {
                void createRoom();
              }}
              type="button"
            >
              {busy ? "Opening room..." : "Open a room"}
            </button>
            <button
              className={buttonClass("secondary")}
              onClick={scrollToHowToPlay}
              type="button"
            >
              How to play
            </button>
            <div className="hero-chip rounded-full px-4 py-2 text-sm">
              2 players. Private link. Mobile + desktop.
            </div>
          </div>
          <div className="mt-10 flex flex-wrap gap-2">
            <StepPill label="1. Open room" />
            <StepPill label="2. Share link" />
            <StepPill label="3. Play" />
          </div>
          <HeroGuideCue
            onClick={scrollToHowToPlay}
            reducedMotion={reducedMotion}
          />
          {error ? (
            <p className="mt-4 text-sm text-[var(--danger)]">{error}</p>
          ) : null}
        </motion.div>

        <LandingTablePreview />
      </div>
      <HowToPlaySection />
    </section>
  );
}

function StepPill(props: { label: string }) {
  return (
    <div className="step-pill rounded-full px-4 py-2 text-sm">
      {props.label}
    </div>
  );
}

function HeroGuideCue(props: { reducedMotion: boolean; onClick: () => void }) {
  return (
    <button
      className="hero-guide-cue mt-8 w-full rounded-[1.35rem] px-4 py-4 text-left sm:px-5"
      onClick={props.onClick}
      type="button"
    >
      <div className="hero-guide-cue-copy">
        <p className="hero-guide-cue-kicker">New here?</p>
        <p className="hero-guide-cue-title">Read how to play below</p>
        <p className="hero-guide-cue-body">Quick rules and live examples before you open a room.</p>
      </div>
      <motion.span
        animate={props.reducedMotion ? undefined : { y: [0, 5, 0] }}
        aria-hidden="true"
        className="hero-guide-cue-arrow"
        transition={props.reducedMotion ? undefined : {
          duration: 1.7,
          ease: "easeInOut",
          repeat: Number.POSITIVE_INFINITY
        }}
      >
        ↓
      </motion.span>
    </button>
  );
}

function LandingTablePreview() {
  const reducedMotion = Boolean(useReducedMotion());

  return (
    <motion.aside
      {...revealMotion(reducedMotion, {
        delay: 0.08,
        x: 24,
        y: 20
      })}
      className="landing-stage relative overflow-hidden rounded-[2.35rem] p-6 sm:p-8"
    >
      <div className="landing-stage-stars absolute inset-0" />
      <div className="relative flex h-full min-h-[28rem] flex-col gap-5">
        <div className="landing-rail flex items-center justify-between rounded-[1.5rem] px-4 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-[var(--accent-soft)]">Partner</p>
            <p className="mt-2 text-lg font-semibold text-[var(--card-front)]">Your partner</p>
          </div>
          <div className="flex gap-2">
            <div className="landing-card-back h-[3.9rem] w-11 rounded-[0.95rem]" />
            <div className="landing-card-back h-[3.9rem] w-11 rounded-[0.95rem]" />
            <div className="landing-card-back h-[3.9rem] w-11 rounded-[0.95rem]" />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center">
          <div className="shared-pile-stage w-full max-w-sm px-5 py-8 text-center">
            <p className="text-xs uppercase tracking-[0.3em] text-[var(--accent-soft)]">Shared pile</p>
            <div className="mt-5 flex justify-center gap-3">
              <div className="landing-face-card rotate-[-4deg]">18</div>
              <div className="landing-face-card rotate-[3deg]">42</div>
            </div>
            <p className="mt-5 text-sm leading-7 text-[var(--muted)]">
              Lowest card goes first.
            </p>
          </div>
        </div>

        <div className="live-hand-zone rounded-[1.8rem] p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-[var(--accent-soft)]">Your hand</p>
              <p className="mt-2 text-base text-[var(--muted)]">Play your lowest card.</p>
            </div>
            <div className="count-pill rounded-full px-3 py-1 text-sm">3 cards</div>
          </div>
          <div className="mt-5 flex items-end gap-3">
            <div className="landing-face-card h-28 w-20 text-3xl opacity-60">23</div>
            <div className="landing-face-card landing-face-card-featured h-32 w-24 text-4xl">31</div>
            <div className="landing-muted-card h-28 w-20 text-3xl">77</div>
          </div>
        </div>
      </div>
    </motion.aside>
  );
}

function HowToPlaySection() {
  const reducedMotion = Boolean(useReducedMotion());

  return (
    <motion.section
      {...revealMotion(reducedMotion, {
        delay: 0.12,
        duration: 0.6,
        y: 24
      })}
      id="how-to-play"
      className="how-to-panel panel-surface mt-4 rounded-[2.35rem] p-6 sm:p-8 lg:p-10"
    >
      <div className="grid gap-8 lg:grid-cols-[0.84fr_1.16fr] lg:gap-10">
        <div className="guide-intro">
          <p className="guide-kicker">How to play</p>
          <h2 className="display-face mt-3 max-w-xl text-balance text-3xl font-black text-[var(--card-front)] sm:text-5xl">
            Read this once. Then trust the timing.
          </h2>
          <p className="guide-lead mt-5 max-w-lg text-balance text-base leading-8 text-[var(--muted)] sm:text-lg">
            Each player gets a sorted hand. Once the focus cue appears, stop talking through the timing and
            play the lowest card that should come next in the shared pile.
          </p>
          <div className="mt-6 space-y-3">
            <div className="guide-note">
              <span className="guide-note-mark" />
              <span>Talk before the round, not through the round.</span>
            </div>
            <div className="guide-note">
              <span className="guide-note-mark" />
              <span>Wrong order costs the room a life.</span>
            </div>
            <div className="guide-note">
              <span className="guide-note-mark" />
              <span>Spend a scan to discard the lowest card from both hands.</span>
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <GuideCard
            body="One player opens the room and sends the private invite link. The round setup begins as soon as both players arrive."
            demo={<InviteFlowDemo reducedMotion={reducedMotion} />}
            foot="No accounts. No lobby code to type."
            kicker="1. Join"
            title="Open the room and share the link."
          />
          <GuideCard
            body="When the focus cue appears, get quiet. That short pause is where both players settle into the same rhythm."
            demo={<FocusDemo reducedMotion={reducedMotion} />}
            foot="Silence during the round is the whole point."
            kicker="2. Focus"
            title="Start together, then stop talking."
          />
          <GuideCard
            body="Your hand is already sorted. Only your lowest card matters. Play it when it feels like the next number in the sequence."
            demo={<LowestCardDemo reducedMotion={reducedMotion} />}
            foot="Clear every card in both hands to finish the level."
            kicker="3. Play"
            title="Always play your lowest card."
          />
          <GuideCard
            body="If a lower hidden card should have gone first, the room loses a life. When both players feel stuck, spend a scan for a reset."
            demo={<RiskAndScanDemo reducedMotion={reducedMotion} />}
            foot="A scan discards the lowest card from each hand."
            kicker="4. Recover"
            title="Protect lives. Use scans when the rhythm slips."
          />
        </div>
      </div>

      <div className="guide-rule-strip mt-8 flex flex-wrap gap-2">
        <div className="guide-rule-chip">Clear every card to advance.</div>
        <div className="guide-rule-chip">Finish level 12 to win the full run.</div>
        <div className="guide-rule-chip">Best played while on a call, but keep the round itself silent.</div>
      </div>
    </motion.section>
  );
}

function GuideCard(props: {
  kicker: string;
  title: string;
  body: string;
  foot: string;
  demo: ReactNode;
}) {
  return (
    <article className="guide-card rounded-[1.6rem] p-4 sm:p-5">
      <div className="guide-demo-stage rounded-[1.35rem] p-4">
        {props.demo}
      </div>
      <div className="mt-5">
        <p className="guide-card-kicker">{props.kicker}</p>
        <h3 className="mt-3 text-balance text-xl font-semibold text-[var(--card-front)]">{props.title}</h3>
        <p className="guide-card-body mt-3 text-sm leading-7 text-[var(--muted)]">{props.body}</p>
        <p className="guide-card-foot mt-4 text-sm text-[var(--muted-strong)]">{props.foot}</p>
      </div>
    </article>
  );
}

function InviteFlowDemo(props: { reducedMotion: boolean }) {
  return (
    <div className="guide-demo invite-demo">
      <div className="guide-demo-rail">
        <span className="guide-demo-rail-label">You</span>
        <div className="guide-demo-stack">
          <span className="guide-mini-back-card" />
          <span className="guide-mini-back-card" />
        </div>
      </div>
      <motion.div
        animate={props.reducedMotion ? undefined : { opacity: [0.72, 1, 0.72], scale: [0.98, 1.03, 0.98] }}
        className="guide-link-pill"
        transition={props.reducedMotion ? undefined : {
          duration: 2.6,
          ease: "easeInOut",
          repeat: Number.POSITIVE_INFINITY
        }}
      >
        Invite link
      </motion.div>
      <div className="guide-demo-rail guide-demo-rail-right">
        <div className="guide-demo-stack">
          <span className="guide-mini-back-card" />
          <span className="guide-mini-back-card" />
        </div>
        <span className="guide-demo-rail-label">Partner</span>
      </div>
      <motion.span
        animate={props.reducedMotion ? undefined : { opacity: [0.18, 1, 0.18], scale: [0.84, 1.08, 0.84], x: [-44, 44, -44] }}
        className="guide-transfer-dot"
        transition={props.reducedMotion ? undefined : {
          duration: 2.8,
          ease: "easeInOut",
          repeat: Number.POSITIVE_INFINITY
        }}
      />
    </div>
  );
}

function FocusDemo(props: { reducedMotion: boolean }) {
  return (
    <div className="guide-demo focus-demo">
      <div className="guide-demo-chip">Focus</div>
      <motion.div
        animate={props.reducedMotion ? undefined : { scale: [0.94, 1.05, 0.94] }}
        className="guide-focus-ring"
        transition={props.reducedMotion ? undefined : {
          duration: 2.4,
          ease: "easeInOut",
          repeat: Number.POSITIVE_INFINITY
        }}
      >
        <motion.div
          animate={props.reducedMotion ? undefined : { opacity: [0.72, 1, 0.72], scale: [0.96, 1.02, 0.96] }}
          className="guide-focus-core"
          transition={props.reducedMotion ? undefined : {
            duration: 2.2,
            ease: "easeInOut",
            repeat: Number.POSITIVE_INFINITY
          }}
        />
      </motion.div>
      <div className="guide-demo-count">2s</div>
      <p className="guide-demo-label">No talking through the timing.</p>
    </div>
  );
}

function LowestCardDemo(props: { reducedMotion: boolean }) {
  return (
    <div className="guide-demo lowest-card-demo">
      <div className="guide-play-slot">
        <motion.div
          animate={props.reducedMotion ? undefined : { opacity: [0, 0, 1, 1, 0], scale: [0.95, 0.95, 1, 1, 0.95], y: [6, 6, 0, 0, 0] }}
          className="guide-mini-face-card guide-play-landed"
          transition={props.reducedMotion ? undefined : {
            duration: 3.2,
            ease: "easeInOut",
            repeat: Number.POSITIVE_INFINITY,
            times: [0, 0.24, 0.38, 0.82, 1]
          }}
        >
          23
        </motion.div>
      </div>
      <motion.div
        animate={props.reducedMotion ? undefined : { opacity: [0.18, 0.34, 0.18] }}
        className="guide-play-path"
        transition={props.reducedMotion ? undefined : {
          duration: 2.6,
          ease: "easeInOut",
          repeat: Number.POSITIVE_INFINITY
        }}
      />
      <div className="guide-play-hand">
        <motion.div
          animate={props.reducedMotion ? undefined : {
            x: [0, 0, 58, 58, 0],
            y: [0, 0, -82, -82, 0],
            opacity: [1, 1, 1, 0, 0],
            scale: [1, 1, 0.98, 0.98, 1]
          }}
          className="guide-mini-face-card guide-play-moving"
          transition={props.reducedMotion ? undefined : {
            duration: 3.2,
            ease: "easeInOut",
            repeat: Number.POSITIVE_INFINITY,
            times: [0, 0.24, 0.38, 0.82, 1]
          }}
        >
          23
        </motion.div>
        <div className="guide-mini-face-card guide-mini-face-card-muted">31</div>
        <div className="guide-mini-face-card guide-mini-face-card-muted">77</div>
      </div>
    </div>
  );
}

function RiskAndScanDemo(props: { reducedMotion: boolean }) {
  return (
    <div className="guide-demo risk-demo">
      <div className="guide-risk-status">
        <motion.span
          animate={props.reducedMotion ? undefined : { opacity: [0.54, 1, 0.54] }}
          className="guide-risk-pill guide-risk-pill-danger"
          transition={props.reducedMotion ? undefined : {
            duration: 2.2,
            ease: "easeInOut",
            repeat: Number.POSITIVE_INFINITY
          }}
        >
          -1 life
        </motion.span>
        <span className="guide-risk-pill guide-risk-pill-scan">1 scan</span>
      </div>
      <div className="guide-risk-lanes">
        <div className="guide-risk-hand guide-risk-hand-left">
          <span className="guide-mini-back-card guide-mini-back-card-faint" />
          <motion.div
            animate={props.reducedMotion ? undefined : { x: [0, 0, 44, 44, 0], y: [0, 0, 20, 20, 0], opacity: [1, 1, 1, 0, 0] }}
            className="guide-mini-face-card guide-risk-move-left"
            transition={props.reducedMotion ? undefined : {
              duration: 3.1,
              ease: "easeInOut",
              repeat: Number.POSITIVE_INFINITY,
              times: [0, 0.22, 0.4, 0.8, 1]
            }}
          >
            14
          </motion.div>
        </div>
        <div className="guide-risk-center">
          <motion.div
            animate={props.reducedMotion ? undefined : { scale: [0.92, 1.06, 0.92], opacity: [0.62, 1, 0.62] }}
            className="guide-scan-flare"
            transition={props.reducedMotion ? undefined : {
              duration: 2.4,
              ease: "easeInOut",
              repeat: Number.POSITIVE_INFINITY
            }}
          />
        </div>
        <div className="guide-risk-hand guide-risk-hand-right">
          <motion.div
            animate={props.reducedMotion ? undefined : { x: [0, 0, -44, -44, 0], y: [0, 0, 20, 20, 0], opacity: [1, 1, 1, 0, 0] }}
            className="guide-mini-face-card guide-risk-move-right"
            transition={props.reducedMotion ? undefined : {
              duration: 3.1,
              ease: "easeInOut",
              repeat: Number.POSITIVE_INFINITY,
              times: [0, 0.22, 0.4, 0.8, 1]
            }}
          >
            19
          </motion.div>
          <span className="guide-mini-back-card guide-mini-back-card-faint" />
        </div>
      </div>
    </div>
  );
}

function CenteredMessage(props: { title: string; body: string; action?: ReactNode }) {
  const reducedMotion = Boolean(useReducedMotion());

  return (
    <section className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-3xl items-center justify-center">
      <motion.div
        {...revealMotion(reducedMotion, {
          duration: 0.48,
          y: 16
        })}
        className="panel-surface rounded-[1.8rem] p-8 text-center"
      >
        <p className="text-xs uppercase tracking-[0.34em] text-[var(--accent-soft)]">Room</p>
        <h1 className="mx-auto mt-3 max-w-[20rem] text-balance text-3xl font-black text-[var(--card-front)]">{props.title}</h1>
        <p className="mx-auto mt-4 max-w-[24rem] text-balance text-sm leading-7 text-[var(--muted)]">{props.body}</p>
        {props.action ? <div className="mt-6">{props.action}</div> : null}
      </motion.div>
    </section>
  );
}

function RoomScreen(props: { roomId: string; token: string | null }) {
  const snapshot = useRoomStore((state) => state.snapshot);
  const connectionState = useRoomStore((state) => state.connectionState);
  const error = useRoomStore((state) => state.error);
  const banner = useRoomStore((state) => state.banner);
  const clearBanner = useRoomStore((state) => state.clearBanner);
  const levelAdvanceHoldUntilMs = useRoomStore((state) => state.levelAdvanceOverlayHoldUntilMs);
  const nowMs = useRoomStore((state) => state.nowMs);
  const reducedMotion = Boolean(useReducedMotion());

  const { sendEvent, reconnectNow } = useRoomSession(props.roomId, props.token);
  const { playCardTap } = useRoomCardSounds(snapshot);

  useEffect(() => {
    if (!banner) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      clearBanner();
    }, 2400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [banner, clearBanner]);

  const players = snapshot ? selfAndOther(snapshot) : null;
  const handMeasureRef = useRef<HTMLDivElement | null>(null);
  const handLayout = useHandFanLayout(handMeasureRef, players?.self.hand.length ?? 0);
  const isHoldingLevelAdvanceOverlay =
    levelAdvanceHoldUntilMs !== null && nowMs < levelAdvanceHoldUntilMs;

  useEffect(() => {
    const requestPlayLowestCard = () => {
      playCardTap();
      sendEvent({ type: "play_lowest_card" });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!snapshot) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(target.tagName)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "f") {
        void toggleFullscreen();
        return;
      }
      if (snapshot.phase === "in_round" && event.key === " ") {
        event.preventDefault();
        requestPlayLowestCard();
        return;
      }
      if (key === "p" && snapshot.canRequestPause) {
        sendEvent({ type: "request_pause" });
        return;
      }
      if (key === "s" && snapshot.canRequestScan) {
        sendEvent({ type: "request_scan" });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [playCardTap, sendEvent, snapshot]);

  if (!props.token) {
    return (
      <CenteredMessage
        body="This invite link is incomplete. Open the full link that was shared with you."
        title="Invite Link Incomplete"
      />
    );
  }

  if (!snapshot || !players) {
    return (
      <CenteredMessage
        action={
          connectionState === "error" || connectionState === "closed" ? (
            <button className={buttonClass("primary")} onClick={() => reconnectNow()} type="button">
              Retry
            </button>
          ) : undefined
        }
        body={error ?? "Joining the room and opening the live connection."}
        title="Joining Room"
      />
    );
  }

  const { self, other } = players;
  const focusRemainingMs =
    snapshot.transitionEndsAt === null ? 0 : Math.max(0, snapshot.transitionEndsAt - nowMs);
  const lowestPlayableValue = self.hand[0] ?? null;
  const isRoundInteractive =
    snapshot.phase === "in_round" ||
    (snapshot.phase === "focus_transition" && focusRemainingMs === 0);
  const immersivePhase = isImmersivePhase(snapshot.phase);
  const tablePhaseLabel = describeTablePhase(snapshot.phase, focusRemainingMs);
  const requestPlayLowestCard = () => {
    playCardTap();
    sendEvent({ type: "play_lowest_card" });
  };

  return (
    <section className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-6xl flex-col gap-5 relative">
      <motion.header
        {...revealMotion(reducedMotion, {
          duration: 0.5,
          y: 10
        })}
        className={classes(
          "room-header flex flex-col gap-3 transition duration-300 sm:flex-row sm:items-center sm:justify-between",
          immersivePhase && "lg:opacity-62",
          isRoundInteractive && "lg:opacity-48"
        )}
      >
        <div className="room-title-block">
          <p className="text-xs uppercase tracking-[0.34em] text-[var(--accent-soft)]">
            Room {snapshot.roomId}
          </p>
          <h1 className="display-face mt-2 text-3xl font-black tracking-tight text-[var(--card-front)] sm:text-4xl">
            Level {snapshot.currentLevel} of {snapshot.maxLevel}
          </h1>
        </div>
        <div className="room-header-actions flex flex-wrap items-center gap-2">
          <ConnectionPill state={connectionState} />
          <StatPill label="Lives" tone="danger" value={snapshot.lives} />
          <StatPill label="Scans" tone="warning" value={snapshot.scans} />
          {snapshot.inviteLink ? <CopyInviteButton inviteLink={snapshot.inviteLink} /> : null}
        </div>
      </motion.header>

      <AnimatePresence>
        {banner ? (
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            aria-live="polite"
            className="room-banner-layer"
            exit={{ opacity: 0, scale: 0.97, y: -12 }}
            initial={{ opacity: 0, scale: 0.9, y: -24 }}
            key={`${banner.tone}-${banner.text}`}
            role="status"
            transition={{
              bounce: 0.14,
              damping: 26,
              mass: 0.82,
              stiffness: 360,
              type: "spring"
            }}
          >
            <div
              className={classes(
                "banner-popover",
                banner.celebration === "run_complete" && "banner-popover-grand"
              )}
            >
              {banner.celebration ? (
                <BannerCelebrationBurst kind={banner.celebration} reducedMotion={reducedMotion} />
              ) : null}
              <div className={bannerClass(banner.tone)}>
                <span aria-hidden="true" className="banner-mark" />
                <div className="banner-copy">
                  <span className="banner-kicker">{bannerToneLabel(banner.tone)}</span>
                  <span className="banner-text">{banner.text}</span>
                </div>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="grid flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_17.5rem]">
        <motion.div
          {...revealMotion(reducedMotion, {
            delay: 0.05,
            duration: 0.58,
            x: -16,
            y: 16
          })}
          className={classes(
            "table-stage relative overflow-hidden rounded-[2.15rem] p-4 sm:p-6",
            immersivePhase && "table-stage-live"
          )}
        >
          <div className="table-play-stack relative flex min-h-[60vh] flex-col sm:min-h-[62vh]">
            <PlayerRail className="table-overlap-top" placement="top" player={other} />

            <div className="table-pile-slot flex flex-1 items-center justify-center">
              <div
                className={classes(
                  "shared-pile-stage table-overlap-middle w-full max-w-3xl px-5 py-5 sm:px-8 sm:py-7",
                  snapshot.pendingRequest && "shared-pile-stage-requesting"
                )}
              >
                <div className="mb-4 flex flex-wrap items-center gap-3 sm:grid sm:grid-cols-[auto_1fr_auto] sm:gap-4">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--accent-soft)]">
                      Shared pile
                    </p>
                  </div>
                  <div className="table-toolbar flex flex-wrap items-center gap-2 sm:justify-center">
                    <div className="table-phase-badge rounded-full px-3 py-2 text-xs uppercase tracking-[0.22em]">
                      {tablePhaseLabel}
                    </div>
                    <button
                      className={buttonClass("secondary")}
                      disabled={!snapshot.canRequestPause}
                      onClick={() => {
                        sendEvent({ type: "request_pause" });
                      }}
                      type="button"
                    >
                      Pause
                    </button>
                    <button
                      className={buttonClass("secondary")}
                      disabled={!snapshot.canRequestScan}
                      onClick={() => {
                        sendEvent({ type: "request_scan" });
                      }}
                      type="button"
                    >
                      Scan
                    </button>
                  </div>
                  <div className="count-pill rounded-full px-3 py-1 text-sm">
                    {countLabel(snapshot.pile.length, "card")}
                  </div>
                </div>
                {snapshot.pendingRequest ? (
                  <div className="table-request-layer">
                    <PendingRequestPanel
                      selfSeatId={snapshot.viewerSeatId}
                      sendEvent={sendEvent}
                      snapshot={snapshot}
                    />
                  </div>
                ) : null}
                <CenterPile pile={snapshot.pile} reducedMotion={reducedMotion} />
              </div>
            </div>

            <div className="live-hand-zone table-overlap-bottom rounded-[1.8rem] p-4 sm:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--accent-soft)]">
                    Your hand
                  </p>
                  <p className="mt-2 text-sm text-[var(--muted)]">Only your lowest card can be played.</p>
                </div>
                <div className="count-pill rounded-full px-3 py-1 text-sm">
                  {countLabel(self.handCount, "card")}
                </div>
              </div>
              <div className="hand-fan-stage" ref={handMeasureRef}>
                <div
                  className="hand-fan-row"
                  style={{
                    minHeight: Math.max(handLayout.cardHeight + 12, 144),
                    width: handLayout.totalWidth || undefined
                  }}
                >
                  {self.hand.map((value, index) => (
                    <motion.button
                      animate={reducedMotion ? undefined : { y: 0, opacity: 1 }}
                      className="signal-card-button relative shrink-0"
                      disabled={index !== 0 || !isRoundInteractive}
                      initial={reducedMotion ? undefined : { y: 14, opacity: 0 }}
                      key={value}
                      layout={!reducedMotion}
                      onPointerLeave={index === 0 && !reducedMotion ? resetLiveCardPointer : undefined}
                      onPointerMove={
                        index === 0 && isRoundInteractive && !reducedMotion
                          ? updateLiveCardPointer
                          : undefined
                      }
                      onClick={() => {
                        requestPlayLowestCard();
                      }}
                      transition={reducedMotion ? undefined : layoutSpring}
                      type="button"
                      style={{
                        height: handLayout.cardHeight,
                        marginLeft: index === 0 ? 0 : handLayout.step - handLayout.cardWidth,
                        width: handLayout.cardWidth,
                        zIndex: self.hand.length - index
                      }}
                      whileTap={reducedMotion ? undefined : { scale: 0.97, y: 4 }}
                    >
                      <span
                        className={classes(
                          "signal-card-shell flex size-full items-center justify-center rounded-[1.55rem] border-2 font-black transition",
                          index === 0
                            ? "signal-card-live border-[var(--accent)] bg-[var(--card-front)] text-[var(--card-ink)]"
                            : "signal-card-muted"
                        )}
                      >
                        {handLayout.useInsetValues && index !== 0 ? (
                          <span
                            className="signal-card-corner-value"
                            style={{ fontSize: handLayout.cornerValueFontSize }}
                          >
                            {value}
                          </span>
                        ) : (
                          <span
                            className="signal-card-value"
                            style={{ fontSize: handLayout.valueFontSize, lineHeight: 1 }}
                          >
                            {value}
                          </span>
                        )}
                        {index === 0 && isRoundInteractive ? (
                          <span className="live-badge absolute rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]">
                            Live
                          </span>
                        ) : null}
                      </span>
                    </motion.button>
                  ))}
                  {self.hand.length === 0 ? (
                    <div className="hand-empty rounded-[1.2rem] px-4 py-6 text-sm text-[var(--muted)]">
                      Your hand is empty.
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <AnimatePresence>
            {snapshot.phase === "focus_transition" && focusRemainingMs > 0 ? (
              <CenterOverlay key="focus">
                <motion.div
                  animate={reducedMotion ? undefined : { scale: [0.94, 1.04, 0.94] }}
                  className="focus-orb mx-auto flex size-28 items-center justify-center rounded-full"
                  transition={{ duration: 1.8, repeat: Number.POSITIVE_INFINITY }}
                >
                  <div className="focus-orb-core size-16 rounded-full" />
                </motion.div>
                <p className="mt-6 text-xs uppercase tracking-[0.38em] text-[var(--accent-soft)]">Focus</p>
                <h2 className="mx-auto mt-2 max-w-[18rem] text-balance text-3xl font-black text-[var(--card-front)]">Start together</h2>
                <p className="mx-auto mt-3 max-w-[21rem] text-balance text-sm leading-7 text-[var(--muted)]">
                  Stay quiet. Let the timing settle.
                </p>
                <p className="mt-4 text-sm text-[var(--muted)]">{Math.ceil(focusRemainingMs / 1000)}s</p>
              </CenterOverlay>
            ) : null}
            {snapshot.phase === "waiting" || (snapshot.phase === "between_levels" && !isHoldingLevelAdvanceOverlay) ? (
              <CenterOverlay key="lobby">
                <p className="text-xs uppercase tracking-[0.38em] text-[var(--accent-soft)]">
                  {snapshot.phase === "waiting" ? "Lobby" : "Next level"}
                </p>
                <h2 className="mt-2 text-balance text-3xl font-black text-[var(--card-front)]">
                  {snapshot.phase === "waiting"
                    ? other.hasJoined
                      ? "Both players are here"
                      : "Waiting for your partner"
                    : `Level ${snapshot.currentLevel} is ready`}
                </h2>
                <p className="mx-auto mt-3 max-w-[23rem] text-balance text-sm leading-7 text-[var(--muted)]">
                  {snapshot.phase === "waiting" ? waitingOverlayBody(snapshot) : betweenLevelsBody(snapshot)}
                </p>
                {snapshot.phase === "between_levels" ? (
                  <button
                    className={buttonClass("primary")}
                    disabled={!snapshot.canStartLevel}
                    onClick={() => {
                      sendEvent({ type: "ready_for_level" });
                    }}
                    type="button"
                  >
                    {self.ready ? "Waiting for partner" : "Ready"}
                  </button>
                ) : null}
              </CenterOverlay>
            ) : null}
            {snapshot.phase === "won" || snapshot.phase === "lost" ? (
              <CenterOverlay key="result">
                <p className="text-xs uppercase tracking-[0.38em] text-[var(--accent-soft)]">
                  {snapshot.phase === "won" ? "Run complete" : "Out of lives"}
                </p>
                <h2 className="mx-auto mt-2 max-w-[20rem] text-balance text-3xl font-black text-[var(--card-front)]">
                  {snapshot.phase === "won" ? "All 12 levels cleared." : "No lives left."}
                </h2>
                <p className="mx-auto mt-3 max-w-[23rem] text-balance text-sm leading-7 text-[var(--muted)]">
                  {snapshot.phase === "won"
                    ? "Same room, fresh run. Press rematch when you're both ready."
                    : "Press rematch to start again from level 1."}
                </p>
                <button
                  className={buttonClass("primary")}
                  disabled={self.ready}
                  onClick={() => {
                    sendEvent({ type: "request_rematch" });
                  }}
                  type="button"
                >
                  {self.ready ? "Waiting for partner" : "Rematch"}
                </button>
              </CenterOverlay>
            ) : null}
          </AnimatePresence>
        </motion.div>

        <motion.aside
          {...revealMotion(reducedMotion, {
            delay: 0.1,
            duration: 0.58,
            x: 16,
            y: 18
          })}
          className={classes(
            "hud-rail space-y-4 transition duration-300",
            immersivePhase && "lg:translate-x-2 lg:opacity-58 lg:hover:opacity-100 lg:focus-within:opacity-100",
            isRoundInteractive && "lg:opacity-46"
          )}
        >
          <PlayerStatusCard
            actionLabel={snapshot.phase === "between_levels" ? (self.ready ? "Ready" : "Waiting") : "You"}
            player={self}
            title="You"
          />
          <PlayerStatusCard
            actionLabel={other.hasJoined ? (other.connected ? "Connected" : "Rejoining") : "Invite pending"}
            player={other}
            title="Partner"
          />
          {error ? (
            <div className="alert-panel alert-panel-danger rounded-[1.6rem] p-4 text-sm leading-7 text-[var(--card-front)]">
              {error}
            </div>
          ) : null}
          <NameEditor
            key={`${self.seatId}-${self.displayName}`}
            label="Your name"
            onSubmit={(displayName) => {
              sendEvent({ type: "set_name", displayName });
            }}
            value={self.displayName}
          />
          <div className="table-summary-card panel-surface rounded-[1.6rem] p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--accent-soft)]">
              Table
            </h2>
            <dl className="table-state-list mt-4 grid gap-3 text-sm text-[var(--muted)]">
              <div className="table-state-row flex items-center justify-between rounded-[1rem] px-3 py-2">
                <dt>Connection</dt>
                <dd>{describeConnectionState(connectionState)}</dd>
              </div>
              <div className="table-state-row flex items-center justify-between rounded-[1rem] px-3 py-2">
                <dt>Your next card</dt>
                <dd>{lowestPlayableValue ?? "-"}</dd>
              </div>
              <div className="table-state-row flex items-center justify-between rounded-[1rem] px-3 py-2">
                <dt>Partner cards</dt>
                <dd>{countLabel(other.handCount, "card")}</dd>
              </div>
            </dl>
            <div className="table-controls-note table-state-note mt-4 rounded-[1rem] px-3 py-3 text-sm leading-7 text-[var(--muted)]">
              Keys: Space plays, P pauses, S requests a scan, F toggles fullscreen.
            </div>
          </div>
        </motion.aside>
      </div>
    </section>
  );
}

function useRoomSession(roomId: string, token: string | null) {
  const setBootstrap = useRoomStore((state) => state.setBootstrap);
  const applyServerEvent = useRoomStore((state) => state.applyServerEvent);
  const setConnectionState = useRoomStore((state) => state.setConnectionState);
  const setError = useRoomStore((state) => state.setError);
  const reset = useRoomStore((state) => state.reset);
  const [connectNonce, setConnectNonce] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const intentionalCloseRef = useRef(false);

  useEffect(() => {
    if (!token) {
      return undefined;
    }

    let cancelled = false;
    requestRef.current += 1;
    const currentAttempt = requestRef.current;
    intentionalCloseRef.current = false;
    if (retryRef.current !== null) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }

    const connectionMode: ConnectionState = connectNonce === 0 ? "bootstrapping" : "reconnecting";
    setConnectionState(connectionMode);
    setError(null);

    const bootstrapAndConnect = async () => {
      try {
        const response = await fetch(`/api/rooms/${roomId}/bootstrap`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            token
          })
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 404) {
            clearStoredRoomToken(roomId);
          }
          throw new Error(response.status === 401 ? "Invite link is invalid or expired." : "Couldn't join the room.");
        }
        const payload = bootstrapResponseSchema.parse(await readJsonOrThrow(response));
        if (cancelled || currentAttempt !== requestRef.current) {
          return;
        }

        startTransition(() => {
          setBootstrap(payload);
        });

        setConnectionState("connecting");
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const socket = new WebSocket(`${protocol}://${window.location.host}${payload.wsPath}`);
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (cancelled || currentAttempt !== requestRef.current) {
            return;
          }
          setConnectionState("open");
          socket.send(
            JSON.stringify(
              clientEventSchema.parse({
                type: "join_room",
                lastEventId: useRoomStore.getState().snapshot?.eventId ?? null
              })
            )
          );
        });

        socket.addEventListener("message", (event) => {
          const parsed = serverEventSchema.parse(JSON.parse(String(event.data)));
          startTransition(() => {
            applyServerEvent(parsed);
          });
        });

        socket.addEventListener("close", () => {
          if (cancelled || intentionalCloseRef.current || currentAttempt !== requestRef.current) {
            return;
          }
          setConnectionState("closed");
          retryRef.current = window.setTimeout(() => {
            setConnectNonce((value) => value + 1);
          }, 1000);
        });

        socket.addEventListener("error", () => {
          if (cancelled || intentionalCloseRef.current || currentAttempt !== requestRef.current) {
            return;
          }
          setConnectionState("error");
          retryRef.current = window.setTimeout(() => {
            setConnectNonce((value) => value + 1);
          }, 1000);
        });
      } catch (caughtError) {
        if (cancelled || currentAttempt !== requestRef.current) {
          return;
        }
        setConnectionState("error");
        setError(caughtError instanceof Error ? caughtError.message : "Couldn't join the room.");
      }
    };

    void bootstrapAndConnect();

    return () => {
      cancelled = true;
      intentionalCloseRef.current = true;
      requestRef.current += 1;
      if (retryRef.current !== null) {
        window.clearTimeout(retryRef.current);
      }
      socketRef.current?.close(1000, "Leaving room");
      socketRef.current = null;
      reset();
    };
  }, [applyServerEvent, connectNonce, reset, roomId, setBootstrap, setConnectionState, setError, token]);

  const sendEvent = (event: ClientEvent) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("Connection lost. Reconnecting...");
      return;
    }
    socket.send(JSON.stringify(clientEventSchema.parse(event)));
  };

  const reconnectNow = () => {
    setConnectNonce((value) => value + 1);
  };

  return {
    sendEvent,
    reconnectNow
  };
}

function ConnectionPill(props: { state: ConnectionState }) {
  return (
    <div className={connectionPillClass(props.state)}>
      {describeConnectionState(props.state)}
    </div>
  );
}

function StatPill(props: { label: string; value: number; tone: "danger" | "warning" }) {
  return (
    <div className={statPillClass(props.tone)}>
      <span>{props.label}</span> <span className="metric-pill-value font-black">{props.value}</span>
    </div>
  );
}

function CopyInviteButton(props: { inviteLink: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={buttonClass("secondary")}
      onClick={() => {
        void navigator.clipboard.writeText(props.inviteLink);
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 1200);
      }}
      type="button"
    >
      {copied ? "Copied" : "Copy invite link"}
    </button>
  );
}

function PlayerRail(props: {
  player: RoomState["players"]["host"];
  placement: "top" | "bottom";
  className?: string;
}) {
  return (
    <div
      className={classes(
        "player-rail flex items-center justify-between gap-4 rounded-[1.7rem] px-4 py-4",
        props.className
      )}
    >
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--accent-soft)]">
          {props.player.displayName}
        </p>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {props.player.connected ? "Connected" : props.player.hasJoined ? "Reconnecting" : "Waiting to join"}
        </p>
      </div>
      <div className="flex gap-2">
        {Array.from({ length: Math.max(props.player.handCount, 1) }).map((_, index) => (
          <div
            className={`h-16 w-11 rounded-[0.95rem] border ${
              props.player.handCount === 0
                ? "border-white/10 bg-transparent"
                : "landing-card-back border-[rgba(255,245,224,0.08)]"
            }`}
            key={`${props.placement}-${index}`}
          />
        ))}
      </div>
    </div>
  );
}

function CenterPile(props: { pile: RoomState["pile"]; reducedMotion: boolean }) {
  return (
    <div className="pile-grid flex min-h-72 flex-wrap items-center justify-center gap-3 content-center">
      {props.pile.slice(-18).map((card) => (
        <motion.div
          animate={props.reducedMotion ? undefined : { opacity: 1, y: 0 }}
          className={`signal-pile-card flex h-20 w-[3.8rem] items-center justify-center rounded-[1rem] border text-xl font-black ${
            card.resolution === "played"
              ? "border-[var(--card-edge)] bg-[var(--card-front)] text-[var(--card-ink)]"
              : card.resolution === "misplay_discard"
                ? "border-[var(--danger)]/35 bg-[var(--danger)]/12 text-[var(--card-front)]"
                : "border-[var(--warning)]/35 bg-[var(--warning)]/12 text-[var(--card-front)]"
          }`}
          initial={props.reducedMotion ? undefined : { opacity: 0, y: 10 }}
          key={`${card.value}-${card.timestamp}-${card.resolution}`}
          layout={!props.reducedMotion}
          transition={props.reducedMotion ? undefined : layoutSpring}
        >
          {card.value}
        </motion.div>
      ))}
      {props.pile.length === 0 ? (
        <div className="empty-pile-state">
          <div className="empty-pile-card" />
          <p className="mt-3 text-sm text-[var(--muted)]">No cards played yet.</p>
        </div>
      ) : null}
    </div>
  );
}

function PendingRequestPanel(props: {
  snapshot: RoomState;
  selfSeatId: SeatId;
  sendEvent: (event: ClientEvent) => void;
}) {
  const pending = props.snapshot.pendingRequest;
  const reducedMotion = Boolean(useReducedMotion());

  if (!pending) {
    return null;
  }

  const isAwaitingViewer = !pending.approvals[props.selfSeatId];
  const requestLabel = pending.kind === "pause" ? "Pause" : "Scan";
  const title =
    pending.kind === "pause"
      ? isAwaitingViewer
        ? "Resume the round?"
        : "Waiting for your partner."
      : isAwaitingViewer
        ? "Use a scan?"
        : "Waiting for your partner.";
  const body =
    pending.kind === "pause"
      ? "The round resumes when both players confirm."
      : "Reveal and discard the lowest card in both hands.";

  return (
    <motion.div
      animate={reducedMotion ? undefined : { opacity: 1, y: 0 }}
      className={classes(
        "request-panel request-panel-overlay request-panel-warning text-[var(--card-front)]",
        isAwaitingViewer ? "request-panel-overlay-interactive" : "request-panel-overlay-passive"
      )}
      initial={reducedMotion ? undefined : { opacity: 0, y: -8 }}
      transition={reducedMotion ? undefined : {
        duration: 0.24,
        ease: revealEase
      }}
    >
      <div className="request-panel-main">
        <div className="request-panel-meta-row">
          <p className="request-panel-kicker">{requestLabel}</p>
          <div
            className={classes(
              "request-panel-state",
              isAwaitingViewer ? "request-panel-state-pending" : "request-panel-state-waiting"
            )}
          >
            {isAwaitingViewer ? "Action needed" : "Waiting"}
          </div>
        </div>
        <p className="request-panel-title">{title}</p>
        <p className="request-panel-copy">{body}</p>
      </div>
      {isAwaitingViewer ? (
        <div className="request-panel-actions">
          {pending.kind === "pause" ? (
            <button
              className={`${buttonClass("primary")} flex-1`}
              onClick={() => {
                props.sendEvent({ type: "resume_round" });
              }}
              type="button"
            >
              Resume
            </button>
          ) : (
            <>
              <button
                className={`${buttonClass("primary")} flex-1`}
                onClick={() => {
                  props.sendEvent({ type: "respond_scan", accepted: true });
                }}
                type="button"
              >
                Use scan
              </button>
              <button
                className={`${buttonClass("ghost")} flex-1`}
                onClick={() => {
                  props.sendEvent({ type: "respond_scan", accepted: false });
                }}
                type="button"
              >
                Not now
              </button>
            </>
          )}
        </div>
      ) : null}
    </motion.div>
  );
}

function CenterOverlay(props: { children: ReactNode }) {
  const reducedMotion = Boolean(useReducedMotion());

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="overlay-backdrop"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={reducedMotion ? undefined : {
        duration: 0.24,
        ease: revealEase
      }}
    >
      <motion.div
        animate={reducedMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
        className="overlay-panel panel-surface rounded-[1.85rem] px-8 py-10 text-center"
        exit={reducedMotion ? undefined : { opacity: 0, y: 10, scale: 0.985 }}
        initial={reducedMotion ? undefined : { opacity: 0, y: 14, scale: 0.985 }}
        transition={reducedMotion ? undefined : {
          duration: 0.32,
          ease: revealEase
        }}
      >
        {props.children}
      </motion.div>
    </motion.div>
  );
}

function PlayerStatusCard(props: {
  title: string;
  actionLabel: string;
  player: RoomState["players"]["host"];
}) {
  const connectionLabel = props.player.connected
    ? "Live"
    : props.player.hasJoined
      ? "Away"
      : "Waiting";
  const chipToneClass = props.title === "You"
    ? "status-chip-self"
    : props.player.connected
      ? "status-chip-connected"
      : props.player.hasJoined
        ? "status-chip-rejoining"
        : "status-chip-pending";

  return (
    <div className="status-card panel-surface rounded-[1.6rem] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-[var(--accent-soft)]">
            {props.title}
          </p>
          <h2 className="mt-2 text-xl font-bold text-[var(--card-front)]">
            {props.player.displayName}
          </h2>
        </div>
        <div className={classes("status-chip rounded-full px-3 py-1 text-xs uppercase tracking-[0.18em]", chipToneClass)}>
          {props.actionLabel}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="status-data-block rounded-[1rem] px-3 py-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent-soft)]">Connection</p>
          <p className="mt-2 text-sm text-[var(--card-front)]">{connectionLabel}</p>
        </div>
        <div className="status-data-block rounded-[1rem] px-3 py-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent-soft)]">Cards</p>
          <p className="mt-2 text-sm text-[var(--card-front)]">{countLabel(props.player.handCount, "card")}</p>
        </div>
      </div>
    </div>
  );
}

function NameEditor(props: {
  value: string;
  label: string;
  onSubmit: (nextValue: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);

  return (
    <form
      className="name-editor rounded-[1.2rem] p-3"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit(draft);
      }}
    >
      <label className="block text-xs uppercase tracking-[0.22em] text-[var(--muted)]">
        {props.label}
      </label>
      <div className="mt-2 flex gap-2">
        <input
          className="name-input rounded-full px-4 py-2 ring-0"
          maxLength={24}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          value={draft}
        />
        <button className={buttonClass("secondary")} type="submit">
          Save
        </button>
      </div>
    </form>
  );
}

async function toggleFullscreen(): Promise<void> {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
    return;
  }
  await document.exitFullscreen();
}

