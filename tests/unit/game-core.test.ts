import { describe, expect, it } from "vitest";
import {
  bootstrapSeat,
  createPublicRoomState,
  createRoomEngineState,
  levelRewards,
  maybeAdvanceTimedPhase,
  requestRematch,
  readyForLevel,
  requestPause,
  requestScan,
  respondScan,
  playLowestCard,
  type DebugRoomPreset,
  type RoomEngineState
} from "@shared/game-core";

function makeLiveState(level: number, debugPreset: DebugRoomPreset): RoomEngineState {
  let state = createRoomEngineState({
    roomId: "room-a",
    seed: debugPreset.seed ?? 1234,
    now: 1,
    debugPreset
  });
  state = bootstrapSeat(state, "host", 10);
  state = bootstrapSeat(state, "guest", 20);
  state = {
    ...state,
    currentLevel: level,
    phase: "between_levels"
  };
  state = readyForLevel(state, "host", 30).state;
  state = readyForLevel(state, "guest", 40).state;
  return maybeAdvanceTimedPhase(state, (state.transitionEndsAt ?? 40) + 1);
}

describe("game core", () => {
  it("maps level rewards correctly", () => {
    expect(levelRewards(1)).toEqual({ life: false, scan: false });
    expect(levelRewards(2)).toEqual({ life: false, scan: true });
    expect(levelRewards(3)).toEqual({ life: true, scan: false });
    expect(levelRewards(8)).toEqual({ life: false, scan: true });
    expect(levelRewards(9)).toEqual({ life: true, scan: false });
  });

  it("resolves a misplay by burning a life and discarding lower hidden cards", () => {
    const state = makeLiveState(2, {
      deals: {
        2: {
          host: [40, 80],
          guest: [25, 60]
        }
      }
    });

    const update = playLowestCard(state, "host", 100);

    expect(update.eventType).toBe("misplay_resolved");
    expect(update.state.lives).toBe(1);
    expect(update.state.players.host.hand).toEqual([80]);
    expect(update.state.players.guest.hand).toEqual([60]);
    expect(update.state.pile.map((card) => card.value)).toEqual([25, 40]);
    expect(update.state.summary).toMatchObject({
      kind: "misplay",
      playedCard: 40,
      livesRemaining: 1
    });
  });

  it("requires both players to resume after a pause request", () => {
    const state = makeLiveState(1, {
      deals: {
        1: {
          host: [33],
          guest: [64]
        }
      }
    });

    const paused = requestPause(state, "host", 50).state;
    expect(paused.phase).toBe("paused");
    expect(paused.pendingRequest?.kind).toBe("pause");
    expect(paused.pendingRequest?.approvals.host).toBe(true);
    expect(paused.pendingRequest?.approvals.guest).toBe(false);
  });

  it("resolves a scan vote by discarding each lowest card once", () => {
    const state = makeLiveState(2, {
      deals: {
        2: {
          host: [10, 90],
          guest: [20, 95]
        }
      }
    });

    const requested = requestScan(state, "host", 60).state;
    const resolved = respondScan(requested, "guest", true, 70);

    expect(resolved.eventType).toBe("scan_state_changed");
    expect(resolved.state.scans).toBe(0);
    expect(resolved.state.players.host.hand).toEqual([90]);
    expect(resolved.state.players.guest.hand).toEqual([95]);
    expect(resolved.state.pile.map((card) => card.value)).toEqual([10, 20]);
    expect(resolved.state.summary).toMatchObject({
      kind: "scan",
      scansRemaining: 0
    });
  });

  it("hides the other player's cards in public snapshots", () => {
    const state = makeLiveState(1, {
      deals: {
        1: {
          host: [11],
          guest: [88]
        }
      }
    });

    const hostView = createPublicRoomState(
      state,
      "host",
      "https://example.com",
      {
        host: "host-token",
        guest: "guest-token"
      },
      90
    );

    expect(hostView.players.host.hand).toEqual([11]);
    expect(hostView.players.guest.hand).toEqual([]);
    expect(hostView.inviteLink).toBe("https://example.com/room/room-a#guest-token");
  });

  it("deals a fresh shuffle on rematch in the same room", () => {
    let state = createRoomEngineState({
      roomId: "room-a",
      seed: 1234,
      now: 1
    });
    state = bootstrapSeat(state, "host", 10);
    state = bootstrapSeat(state, "guest", 20);
    state = {
      ...state,
      phase: "between_levels"
    };

    state = readyForLevel(state, "host", 30).state;
    const firstRun = readyForLevel(state, "guest", 40).state;
    const firstHands = {
      host: [...firstRun.players.host.hand],
      guest: [...firstRun.players.guest.hand]
    };

    const lostState: RoomEngineState = {
      ...firstRun,
      phase: "lost",
      lives: 0,
      pendingRequest: null,
      transitionEndsAt: null
    };

    const hostRequested = requestRematch(lostState, "host", 50).state;
    const rematched = requestRematch(hostRequested, "guest", 60).state;

    expect(rematched.phase).toBe("between_levels");
    expect(rematched.seed).not.toBe(lostState.seed);

    const rematchReadyHost = readyForLevel(rematched, "host", 70).state;
    const rematchStarted = readyForLevel(rematchReadyHost, "guest", 80).state;

    expect({
      host: rematchStarted.players.host.hand,
      guest: rematchStarted.players.guest.hand
    }).not.toEqual(firstHands);
  });
});


