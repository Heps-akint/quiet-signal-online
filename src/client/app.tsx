import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { startTransition, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
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
  type BannerTone,
  type ConnectionState,
  useRoomStore
} from "@client/store";
import { useRoomCardSounds } from "@client/card-sound";
import { APP_VERSION, PROTOCOL_VERSION } from "@shared/version";

type RouteState =
  | { kind: "landing" }
  | { kind: "room"; roomId: string; token: string | null };

const ROOM_TOKEN_STORAGE_PREFIX = "the-mind:room-token:";
const revealEase = [0.22, 1, 0.36, 1] as const;
const layoutSpring = {
  damping: 30,
  mass: 0.82,
  stiffness: 320,
  type: "spring"
} as const;

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
    // Private browsing can block storage. The live URL still carries the token.
  }
}

function clearStoredRoomToken(roomId: string): void {
  try {
    window.sessionStorage.removeItem(roomTokenStorageKey(roomId));
  } catch {
    // Nothing else to clear.
  }
}

function parseRoute(url: URL): RouteState {
  const match = /^\/room\/([a-z0-9]+)$/u.exec(url.pathname);
  if (!match) {
    return { kind: "landing" };
  }

  const roomId = roomIdSchema.safeParse(match[1] ?? "");
  if (!roomId.success) {
    return { kind: "landing" };
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
  return { other: snapshot.players[otherSeatId], self };
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

function buttonClass(kind: "primary" | "secondary" | "text"): string {
  return classes(
    "ui-button",
    kind === "primary" && "ui-button-primary",
    kind === "secondary" && "ui-button-secondary",
    kind === "text" && "ui-button-text"
  );
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
      return "Connection lost";
    case "idle":
      return "Waiting";
  }
}

function describePlayerPresence(player: RoomState["players"]["host"]): string {
  if (player.connected) {
    return "Here";
  }
  if (player.hasJoined) {
    return "Away";
  }
  return "Waiting";
}

function describeTablePhase(phase: RoomState["phase"], focusRemainingMs: number): string {
  if (phase === "focus_transition") {
    return focusRemainingMs > 0 ? "Focus" : "Live";
  }

  switch (phase) {
    case "waiting":
      return "Waiting";
    case "between_levels":
      return "Ready";
    case "in_round":
      return "Live";
    case "paused":
      return "Paused";
    case "won":
      return "Complete";
    case "lost":
      return "Run lost";
  }
}

function isRoundLive(snapshot: RoomState, nowMs: number): boolean {
  return snapshot.phase === "in_round"
    || (
      snapshot.phase === "focus_transition"
      && snapshot.transitionEndsAt !== null
      && nowMs >= snapshot.transitionEndsAt
    );
}

function bannerToneLabel(tone: BannerTone): string {
  switch (tone) {
    case "success":
      return "Clear";
    case "warning":
      return "Check";
    case "danger":
      return "Life lost";
    case "neutral":
      return "Update";
  }
}

function useHandFanLayout(measureRef: RefObject<HTMLDivElement | null>, cardCount: number) {
  const [availableSize, setAvailableSize] = useState({ height: 180, width: 640 });

  useEffect(() => {
    const element = measureRef.current;
    if (!element) {
      return undefined;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setAvailableSize({ height: rect.height, width: rect.width });
    };
    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measureRef]);

  const compact = availableSize.width < 560;
  const usableWidth = Math.max(availableSize.width - (compact ? 8 : 16), 0);
  const baseMaxCardWidth = compact ? 112 : 132;
  const heightLimitedCardWidth = Math.floor(Math.max(44, (availableSize.height - 16) / 1.4));
  const maxCardWidth = Math.max(44, Math.min(baseMaxCardWidth, heightLimitedCardWidth));
  const minCardWidth = Math.min(compact ? 62 : 72, maxCardWidth);
  const preferredVisibleStep = compact ? 25 : 36;
  const relaxedGap = compact ? 8 : 14;
  const overlapCount = Math.max(cardCount - 1, 0);
  const cardWidth = cardCount <= 1
    ? maxCardWidth
    : clampNumber(
        Math.round(usableWidth - preferredVisibleStep * overlapCount),
        minCardWidth,
        maxCardWidth
      );
  const step = cardCount <= 1
    ? cardWidth
    : Math.max(0, Math.min(cardWidth + relaxedGap, (usableWidth - cardWidth) / overlapCount));
  const cardHeight = Math.round(cardWidth * 1.4);
  const totalWidth = cardCount === 0 ? 0 : cardWidth + step * overlapCount;
  const valueFontSize = clampNumber(
    Math.round(cardWidth * 0.48),
    cardWidth < 62 ? 22 : compact ? 30 : 36,
    68
  );
  const useCornerValue = step < cardWidth * 0.72;

  return { cardHeight, cardWidth, step, totalWidth, useCornerValue, valueFontSize };
}

function revealMotion(reducedMotion: boolean, delay = 0, y = 20) {
  if (reducedMotion) {
    return {};
  }
  return {
    animate: { opacity: 1, y: 0 },
    initial: { opacity: 0, y },
    transition: { delay, duration: 0.48, ease: revealEase }
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
    const handleLocation = () => setRoute(parseRoute(new URL(window.location.href)));
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
    if (window.location.hash) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    }
  }, [route]);

  useEffect(() => {
    const timer = window.setInterval(() => useRoomStore.getState().tickRealClock(), 200);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="app-shell">
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
  const [showRules, setShowRules] = useState(false);
  const reducedMotion = Boolean(useReducedMotion());

  const createRoom = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rooms", {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        throw new Error("Room couldn't open. Try again.");
      }
      const payload = createRoomResponseSchema.parse(await readJsonOrThrow(response));
      window.location.assign(payload.hostInviteUrl);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Room couldn't open. Try again.");
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!showRules) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      document.getElementById("how-to-play")?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start"
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reducedMotion, showRules]);

  const revealRules = () => {
    if (showRules) {
      document.getElementById("how-to-play")?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start"
      });
      return;
    }
    setShowRules(true);
  };

  return (
    <section className={classes("landing-page", showRules && "landing-page-rules-open")}>
      <section className="landing-hero">
        <motion.div {...revealMotion(reducedMotion)} className="landing-copy">
          <p className="wordmark">The Mind</p>
          <h1>Play the next number.<br />Without knowing theirs.</h1>
          <p className="landing-lead">Open a private room. Send one link. Get quiet.</p>
          <div className="landing-actions">
            <button
              className={buttonClass("primary")}
              disabled={busy}
              onClick={() => void createRoom()}
              type="button"
            >
              {busy ? "Opening…" : "Open a room"}
            </button>
            <button
              aria-controls="how-to-play"
              aria-expanded={showRules}
              className={buttonClass("text")}
              onClick={revealRules}
              type="button"
            >
              How to play
            </button>
          </div>
          {error ? <p className="inline-error" role="alert">{error}</p> : null}
        </motion.div>

        <motion.div {...revealMotion(reducedMotion, 0.08, 14)} className="landing-preview">
          <div className="preview-partner">
            <span>Partner</span>
            <div className="preview-backs" aria-hidden="true">
              <i />
              <i />
            </div>
          </div>
          <div className="preview-pile">
            <span>Shared pile</span>
            <strong>37</strong>
          </div>
          <div className="preview-hand">
            {[52, 68, 91].map((value, index) => (
              <i className={index === 0 ? "preview-card-active" : ""} key={value}>{value}</i>
            ))}
          </div>
        </motion.div>
      </section>

      {showRules ? (
        <section className="rules-strip" id="how-to-play">
          <div className="rules-heading">
            <p className="eyebrow">How to play</p>
            <h2>Four moves. Then trust the timing.</h2>
          </div>
          <div className="rules-grid">
            <RuleStep number="1" title="Open" body="Create a private room." />
            <RuleStep number="2" title="Share" body="Send the invite link." />
            <RuleStep number="3" title="Focus" body="Stop talking at the cue." />
            <RuleStep number="4" title="Play lowest" body="Tap only your lowest card." />
          </div>
          <p className="rules-note">
            Wrong order costs one life. If both players agree, use a throwing star to discard the lowest card from both hands.
          </p>
        </section>
      ) : null}

      <Attribution />
    </section>
  );
}

