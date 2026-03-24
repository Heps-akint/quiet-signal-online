import { describe, expect, it } from "vitest";
import {
  bootstrapSeat,
  createPublicRoomState,
  createRoomEngineState,
  maybeAdvanceTimedPhase,
  playLowestCard,
  readyForLevel,
  type DebugRoomPreset,
  type RoomEngineState
} from "@shared/game-core";
import { getRoomSoundCue } from "@client/card-sound";

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

function toHostView(state: RoomEngineState) {
  return createPublicRoomState(
    state,
    "host",
    "https://example.com",
    {
      host: "host-token-123456",
      guest: "guest-token-123456"
    },
    state.lastActivityAt + 1
  );
}

describe("room sound cues", () => {
  it("plays the life warning cue when a misplay burns a life but the run continues", () => {
    const before = makeLiveState(2, {
      deals: {
        2: {
          host: [40, 80],
          guest: [25, 60]
        }
      }
    });

    const after = playLowestCard(before, "host", 100).state;

    expect(getRoomSoundCue(toHostView(before), toHostView(after))).toBe("life_warning");
  });

  it("plays the game over cue instead of the warning cue when the last life is lost", () => {
    const before = {
      ...makeLiveState(2, {
        deals: {
          2: {
            host: [40, 80],
            guest: [25, 60]
          }
        }
      }),
      lives: 1
    };

    const after = playLowestCard(before, "host", 100).state;

    expect(toHostView(after).phase).toBe("lost");
    expect(getRoomSoundCue(toHostView(before), toHostView(after))).toBe("game_lost");
  });

  it("keeps the level clear cue for successful round completion", () => {
    const roundStart = makeLiveState(1, {
      deals: {
        1: {
          host: [10],
          guest: [90]
        }
      }
    });
    const midRound = playLowestCard(roundStart, "host", 100).state;
    const after = playLowestCard(midRound, "guest", 120).state;

    expect(getRoomSoundCue(toHostView(midRound), toHostView(after))).toBe("level_clear");
  });
});
