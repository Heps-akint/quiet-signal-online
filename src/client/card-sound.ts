import { useEffect, useRef } from "react";
import type { RoomState } from "@shared/protocol";

interface CardSoundEngine {
  unlock: () => Promise<void>;
  tap: () => void;
  move: (options?: { dealt?: boolean }) => void;
  place: (options?: { discard?: boolean; count?: number }) => void;
  celebrate: (options?: { grand?: boolean }) => void;
  warnLifeLoss: () => void;
  mournLoss: () => void;
  dispose: () => void;
}

export type RoomSoundCue =
  | "level_clear"
  | "game_won"
  | "life_warning"
  | "game_lost"
  | null;

const ALERT_CUE_GAIN_MULTIPLIER = 1.62;

export function getRoomSoundCue(
  previousSnapshot: RoomState | null,
  snapshot: RoomState | null
): RoomSoundCue {
  if (!snapshot || !previousSnapshot) {
    return null;
  }

  if (snapshot.summary?.kind === "game_won" && previousSnapshot.summary?.kind !== "game_won") {
    return "game_won";
  }

  if (snapshot.summary?.kind === "level_cleared" && previousSnapshot.summary?.kind !== "level_cleared") {
    return "level_clear";
  }

  if (snapshot.summary?.kind === "game_lost" && previousSnapshot.summary?.kind !== "game_lost") {
    return "game_lost";
  }

  if (snapshot.lives < previousSnapshot.lives) {
    return "life_warning";
  }

  return null;
}

function createNoiseBuffer(audioContext: AudioContext): AudioBuffer {
  const sampleRate = audioContext.sampleRate;
  const frameCount = Math.max(1, Math.floor(sampleRate * 0.12));
  const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
  const channel = buffer.getChannelData(0);

  for (let index = 0; index < frameCount; index += 1) {
    channel[index] = (Math.random() * 2 - 1) * (1 - index / frameCount);
  }

  return buffer;
}

function alertGain(gain: number): number {
  return gain * ALERT_CUE_GAIN_MULTIPLIER;
}

