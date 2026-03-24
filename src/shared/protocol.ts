import { z } from "zod";

export const MAX_LEVEL = 12;
export const STARTING_LIVES = 2;
export const STARTING_SCANS = 1;
export const ROOM_RESUME_TTL_MS = 24 * 60 * 60 * 1000;
export const FOCUS_TRANSITION_MS = 2000;
export const MAX_PLAYER_NAME_LENGTH = 24;
export const ROOM_ID_LENGTH = 6;
export const ROOM_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export const seatIds = ["host", "guest"] as const;
export const seatIdSchema = z.enum(seatIds);
export type SeatId = z.infer<typeof seatIdSchema>;
export const roomIdSchema = z.string().regex(new RegExp(`^[${ROOM_ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`, "u"));
export const inviteTokenSchema = z.string().min(16).max(128);
export const websocketTicketSchema = z.string().min(16).max(128);

export const roomPhaseSchema = z.enum([
  "waiting",
  "between_levels",
  "focus_transition",
  "in_round",
  "paused",
  "won",
  "lost"
]);
export type RoomPhase = z.infer<typeof roomPhaseSchema>;

export const cardValueSchema = z.number().int().min(1).max(100);
export const levelSchema = z.number().int().min(1).max(MAX_LEVEL);
const timestampSchema = z.number().int().nonnegative();

export const resumeSnapshotSchema = z.object({
  joinedAt: timestampSchema.nullable(),
  lastSeenAt: timestampSchema.nullable(),
  canReconnectUntil: timestampSchema.nullable()
});
export type ResumeSnapshot = z.infer<typeof resumeSnapshotSchema>;

export const resolvedCardSchema = z.object({
  seatId: seatIdSchema,
  value: cardValueSchema,
  level: levelSchema,
  resolution: z.enum(["played", "misplay_discard", "scan_discard"]),
  timestamp: timestampSchema
});
export type ResolvedCard = z.infer<typeof resolvedCardSchema>;

const approvalsSchema = z.object({
  host: z.boolean(),
  guest: z.boolean()
});

const pauseRequestSchema = z.object({
  kind: z.literal("pause"),
  requesterSeatId: seatIdSchema,
  approvals: approvalsSchema
});

const scanRequestSchema = z.object({
  kind: z.literal("scan"),
  requesterSeatId: seatIdSchema,
  approvals: approvalsSchema
});

export const pendingRequestSchema = z
  .discriminatedUnion("kind", [pauseRequestSchema, scanRequestSchema])
  .nullable();
export type PendingRequest = z.infer<typeof pendingRequestSchema>;

export const levelRewardSchema = z.object({
  life: z.boolean(),
  scan: z.boolean()
});
export type LevelReward = z.infer<typeof levelRewardSchema>;

export const roomSummarySchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("level_cleared"),
      level: levelSchema,
      rewards: levelRewardSchema,
      message: z.string()
    }),
    z.object({
      kind: z.literal("misplay"),
      level: levelSchema,
      triggeringSeatId: seatIdSchema,
      playedCard: cardValueSchema,
      discardedCards: z.array(resolvedCardSchema),
      livesRemaining: z.number().int().min(0),
      message: z.string()
    }),
    z.object({
      kind: z.literal("scan"),
      level: levelSchema,
      discardedCards: z.array(resolvedCardSchema),
      scansRemaining: z.number().int().min(0),
      message: z.string()
    }),
    z.object({
      kind: z.literal("game_won"),
      level: levelSchema,
      message: z.string()
    }),
    z.object({
      kind: z.literal("game_lost"),
      level: levelSchema,
      livesRemaining: z.number().int().min(0),
      message: z.string()
    })
  ])
  .nullable();
export type RoomSummary = z.infer<typeof roomSummarySchema>;

export const playerStateSchema = z.object({
  seatId: seatIdSchema,
  displayName: z.string().min(1).max(MAX_PLAYER_NAME_LENGTH),
  isSelf: z.boolean(),
  hasJoined: z.boolean(),
  connected: z.boolean(),
  ready: z.boolean(),
  hand: z.array(cardValueSchema),
  handCount: z.number().int().min(0),
  resume: resumeSnapshotSchema
});
export type PlayerState = z.infer<typeof playerStateSchema>;

export const roomStateSchema = z.object({
  roomId: roomIdSchema,
  viewerSeatId: seatIdSchema,
  phase: roomPhaseSchema,
  currentLevel: levelSchema,
  maxLevel: z.literal(MAX_LEVEL),
  lives: z.number().int().min(0),
  scans: z.number().int().min(0),
  players: z.object({
    host: playerStateSchema,
    guest: playerStateSchema
  }),
  pile: z.array(resolvedCardSchema),
  pendingRequest: pendingRequestSchema,
  summary: roomSummarySchema,
  transitionEndsAt: timestampSchema.nullable(),
  eventId: z.number().int().min(0),
  lastActivityAt: timestampSchema,
  expiresAt: timestampSchema,
  inviteLink: z.string().url().nullable(),
  canStartLevel: z.boolean(),
  canRequestPause: z.boolean(),
  canRequestScan: z.boolean()
});
export type RoomState = z.infer<typeof roomStateSchema>;