function RuleStep(props: { number: string; title: string; body: string }) {
  return (
    <article className="rule-step">
      <span>{props.number}</span>
      <div>
        <h3>{props.title}</h3>
        <p>{props.body}</p>
      </div>
    </article>
  );
}

function Attribution() {
  return (
    <p className="attribution">
      Unofficial fan-made adaptation inspired by <cite>The Mind</cite>. The game and its mechanics are not original to this project.
      <span aria-label={`Version ${APP_VERSION}`}>v{APP_VERSION}</span>
    </p>
  );
}

function CenteredMessage(props: { title: string; body: string; action?: ReactNode }) {
  return (
    <section className="message-screen">
      <div className="message-block">
        <p className="wordmark">The Mind</p>
        <h1>{props.title}</h1>
        <p>{props.body}</p>
        {props.action ? <div className="message-action">{props.action}</div> : null}
      </div>
      <Attribution />
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
  const { reconnectNow, sendEvent } = useRoomSession(props.roomId, props.token);
  const { playCardTap } = useRoomCardSounds(snapshot);

  useEffect(() => {
    if (!banner) {
      return undefined;
    }
    const timer = window.setTimeout(clearBanner, 2400);
    return () => window.clearTimeout(timer);
  }, [banner, clearBanner]);

  useEffect(() => {
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
      } else if (isRoundLive(snapshot, Date.now()) && event.key === " ") {
        event.preventDefault();
        playCardTap();
        sendEvent({ type: "play_lowest_card" });
      } else if (key === "p" && isRoundLive(snapshot, Date.now()) && snapshot.pendingRequest === null) {
        sendEvent({ type: "request_pause" });
      } else if (
        (key === "t" || key === "s")
        && isRoundLive(snapshot, Date.now())
        && snapshot.pendingRequest === null
        && snapshot.scans > 0
      ) {
        sendEvent({ type: "request_scan" });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [playCardTap, sendEvent, snapshot]);

  if (!props.token) {
    return (
      <CenteredMessage
        action={<a className={buttonClass("text")} href="/">Back home</a>}
        body="Open the full link that was shared with you."
        title="Invite link incomplete"
      />
    );
  }

  if (!snapshot) {
    return (
      <CenteredMessage
        action={connectionState === "error" || connectionState === "closed" ? (
          <button className={buttonClass("primary")} onClick={reconnectNow} type="button">Retry now</button>
        ) : undefined}
        body={error ?? "Joining the room…"}
        title={error ? "Couldn't join the room" : "Joining room"}
      />
    );
  }

  const { other, self } = selfAndOther(snapshot);
  const focusRemainingMs = snapshot.transitionEndsAt === null
    ? 0
    : Math.max(0, snapshot.transitionEndsAt - nowMs);
  const isRoundInteractive = isRoundLive(snapshot, nowMs);
  const canRequestPause = isRoundInteractive && snapshot.pendingRequest === null;
  const canRequestStar = canRequestPause && snapshot.scans > 0;
  const isHoldingLevelClear = levelAdvanceHoldUntilMs !== null && nowMs < levelAdvanceHoldUntilMs;
  const connectionInterrupted = connectionState === "closed"
    || connectionState === "error"
    || connectionState === "reconnecting";
  const playLowestCard = () => {
    playCardTap();
    sendEvent({ type: "play_lowest_card" });
  };

  return (
    <section className={classes("room-screen", connectionInterrupted && "room-screen-interrupted")}>
      <motion.header {...revealMotion(reducedMotion, 0, 10)} className="room-topbar">
        <div className="room-brand">
          <p className="wordmark">The Mind</p>
          <span>Room {snapshot.roomId}</span>
        </div>
        <div className="level-readout">
          <strong>Level {snapshot.currentLevel}</strong>
          <span>/ {snapshot.maxLevel}</span>
        </div>
        <div className="room-status">
          <ConnectionBadge state={connectionState} />
          <Resource label="Lives" value={snapshot.lives} />
          <Resource label="Stars" value={snapshot.scans} />
          {snapshot.inviteLink ? <CopyInviteButton inviteLink={snapshot.inviteLink} /> : null}
        </div>
      </motion.header>

      <AnimatePresence>
        {banner ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            aria-live="polite"
            className={classes("event-banner", `event-banner-${banner.tone}`)}
            exit={{ opacity: 0, y: -10 }}
            initial={{ opacity: 0, y: -16 }}
            key={`${banner.tone}-${banner.text}`}
            role="status"
          >
            <span>{bannerToneLabel(banner.tone)}</span>
            <strong>{banner.text}</strong>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <motion.section {...revealMotion(reducedMotion, 0.04, 0)} className="game-board">
        <PartnerLane player={other} />

        {connectionInterrupted ? (
          <div className="reconnect-strip" role="status">
            <div>
              <strong>Connection lost</strong>
              <span>Your last confirmed table stays visible.</span>
            </div>
            <button className={buttonClass("secondary")} onClick={reconnectNow} type="button">Retry now</button>
          </div>
        ) : null}

        <div className="table-center">
          <div className="table-label-row">
            <span>Shared pile</span>
            <strong>{describeTablePhase(snapshot.phase, focusRemainingMs)}</strong>
          </div>

          <TableContent
            focusRemainingMs={focusRemainingMs}
            isHoldingLevelClear={isHoldingLevelClear}
            other={other}
            reducedMotion={reducedMotion}
            self={self}
            sendEvent={sendEvent}
            snapshot={snapshot}
          />

          <div className="table-actions">
            <button
              className={buttonClass("secondary")}
              disabled={!canRequestPause}
              onClick={() => sendEvent({ type: "request_pause" })}
              type="button"
            >
              Pause
            </button>
            <button
              className={buttonClass("secondary")}
              disabled={!canRequestStar}
              onClick={() => sendEvent({ type: "request_scan" })}
              type="button"
            >
              Throw star
            </button>
          </div>
        </div>

        <HandZone
          isRoundInteractive={isRoundInteractive && snapshot.pendingRequest === null && !connectionInterrupted}
          onPlay={playLowestCard}
          phase={snapshot.phase}
          self={self}
        />
      </motion.section>

      <footer className="room-footer">
        <NameEditor
          key={`${self.seatId}-${self.displayName}`}
          onSubmit={(displayName) => sendEvent({ displayName, type: "set_name" })}
          value={self.displayName}
        />
        <p className="shortcut-note">Space plays · P pauses · T throws a star · F fullscreen</p>
        <Attribution />
      </footer>
    </section>
  );
}

function TableContent(props: {
  snapshot: RoomState;
  self: RoomState["players"]["host"];
  other: RoomState["players"]["host"];
  focusRemainingMs: number;
  isHoldingLevelClear: boolean;
  reducedMotion: boolean;
  sendEvent: (event: ClientEvent) => void;
}) {
  const { snapshot } = props;

  if (snapshot.phase === "waiting") {
    return (
      <StateMessage eyebrow="Waiting">
        <h2>{props.other.hasJoined ? "Both players are here" : "Send one link"}</h2>
        <p>{props.other.hasJoined ? "The room is opening." : "Your partner joins from the private invite."}</p>
        {snapshot.inviteLink ? <CopyInviteButton inviteLink={snapshot.inviteLink} /> : null}
      </StateMessage>
    );
  }

  if (snapshot.phase === "between_levels" && !props.isHoldingLevelClear) {
    const cleared = snapshot.summary?.kind === "level_cleared" ? snapshot.summary : null;
    return (
      <StateMessage eyebrow={cleared ? "Level clear" : "Ready"}>
        <h2>{cleared ? `Level ${cleared.level} clear` : `Level ${snapshot.currentLevel} ready`}</h2>
        {cleared ? (
          <div className="reward-row">
            {cleared.rewards.life ? <span>+1 life</span> : null}
            {cleared.rewards.scan ? <span>+1 throwing star</span> : null}
          </div>
        ) : (
          <p>Start when both players are set.</p>
        )}
        <button
          className={buttonClass("primary")}
          disabled={!snapshot.canStartLevel}
          onClick={() => props.sendEvent({ type: "ready_for_level" })}
          type="button"
        >
          {props.self.ready ? `Waiting for ${props.other.displayName}` : cleared ? `Ready for ${snapshot.currentLevel}` : "Ready"}
        </button>
      </StateMessage>
    );
  }

  if (snapshot.phase === "focus_transition" && props.focusRemainingMs > 0) {
    return (
      <StateMessage eyebrow="Focus" variant="focus">
        <motion.strong
          animate={props.reducedMotion ? undefined : { scale: [0.98, 1.04, 0.98] }}
          className="focus-count"
          transition={{ duration: 1.8, repeat: Number.POSITIVE_INFINITY }}
        >
          {Math.max(1, Math.ceil(props.focusRemainingMs / 1000))}
        </motion.strong>
        <h2>Get quiet</h2>
      </StateMessage>
    );
  }

  if (snapshot.phase === "won" || snapshot.phase === "lost") {
    return (
      <StateMessage eyebrow={snapshot.phase === "won" ? "Run complete" : "Run lost"}>
        <h2>{snapshot.phase === "won" ? "All 12 clear" : "Out of lives"}</h2>
        <p>{snapshot.phase === "won" ? "Same room. Fresh run." : "Same room. Back to level 1."}</p>
        <button
          className={buttonClass("primary")}
          disabled={props.self.ready}
          onClick={() => props.sendEvent({ type: "request_rematch" })}
          type="button"
        >
          {props.self.ready ? `Waiting for ${props.other.displayName}` : "Rematch"}
        </button>
      </StateMessage>
    );
  }

  return (
    <div className="live-table-content">
      <CenterPile pile={snapshot.pile} reducedMotion={props.reducedMotion} />
      {snapshot.pendingRequest ? (
        <PendingRequestPanel selfSeatId={snapshot.viewerSeatId} sendEvent={props.sendEvent} snapshot={snapshot} />
      ) : null}
    </div>
  );
}

function StateMessage(props: { eyebrow: string; children: ReactNode; variant?: "focus" }) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={classes("state-message", props.variant === "focus" && "state-message-focus")}
      initial={{ opacity: 0, y: 8 }}
      key={props.eyebrow}
      transition={{ duration: 0.24, ease: revealEase }}
    >
      <span>{props.eyebrow}</span>
      {props.children}
    </motion.div>
  );
}

function PartnerLane(props: { player: RoomState["players"]["host"] }) {
  const visibleBacks = Math.min(props.player.handCount, 4);
  return (
    <div className="partner-lane">
      <div>
        <span>Partner</span>
        <strong>{props.player.displayName}</strong>
        <small>{describePlayerPresence(props.player)}</small>
      </div>
      <div className="partner-hand" aria-label={countLabel(props.player.handCount, "hidden card")}>
        {Array.from({ length: visibleBacks }).map((_, index) => <i key={index} />)}
        {props.player.handCount > 4 ? <b>×{props.player.handCount}</b> : null}
        {props.player.handCount === 0 ? <em>No cards</em> : null}
      </div>
    </div>
  );
}

function CenterPile(props: { pile: RoomState["pile"]; reducedMotion: boolean }) {
  if (props.pile.length === 0) {
    return (
      <div className="empty-pile">
        <i />
        <span>No cards played yet</span>
      </div>
    );
  }

  const visibleCards = props.pile.slice(-4);
  return (
    <div className="pile-cards">
      {visibleCards.map((card, index) => {
        const isLatest = index === visibleCards.length - 1;
        return (
          <motion.div
            animate={props.reducedMotion ? undefined : { opacity: 1, y: 0 }}
            className={classes(
              "pile-card",
              isLatest && "pile-card-latest",
              card.resolution === "misplay_discard" && "pile-card-misplay",
              card.resolution === "scan_discard" && "pile-card-star"
            )}
            initial={props.reducedMotion ? undefined : { opacity: 0, y: 12 }}
            key={`${card.value}-${card.timestamp}-${card.resolution}`}
            layout={!props.reducedMotion}
            transition={props.reducedMotion ? undefined : layoutSpring}
          >
            {card.value}
          </motion.div>
        );
      })}
    </div>
  );
}

function HandZone(props: {
  self: RoomState["players"]["host"];
  phase: RoomState["phase"];
  isRoundInteractive: boolean;
  onPlay: () => void;
}) {
  const measureRef = useRef<HTMLDivElement | null>(null);
  const handLayout = useHandFanLayout(measureRef, props.self.hand.length);

  return (
    <div className="hand-zone">
      <div className="hand-label-row">
        <div>
          <span>Your hand</span>
          <strong>{props.self.displayName}</strong>
        </div>
        <small>{countLabel(props.self.handCount, "card")}</small>
      </div>
      <div className="hand-measure" ref={measureRef}>
        {props.self.hand.length > 0 ? (
          <div
            className="hand-fan"
            style={{
              minHeight: handLayout.cardHeight + 16,
              width: handLayout.totalWidth || undefined
            }}
          >
            {props.self.hand.map((value, index) => {
              const isActive = index === 0;
              const style = {
                "--card-font-size": `${handLayout.valueFontSize}px`,
                height: handLayout.cardHeight,
                marginLeft: index === 0 ? 0 : handLayout.step - handLayout.cardWidth,
                width: handLayout.cardWidth,
                zIndex: props.self.hand.length - index
              } as CSSProperties;
              return (
                <motion.button
                  className={classes("hand-card", isActive ? "hand-card-active" : "hand-card-muted")}
                  disabled={!isActive || !props.isRoundInteractive}
                  key={value}
                  layout
                  onClick={props.onPlay}
                  style={style}
                  transition={layoutSpring}
                  type="button"
                  whileTap={props.isRoundInteractive && isActive ? { scale: 0.97, y: 4 } : undefined}
                >
                  <span className={handLayout.useCornerValue && !isActive ? "card-corner-value" : ""}>{value}</span>
                  {isActive && props.isRoundInteractive ? <small>Play</small> : null}
                </motion.button>
              );
            })}
          </div>
        ) : (
          <div className="empty-hand">
            <i />
            <span>{props.phase === "in_round" || props.phase === "paused" ? "Hand clear" : "No cards yet"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PendingRequestPanel(props: {
  snapshot: RoomState;
  selfSeatId: SeatId;
  sendEvent: (event: ClientEvent) => void;
}) {
  const pending = props.snapshot.pendingRequest;
  if (!pending) {
    return null;
  }

  const isAwaitingViewer = !pending.approvals[props.selfSeatId];
  const isPause = pending.kind === "pause";
  const title = isPause
    ? isAwaitingViewer ? "Pause here?" : "Round paused"
    : isAwaitingViewer ? "Use one throwing star?" : "Throwing star requested";
  const body = isAwaitingViewer
    ? isPause
      ? "Both players resume together."
      : "Discard the lowest card from both hands."
    : `Waiting for ${props.snapshot.players[pending.requesterSeatId === "host" ? "guest" : "host"].displayName}.`;

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="request-sheet"
      initial={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.2, ease: revealEase }}
    >
      <span>{isPause ? "Pause" : "Throwing star"}</span>
      <h3>{title}</h3>
      <p>{body}</p>
      {isAwaitingViewer ? (
        <div>
          {isPause ? (
            <button className={buttonClass("primary")} onClick={() => props.sendEvent({ type: "resume_round" })} type="button">
              Resume
            </button>
          ) : (
            <>
              <button className={buttonClass("primary")} onClick={() => props.sendEvent({ accepted: true, type: "respond_scan" })} type="button">
                Throw star
              </button>
              <button className={buttonClass("text")} onClick={() => props.sendEvent({ accepted: false, type: "respond_scan" })} type="button">
                Keep it
              </button>
            </>
          )}
        </div>
      ) : null}
    </motion.div>
  );
}

function ConnectionBadge(props: { state: ConnectionState }) {
  return (
    <div className={classes("connection-badge", props.state === "open" && "connection-badge-open")}>
      <i />
      <span>{describeConnectionState(props.state)}</span>
    </div>
  );
}

function Resource(props: { label: string; value: number }) {
  return (
    <div className="resource-readout">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
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
        window.setTimeout(() => setCopied(false), 1200);
      }}
      type="button"
    >
      {copied ? "Copied" : "Copy invite"}
    </button>
  );
}

function NameEditor(props: { value: string; onSubmit: (nextValue: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  return (
    <form
      className="name-editor"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit(draft);
      }}
    >
      <label htmlFor="player-name">Playing as</label>
      <input
        id="player-name"
        maxLength={24}
        onChange={(event) => setDraft(event.target.value)}
        value={draft}
      />
      <button className={buttonClass("text")} type="submit">Save</button>
    </form>
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

    setConnectionState(connectNonce === 0 ? "bootstrapping" : "reconnecting");
    setError(null);

    const bootstrapAndConnect = async () => {
      try {
        const response = await fetch(`/api/rooms/${roomId}/bootstrap`, {
          body: JSON.stringify({
            appVersion: APP_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            token
          }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 404) {
            clearStoredRoomToken(roomId);
          }
          throw new Error(
            response.status === 400
              ? "App version mismatch. Refresh the page, then reopen the invite."
              : response.status === 401
                ? "Invite link is invalid or expired."
                : "Couldn't join the room."
          );
        }
        const payload = bootstrapResponseSchema.parse(await readJsonOrThrow(response));
        if (cancelled || currentAttempt !== requestRef.current) {
          return;
        }

        startTransition(() => setBootstrap(payload));
        setConnectionState("connecting");
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const socket = new WebSocket(`${protocol}://${window.location.host}${payload.wsPath}`);
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (cancelled || currentAttempt !== requestRef.current) {
            return;
          }
          setConnectionState("open");
          socket.send(JSON.stringify(clientEventSchema.parse({
            lastEventId: useRoomStore.getState().snapshot?.eventId ?? null,
            type: "join_room"
          })));
        });

        socket.addEventListener("message", (event) => {
          const parsed = serverEventSchema.parse(JSON.parse(String(event.data)));
          startTransition(() => applyServerEvent(parsed));
        });

        socket.addEventListener("close", () => {
          if (cancelled || intentionalCloseRef.current || currentAttempt !== requestRef.current) {
            return;
          }
          setConnectionState("closed");
          retryRef.current = window.setTimeout(() => setConnectNonce((value) => value + 1), 1000);
        });

        socket.addEventListener("error", () => {
          if (cancelled || intentionalCloseRef.current || currentAttempt !== requestRef.current) {
            return;
          }
          setConnectionState("error");
          retryRef.current = window.setTimeout(() => setConnectNonce((value) => value + 1), 1000);
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
      setError("Connection dropped. Reconnecting…");
      return;
    }
    socket.send(JSON.stringify(clientEventSchema.parse(event)));
  };

  return {
    reconnectNow: () => setConnectNonce((value) => value + 1),
    sendEvent
  };
}

async function toggleFullscreen(): Promise<void> {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
    return;
  }
  await document.exitFullscreen();
}
