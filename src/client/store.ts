import { create } from "zustand";
import type { BootstrapResponse, RoomState, SeatId, ServerEvent } from "@shared/protocol";

export type ConnectionState =
  | "idle"
  | "bootstrapping"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "error";

export type BannerTone = "neutral" | "success" | "warning" | "danger";
export type BannerCelebration = "level_clear" | "run_complete" | null;

export interface BannerState {
  celebration: BannerCelebration;
  tone: BannerTone;
  text: string;
}

const LEVEL_ADVANCE_OVERLAY_DELAY_MS = 1000;

interface RoomStoreState {
  snapshot: RoomState | null;
  seatId: SeatId | null;
  connectionState: ConnectionState;
  error: string | null;
  banner: BannerState | null;
  levelAdvanceOverlayHoldUntilMs: number | null;
  nowMs: number;
  clockMode: "real" | "virtual";
  setBootstrap: (payload: BootstrapResponse) => void;
  applyServerEvent: (event: ServerEvent) => void;
  setConnectionState: (connectionState: ConnectionState) => void;
  setError: (error: string | null) => void;
  clearBanner: () => void;
  advanceTime: (milliseconds: number) => void;
  tickRealClock: () => void;
  reset: () => void;
}

function bannerFromEvent(event: ServerEvent): BannerState | null {
  switch (event.type) {
    case "card_played":
    case "room_snapshot":
    case "player_presence_changed":
    case "level_started":
      return null;
    case "misplay_resolved":
      return {
        celebration: null,
        tone: "warning",
        text: `Life lost. ${event.card} landed too early.`
      };
    case "pause_state_changed":
      return {
        celebration: null,
        tone: event.resumed ? "neutral" : "warning",
        text: event.resumed ? "Round back on." : "Round paused."
      };
    case "scan_state_changed":
      return {
        celebration: null,
        tone: event.accepted ? "neutral" : "warning",
        text: event.resolved
          ? event.accepted
            ? "Scan spent."
            : "Scan skipped."
          : "Scan requested."
      };
    case "level_cleared":
      return {
        celebration: "level_clear",
        tone: "success",
        text: `Level ${event.clearedLevel} cleared.`
      };
    case "game_won":
      return {
        celebration: "run_complete",
        tone: "success",
        text: "Run finished."
      };
    case "game_lost":
      return {
        celebration: null,
        tone: "danger",
        text: "Out of lives."
      };
    case "room_error":
      return {
        celebration: null,
        tone: "danger",
        text: event.message
      };
  }
}

function textStateFromSnapshot(snapshot: RoomState | null, nowMs: number): string {
  if (!snapshot) {
    return JSON.stringify({
      mode: "loading",
      layout: "top=remote,bottom=self,center=pile"
    });
  }

  const self = snapshot.players[snapshot.viewerSeatId];
  const other = snapshot.players[snapshot.viewerSeatId === "host" ? "guest" : "host"];
  return JSON.stringify({
    layout: "top=remote,bottom=self,center=pile",
    phase: snapshot.phase,
    level: snapshot.currentLevel,
    lives: snapshot.lives,
    scans: snapshot.scans,
    focusRemainingMs:
      snapshot.transitionEndsAt === null ? 0 : Math.max(0, snapshot.transitionEndsAt - nowMs),
    self: {
      seatId: self.seatId,
      name: self.displayName,
      hand: self.hand,
      handCount: self.handCount,
      connected: self.connected,
      ready: self.ready
    },
    remote: {
      seatId: other.seatId,
      name: other.displayName,
      handCount: other.handCount,
      connected: other.connected,
      ready: other.ready
    },
    inviteLink: snapshot.inviteLink,
    pile: snapshot.pile.slice(-12).map((card) => ({
      seatId: card.seatId,
      value: card.value,
      resolution: card.resolution
    })),
    pendingRequest: snapshot.pendingRequest,
    summary: snapshot.summary
  });
}

const initialNow = Date.now();

export const useRoomStore = create<RoomStoreState>((set) => ({
  snapshot: null,
  seatId: null,
  connectionState: "idle",
  error: null,
  banner: null,
  levelAdvanceOverlayHoldUntilMs: null,
  nowMs: initialNow,
  clockMode: "real",
  setBootstrap: (payload) =>
    set({
      snapshot: payload.snapshot,
      seatId: payload.seatId,
      connectionState: "connecting",
      error: null,
      levelAdvanceOverlayHoldUntilMs: null
    }),
  applyServerEvent: (event) =>
    set((state) => {
      const nextSnapshot = "snapshot" in event ? event.snapshot : (event.snapshot ?? state.snapshot);
      const shouldClearLevelAdvanceHold =
        nextSnapshot?.phase !== "between_levels" || nextSnapshot.summary?.kind !== "level_cleared";

      return {
        snapshot: nextSnapshot,
        error: event.type === "room_error" ? event.message : null,
        banner: bannerFromEvent(event) ?? state.banner,
        levelAdvanceOverlayHoldUntilMs:
          event.type === "level_cleared"
            ? Date.now() + LEVEL_ADVANCE_OVERLAY_DELAY_MS
            : shouldClearLevelAdvanceHold
              ? null
              : state.levelAdvanceOverlayHoldUntilMs,
        connectionState: event.type === "room_error" ? "error" : state.connectionState
      };
    }),
  setConnectionState: (connectionState) =>
    set({
      connectionState
    }),
  setError: (error) =>
    set({
      error,
      banner: error
        ? {
            celebration: null,
            tone: "danger",
            text: error
          }
        : null
    }),
  clearBanner: () =>
    set({
      banner: null
    }),
  advanceTime: (milliseconds) =>
    set((state) => ({
      clockMode: "virtual",
      nowMs: state.nowMs + milliseconds
    })),
  tickRealClock: () =>
    set((state) =>
      state.clockMode === "real"
        ? {
            nowMs: Date.now()
          }
        : state
    ),
  reset: () =>
    set({
      snapshot: null,
      seatId: null,
      connectionState: "idle",
      error: null,
      banner: null,
      levelAdvanceOverlayHoldUntilMs: null,
      nowMs: Date.now(),
      clockMode: "real"
    })
}));

export function installClientTestHooks(): void {
  window.render_game_to_text = () => textStateFromSnapshot(useRoomStore.getState().snapshot, useRoomStore.getState().nowMs);
  window.advanceTime = (milliseconds: number) => {
    useRoomStore.getState().advanceTime(milliseconds);
  };
}

declare global {
  interface Window {
    render_game_to_text: () => string;
    advanceTime: (milliseconds: number) => void;
  }
}