const debugDealSchema = z.object({
  host: z.array(cardValueSchema),
  guest: z.array(cardValueSchema)
});

export const debugPresetSchema = z.object({
  seed: z.number().int().nonnegative().optional(),
  deals: z.record(z.string().regex(/^(?:[1-9]|1[0-2])$/), debugDealSchema).optional()
});
export type DebugPresetInput = z.infer<typeof debugPresetSchema>;

export const createRoomRequestSchema = z
  .object({
    debugPreset: debugPresetSchema.optional()
  })
  .optional()
  .default({});
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;

export const createRoomResponseSchema = z.object({
  roomId: roomIdSchema,
  hostInviteUrl: z.string().url(),
  guestInviteUrl: z.string().url()
});
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;

export const bootstrapRequestSchema = z.object({
  token: inviteTokenSchema
});
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export const bootstrapResponseSchema = z.object({
  roomId: z.string().min(1),
  seatId: seatIdSchema,
  canReconnect: z.boolean(),
  wsPath: z.string().min(1),
  snapshot: roomStateSchema
});
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

export const clientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join_room"),
    lastEventId: z.number().int().min(0).nullable().optional()
  }),
  z.object({
    type: z.literal("set_name"),
    displayName: z.string().trim().min(1).max(MAX_PLAYER_NAME_LENGTH)
  }),
  z.object({
    type: z.literal("ready_for_level")
  }),
  z.object({
    type: z.literal("play_lowest_card")
  }),
  z.object({
    type: z.literal("request_pause")
  }),
  z.object({
    type: z.literal("resume_round")
  }),
  z.object({
    type: z.literal("request_scan")
  }),
  z.object({
    type: z.literal("respond_scan"),
    accepted: z.boolean()
  }),
  z.object({
    type: z.literal("request_rematch")
  }),
  z.object({
    type: z.literal("leave_room")
  })
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;

const snapshotEventBase = z.object({
  snapshot: roomStateSchema,
  serverTime: timestampSchema
});

export const roomSnapshotEventSchema = snapshotEventBase.extend({
  type: z.literal("room_snapshot")
});

export const playerPresenceChangedEventSchema = snapshotEventBase.extend({
  type: z.literal("player_presence_changed"),
  seatId: seatIdSchema,
  connected: z.boolean()
});

export const levelStartedEventSchema = snapshotEventBase.extend({
  type: z.literal("level_started"),
  level: levelSchema
});

export const cardPlayedEventSchema = snapshotEventBase.extend({
  type: z.literal("card_played"),
  seatId: seatIdSchema,
  card: cardValueSchema
});

export const misplayResolvedEventSchema = snapshotEventBase.extend({
  type: z.literal("misplay_resolved"),
  seatId: seatIdSchema,
  card: cardValueSchema,
  discardedCards: z.array(resolvedCardSchema)
});

export const pauseStateChangedEventSchema = snapshotEventBase.extend({
  type: z.literal("pause_state_changed"),
  resumed: z.boolean()
});

export const scanStateChangedEventSchema = snapshotEventBase.extend({
  type: z.literal("scan_state_changed"),
  resolved: z.boolean(),
  accepted: z.boolean(),
  discardedCards: z.array(resolvedCardSchema).optional()
});

export const levelClearedEventSchema = snapshotEventBase.extend({
  type: z.literal("level_cleared"),
  clearedLevel: levelSchema,
  rewards: levelRewardSchema
});

export const gameWonEventSchema = snapshotEventBase.extend({
  type: z.literal("game_won"),
  completedLevel: levelSchema
});

export const gameLostEventSchema = snapshotEventBase.extend({
  type: z.literal("game_lost"),
  failedLevel: levelSchema
});

export const roomErrorEventSchema = z.object({
  type: z.literal("room_error"),
  code: z.enum([
    "unauthorized",
    "invalid_state",
    "validation_failed",
    "conflict",
    "room_not_found"
  ]),
  message: z.string(),
  snapshot: roomStateSchema.optional(),
  serverTime: timestampSchema
});

export const serverEventSchema = z.discriminatedUnion("type", [
  roomSnapshotEventSchema,
  playerPresenceChangedEventSchema,
  levelStartedEventSchema,
  cardPlayedEventSchema,
  misplayResolvedEventSchema,
  pauseStateChangedEventSchema,
  scanStateChangedEventSchema,
  levelClearedEventSchema,
  gameWonEventSchema,
  gameLostEventSchema,
  roomErrorEventSchema
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;