function createCardSoundEngine(): CardSoundEngine {
  let audioContext: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;

  function getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") {
      return null;
    }

    const AudioContextCtor = window.AudioContext ?? null;
    if (!AudioContextCtor) {
      return null;
    }

    if (audioContext) {
      return audioContext;
    }

    audioContext = new AudioContextCtor();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 0.34;
    masterGain.connect(audioContext.destination);
    noiseBuffer = createNoiseBuffer(audioContext);
    return audioContext;
  }

  function getMasterGain(): GainNode | null {
    return masterGain;
  }

  function pulseTone(options: {
    frequency: number;
    endFrequency: number;
    gain: number;
    duration: number;
    attack?: number;
    startAt?: number;
    lowpassFrequency?: number;
    resonance?: number;
    type?: OscillatorType;
  }) {
    const context = getAudioContext();
    const output = getMasterGain();
    if (!context || !output) {
      return;
    }

    const startAt = options.startAt ?? context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();

    oscillator.type = options.type ?? "triangle";
    oscillator.frequency.setValueAtTime(options.frequency, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(60, options.endFrequency),
      startAt + options.duration
    );

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(options.lowpassFrequency ?? 1700, startAt);
    filter.Q.value = options.resonance ?? 0.8;

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(options.gain, startAt + (options.attack ?? 0.01));
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + options.duration);

    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(output);

    oscillator.start(startAt);
    oscillator.stop(startAt + options.duration + 0.02);
  }

  function burstNoise(options: {
    gain: number;
    duration: number;
    highpass: number;
    lowpass: number;
    startAt?: number;
  }) {
    const context = getAudioContext();
    const output = getMasterGain();
    if (!context || !output || !noiseBuffer) {
      return;
    }

    const startAt = options.startAt ?? context.currentTime;
    const source = context.createBufferSource();
    const bandpass = context.createBiquadFilter();
    const lowpass = context.createBiquadFilter();
    const gain = context.createGain();

    source.buffer = noiseBuffer;

    bandpass.type = "highpass";
    bandpass.frequency.setValueAtTime(options.highpass, startAt);

    lowpass.type = "lowpass";
    lowpass.frequency.setValueAtTime(options.lowpass, startAt);

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(options.gain, startAt + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + options.duration);

    source.connect(bandpass);
    bandpass.connect(lowpass);
    lowpass.connect(gain);
    gain.connect(output);

    source.start(startAt);
    source.stop(startAt + options.duration + 0.03);
  }

  function pulseWarmthLayer(options: {
    frequency: number;
    endFrequency: number;
    gain: number;
    duration: number;
    startAt?: number;
  }) {
    pulseTone({
      ...options,
      attack: 0.022,
      lowpassFrequency: 1300,
      resonance: 0.5,
      type: "sine"
    });
  }

  return {
    unlock: async () => {
      const context = getAudioContext();
      if (!context) {
        return;
      }

      if (context.state === "suspended") {
        await context.resume();
      }
    },
    tap: () => {
      const context = getAudioContext();
      if (!context) {
        return;
      }

      const startAt = context.currentTime + 0.005;
      burstNoise({
        gain: 0.09,
        duration: 0.05,
        highpass: 700,
        lowpass: 2500,
        startAt
      });
      pulseTone({
        frequency: 560,
        endFrequency: 340,
        gain: 0.018,
        duration: 0.08,
        startAt,
        type: "triangle"
      });
    },
    move: (options) => {
      const context = getAudioContext();
      if (!context) {
        return;
      }

      const startAt = context.currentTime + 0.01;
      const dealt = Boolean(options?.dealt);
      burstNoise({
        gain: dealt ? 0.08 : 0.06,
        duration: dealt ? 0.09 : 0.07,
        highpass: 420,
        lowpass: dealt ? 1700 : 1450,
        startAt
      });
      pulseTone({
        frequency: dealt ? 310 : 260,
        endFrequency: dealt ? 220 : 180,
        gain: dealt ? 0.02 : 0.014,
        duration: dealt ? 0.14 : 0.1,
        startAt,
        type: "sine"
      });
    },
    place: (options) => {
      const context = getAudioContext();
      if (!context) {
        return;
      }

      const startAt = context.currentTime + 0.01;
      const discard = Boolean(options?.discard);
      const count = Math.max(1, options?.count ?? 1);
      const layeredGain = Math.min(0.018 + count * 0.004, 0.032);

      burstNoise({
        gain: discard ? 0.06 : 0.075,
        duration: discard ? 0.07 : 0.09,
        highpass: discard ? 480 : 360,
        lowpass: discard ? 1600 : 1300,
        startAt
      });
      pulseTone({
        frequency: discard ? 240 : 200,
        endFrequency: discard ? 160 : 130,
        gain: layeredGain,
        duration: discard ? 0.12 : 0.16,
        startAt,
        type: "triangle"
      });
      pulseTone({
        frequency: discard ? 370 : 310,
        endFrequency: discard ? 250 : 220,
        gain: discard ? 0.008 : 0.01,
        duration: 0.11,
        startAt: startAt + 0.012,
        type: "sine"
      });
    },
    celebrate: (options) => {
      const context = getAudioContext();
      if (!context) {
        return;
      }

      const startAt = context.currentTime + 0.012;
      const grand = Boolean(options?.grand);
      const notes = grand
        ? [
            { duration: 0.28, endFrequency: 510, frequency: 523.25, gain: alertGain(0.03), startAt },
            { duration: 0.32, endFrequency: 639, frequency: 659.25, gain: alertGain(0.028), startAt: startAt + 0.12 },
            { duration: 0.38, endFrequency: 760, frequency: 783.99, gain: alertGain(0.03), startAt: startAt + 0.28 },
            { duration: 0.5, endFrequency: 986, frequency: 1046.5, gain: alertGain(0.026), startAt: startAt + 0.46 }
          ]
        : [
            { duration: 0.22, endFrequency: 510, frequency: 523.25, gain: alertGain(0.034), startAt },
            { duration: 0.27, endFrequency: 640, frequency: 659.25, gain: alertGain(0.032), startAt: startAt + 0.1 },
            { duration: 0.36, endFrequency: 760, frequency: 783.99, gain: alertGain(0.03), startAt: startAt + 0.24 }
          ];

      for (const note of notes) {
        pulseTone({
          attack: 0.014,
          duration: note.duration,
          endFrequency: note.endFrequency,
          frequency: note.frequency,
          gain: note.gain,
          lowpassFrequency: grand ? 2600 : 2800,
          resonance: 0.92,
          startAt: note.startAt,
          type: "sine"
        });
        pulseTone({
          attack: 0.012,
          duration: note.duration * 0.78,
          endFrequency: note.endFrequency * 1.5,
          frequency: note.frequency * 1.5,
          gain: note.gain * 0.28,
          lowpassFrequency: grand ? 3400 : 3600,
          resonance: 0.88,
          startAt: note.startAt + 0.01,
          type: "triangle"
        });
        pulseWarmthLayer({
          duration: note.duration * 1.08,
          endFrequency: note.endFrequency * 0.5,
          frequency: note.frequency * 0.5,
          gain: note.gain * 0.4,
          startAt: note.startAt + 0.012
        });
        burstNoise({
          duration: 0.08,
          gain: grand ? alertGain(0.028) : alertGain(0.032),
          highpass: 1400,
          lowpass: grand ? 5600 : 5200,
          startAt: note.startAt
        });
      }
    },
    warnLifeLoss: () => {
      const context = getAudioContext();
      if (!context) {
        return;
      }

      const startAt = context.currentTime + 0.012;
      burstNoise({
        gain: alertGain(0.04),
        duration: 0.16,
        highpass: 900,
        lowpass: 3400,
        startAt
      });
      pulseTone({
        frequency: 196,
        endFrequency: 208,
        gain: alertGain(0.036),
        duration: 0.26,
        attack: 0.015,
        lowpassFrequency: 2300,
        resonance: 0.92,
        startAt,
        type: "triangle"
      });
      pulseTone({
        frequency: 207.65,
        endFrequency: 220,
        gain: alertGain(0.027),
        duration: 0.28,
        attack: 0.016,
        lowpassFrequency: 2500,
        resonance: 0.9,
        startAt: startAt + 0.04,
        type: "triangle"
      });
      pulseWarmthLayer({
        duration: 0.34,
        endFrequency: 104,
        frequency: 98,
        gain: alertGain(0.02),
        startAt: startAt + 0.008
      });
      burstNoise({
        gain: alertGain(0.032),
        duration: 0.12,
        highpass: 1100,
        lowpass: 3800,
        startAt: startAt + 0.19
      });
      pulseTone({
        frequency: 196,
        endFrequency: 174.61,
        gain: alertGain(0.034),
        duration: 0.38,
        attack: 0.018,
        lowpassFrequency: 2200,
        resonance: 0.88,
        startAt: startAt + 0.2,
        type: "triangle"
      });
      pulseWarmthLayer({
        duration: 0.42,
        endFrequency: 87.31,
        frequency: 98,
        gain: alertGain(0.018),
        startAt: startAt + 0.208
      });
    },
    mournLoss: () => {
      const context = getAudioContext();
      if (!context) {
        return;
      }

      const startAt = context.currentTime + 0.02;
      burstNoise({
        gain: alertGain(0.024),
        duration: 0.24,
        highpass: 180,
        lowpass: 900,
        startAt
      });

      const notes = [
        {
          duration: 0.34,
          endFrequency: 349.23,
          frequency: 392,
          gain: alertGain(0.032),
          startAt,
          type: "triangle" as const
        },
        {
          duration: 0.48,
          endFrequency: 293.66,
          frequency: 329.63,
          gain: alertGain(0.028),
          startAt: startAt + 0.18,
          type: "sine" as const
        },
        {
          duration: 0.76,
          endFrequency: 196,
          frequency: 246.94,
          gain: alertGain(0.034),
          startAt: startAt + 0.42,
          type: "triangle" as const
        },
        {
          duration: 0.86,
          endFrequency: 130.81,
          frequency: 164.81,
          gain: alertGain(0.024),
          startAt: startAt + 0.44,
          type: "sine" as const
        }
      ];

      for (const note of notes) {
        pulseTone({
          ...note,
          attack: 0.02,
          lowpassFrequency: 2100,
          resonance: 0.82
        });
        pulseWarmthLayer({
          duration: note.duration * 1.08,
          endFrequency: note.endFrequency * 0.5,
          frequency: note.frequency * 0.5,
          gain: note.gain * 0.44,
          startAt: note.startAt + 0.012
        });
      }
    },
    dispose: () => {
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close();
      }
      audioContext = null;
      masterGain = null;
      noiseBuffer = null;
    }
  };
}

function handChanged(previous: RoomState, next: RoomState): boolean {
  const previousSelf = previous.players[previous.viewerSeatId];
  const nextSelf = next.players[next.viewerSeatId];

  if (previousSelf.hand.length !== nextSelf.hand.length) {
    return true;
  }

  return nextSelf.hand.some((value, index) => value !== previousSelf.hand[index]);
}

export function useRoomCardSounds(snapshot: RoomState | null) {
  const engineRef = useRef<CardSoundEngine | null>(null);
  const previousSnapshotRef = useRef<RoomState | null>(null);

  if (engineRef.current === null) {
    engineRef.current = createCardSoundEngine();
  }

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) {
      return undefined;
    }

    const unlock = () => {
      void engine.unlock();
    };

    window.addEventListener("pointerdown", unlock, {
      passive: true
    });
    window.addEventListener("keydown", unlock);

    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    const previousSnapshot = previousSnapshotRef.current;

    previousSnapshotRef.current = snapshot;

    if (!engine || !snapshot || !previousSnapshot) {
      return;
    }

    const cue = getRoomSoundCue(previousSnapshot, snapshot);
    if (cue === "level_clear") {
      engine.celebrate();
    } else if (cue === "game_won") {
      engine.celebrate({
        grand: true
      });
    } else if (cue === "life_warning") {
      engine.warnLifeLoss();
    } else if (cue === "game_lost") {
      engine.mournLoss();
      return;
    }

    if (snapshot.pile.length > previousSnapshot.pile.length) {
      const newestCard = snapshot.pile[snapshot.pile.length - 1];
      engine.place({
        discard: newestCard?.resolution !== "played",
        count: snapshot.pile.length - previousSnapshot.pile.length
      });
      return;
    }

    if (handChanged(previousSnapshot, snapshot)) {
      const previousSelf = previousSnapshot.players[previousSnapshot.viewerSeatId];
      const nextSelf = snapshot.players[snapshot.viewerSeatId];
      engine.move({
        dealt: nextSelf.hand.length > previousSelf.hand.length
      });
    }
  }, [snapshot]);

  return {
    playCardTap: () => {
      engineRef.current?.tap();
    }
  };
}
