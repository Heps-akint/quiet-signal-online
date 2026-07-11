import { useEffect, useRef } from "react";
import type { RoomState } from "@shared/protocol";

interface CardSoundEngine {
  unlock: () => Promise<void>;
  tap: () => void;
  move: (options?: { dealt?: boolean }) => void;
  place: (options?: { discard?: boolean; star?: boolean; count?: number }) => void;
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

const ALERT_CUE_GAIN_MULTIPLIER = 1.22;

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

function seededNoise(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function createNoiseBuffer(audioContext: AudioContext): AudioBuffer {
  const sampleRate = audioContext.sampleRate;
  const frameCount = Math.max(1, Math.floor(sampleRate * 0.65));
  const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
  const channel = buffer.getChannelData(0);
  const random = seededNoise(0x51_47_4c_45);
  let smoothed = 0;

  for (let index = 0; index < frameCount; index += 1) {
    const white = random() * 2 - 1;
    smoothed = smoothed * 0.72 + white * 0.28;
    channel[index] = smoothed;
  }

  return buffer;
}

function createRoomImpulse(audioContext: AudioContext): AudioBuffer {
  const sampleRate = audioContext.sampleRate;
  const frameCount = Math.max(1, Math.floor(sampleRate * 0.48));
  const buffer = audioContext.createBuffer(2, frameCount, sampleRate);

  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex);
    const random = seededNoise(0x4d_49_4e_44 + channelIndex * 97);
    let smoothed = 0;

    for (let index = 0; index < frameCount; index += 1) {
      const progress = index / frameCount;
      const decay = Math.pow(1 - progress, 3.6);
      const white = random() * 2 - 1;
      smoothed = smoothed * 0.62 + white * 0.38;
      channel[index] = smoothed * decay * 0.52;
    }
  }

  return buffer;
}

function alertGain(gain: number): number {
  return gain * ALERT_CUE_GAIN_MULTIPLIER;
}

function createCardSoundEngine(): CardSoundEngine {
  let audioContext: AudioContext | null = null;
  let mixBus: GainNode | null = null;
  let masterGain: GainNode | null = null;
  let reverbInput: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let warmWave: PeriodicWave | null = null;

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

    mixBus = audioContext.createGain();
    const lowShelf = audioContext.createBiquadFilter();
    const highShelf = audioContext.createBiquadFilter();
    const compressor = audioContext.createDynamicsCompressor();
    masterGain = audioContext.createGain();

    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 190;
    lowShelf.gain.value = 2.4;

    highShelf.type = "highshelf";
    highShelf.frequency.value = 2800;
    highShelf.gain.value = -2.8;

    compressor.threshold.value = -21;
    compressor.knee.value = 18;
    compressor.ratio.value = 3.2;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.2;

    masterGain.gain.value = 0.48;
    mixBus.connect(lowShelf);
    lowShelf.connect(highShelf);
    highShelf.connect(compressor);
    compressor.connect(masterGain);
    masterGain.connect(audioContext.destination);

    reverbInput = audioContext.createGain();
    const convolver = audioContext.createConvolver();
    const reverbTone = audioContext.createBiquadFilter();
    const reverbGain = audioContext.createGain();
    convolver.buffer = createRoomImpulse(audioContext);
    reverbTone.type = "lowpass";
    reverbTone.frequency.value = 2100;
    reverbGain.gain.value = 0.26;
    reverbInput.connect(convolver);
    convolver.connect(reverbTone);
    reverbTone.connect(reverbGain);
    reverbGain.connect(compressor);

    warmWave = audioContext.createPeriodicWave(
      new Float32Array([0, 0, 0, 0, 0, 0]),
      new Float32Array([0, 1, 0.3, 0.11, 0.045, 0.018]),
      { disableNormalization: false }
    );
    noiseBuffer = createNoiseBuffer(audioContext);
    return audioContext;
  }

  function connectVoice(node: AudioNode, reverbAmount: number) {
    if (!audioContext || !mixBus) {
      return;
    }

    node.connect(mixBus);
    if (reverbAmount > 0 && reverbInput) {
      const send = audioContext.createGain();
      send.gain.value = reverbAmount;
      node.connect(send);
      send.connect(reverbInput);
    }
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
    reverb?: number;
    detune?: number;
    type?: OscillatorType;
  }) {
    const context = getAudioContext();
    if (!context || !mixBus) {
      return;
    }

    const startAt = options.startAt ?? context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();

    if ((options.type ?? "triangle") === "triangle" && warmWave) {
      oscillator.setPeriodicWave(warmWave);
    } else {
      oscillator.type = options.type ?? "sine";
    }
    oscillator.frequency.setValueAtTime(options.frequency, startAt);
    oscillator.detune.setValueAtTime(options.detune ?? 0, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(60, options.endFrequency),
      startAt + options.duration
    );

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(options.lowpassFrequency ?? 1700, startAt);
    filter.Q.value = options.resonance ?? 0.8;

    gain.gain.setValueAtTime(0.0001, startAt);
    const attack = options.attack ?? 0.012;
    gain.gain.linearRampToValueAtTime(options.gain, startAt + attack);
    gain.gain.setValueAtTime(options.gain, startAt + Math.min(options.duration * 0.38, attack + 0.025));
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + options.duration);

    oscillator.connect(filter);
    filter.connect(gain);
    connectVoice(gain, options.reverb ?? 0.035);

    oscillator.start(startAt);
    oscillator.stop(startAt + options.duration + 0.02);
  }

  function burstNoise(options: {
    gain: number;
    duration: number;
    highpass: number;
    lowpass: number;
    attack?: number;
    reverb?: number;
    startAt?: number;
  }) {
    const context = getAudioContext();
    if (!context || !mixBus || !noiseBuffer) {
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
    gain.gain.linearRampToValueAtTime(options.gain, startAt + (options.attack ?? 0.006));
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + options.duration);

    source.connect(bandpass);
    bandpass.connect(lowpass);
    lowpass.connect(gain);
    connectVoice(gain, options.reverb ?? 0.018);

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
      lowpassFrequency: 950,
      resonance: 0.5,
      reverb: 0.06,
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
        gain: 0.052,
        duration: 0.045,
        highpass: 260,
        lowpass: 1450,
        reverb: 0.008,
        startAt
      });
      pulseTone({
        frequency: 185,
        endFrequency: 118,
        gain: 0.052,
        duration: 0.115,
        lowpassFrequency: 760,
        reverb: 0.012,
        startAt,
        type: "triangle"
      });
      pulseTone({
        frequency: 340,
        endFrequency: 245,
        gain: 0.012,
        duration: 0.075,
        lowpassFrequency: 1250,
        reverb: 0.01,
        startAt: startAt + 0.004,
        type: "sine"
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
        gain: dealt ? 0.052 : 0.04,
        duration: dealt ? 0.11 : 0.085,
        highpass: 180,
        lowpass: dealt ? 1200 : 980,
        attack: 0.012,
        reverb: 0.018,
        startAt
      });
      pulseTone({
        frequency: dealt ? 168 : 146,
        endFrequency: dealt ? 122 : 108,
        gain: dealt ? 0.032 : 0.024,
        duration: dealt ? 0.17 : 0.13,
        lowpassFrequency: 820,
        reverb: 0.025,
        startAt,
        type: "triangle"
      });
    },
    place: (options) => {
      const context = getAudioContext();
      if (!context) {
        return;
      }

      const startAt = context.currentTime + 0.01;
      const discard = Boolean(options?.discard);
      const star = Boolean(options?.star);
      const count = Math.max(1, options?.count ?? 1);
      const layeredGain = Math.min(0.048 + count * 0.006, 0.072);

      if (star) {
        burstNoise({
          gain: 0.038,
          duration: 0.14,
          highpass: 280,
          lowpass: 1550,
          attack: 0.022,
          reverb: 0.05,
          startAt
        });
        pulseTone({
          frequency: 196,
          endFrequency: 220,
          gain: 0.032,
          duration: 0.24,
          attack: 0.025,
          lowpassFrequency: 1050,
          reverb: 0.09,
          startAt,
          type: "triangle"
        });
        pulseTone({
          frequency: 293.66,
          endFrequency: 329.63,
          gain: 0.018,
          duration: 0.28,
          attack: 0.03,
          lowpassFrequency: 1350,
          reverb: 0.11,
          startAt: startAt + 0.045,
          type: "sine"
        });
        return;
      }

      burstNoise({
        gain: discard ? 0.04 : 0.05,
        duration: discard ? 0.08 : 0.095,
        highpass: discard ? 250 : 180,
        lowpass: discard ? 1300 : 1050,
        reverb: 0.014,
        startAt
      });
      pulseTone({
        frequency: discard ? 158 : 132,
        endFrequency: discard ? 105 : 82,
        gain: layeredGain,
        duration: discard ? 0.15 : 0.19,
        lowpassFrequency: 720,
        reverb: 0.025,
        startAt,
        type: "triangle"
      });
      pulseTone({
        frequency: discard ? 285 : 240,
        endFrequency: discard ? 205 : 170,
        gain: discard ? 0.01 : 0.014,
        duration: 0.12,
        lowpassFrequency: 1200,
        reverb: 0.02,
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
            { duration: 0.42, frequency: 261.63, gain: alertGain(0.038), startAt },
            { duration: 0.46, frequency: 329.63, gain: alertGain(0.036), startAt: startAt + 0.14 },
            { duration: 0.52, frequency: 392, gain: alertGain(0.038), startAt: startAt + 0.32 },
            { duration: 0.68, frequency: 523.25, gain: alertGain(0.034), startAt: startAt + 0.54 }
          ]
        : [
            { duration: 0.36, frequency: 261.63, gain: alertGain(0.04), startAt },
            { duration: 0.42, frequency: 329.63, gain: alertGain(0.038), startAt: startAt + 0.13 },
            { duration: 0.52, frequency: 392, gain: alertGain(0.038), startAt: startAt + 0.3 }
          ];

      for (const note of notes) {
        pulseTone({
          attack: 0.02,
          duration: note.duration,
          endFrequency: note.frequency * 0.992,
          frequency: note.frequency,
          gain: note.gain,
          lowpassFrequency: grand ? 1900 : 1750,
          resonance: 0.65,
          reverb: grand ? 0.2 : 0.16,
          startAt: note.startAt,
          type: "triangle"
        });
        pulseTone({
          attack: 0.026,
          duration: note.duration * 1.12,
          endFrequency: note.frequency * 0.496,
          frequency: note.frequency * 0.5,
          gain: note.gain * 0.42,
          lowpassFrequency: 820,
          resonance: 0.45,
          reverb: grand ? 0.16 : 0.12,
          startAt: note.startAt + 0.008,
          type: "sine"
        });
        burstNoise({
          duration: 0.055,
          gain: grand ? 0.014 : 0.012,
          highpass: 420,
          lowpass: 1750,
          reverb: 0.035,
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
        gain: alertGain(0.026),
        duration: 0.12,
        highpass: 220,
        lowpass: 1150,
        reverb: 0.025,
        startAt
      });
      pulseTone({
        frequency: 196,
        endFrequency: 185,
        gain: alertGain(0.046),
        duration: 0.3,
        attack: 0.02,
        lowpassFrequency: 1050,
        resonance: 0.6,
        reverb: 0.08,
        startAt,
        type: "triangle"
      });
      pulseTone({
        frequency: 207.65,
        endFrequency: 196,
        gain: alertGain(0.032),
        duration: 0.28,
        attack: 0.022,
        lowpassFrequency: 1100,
        resonance: 0.55,
        reverb: 0.07,
        startAt: startAt + 0.035,
        type: "sine"
      });
      pulseTone({
        frequency: 174.61,
        endFrequency: 146.83,
        gain: alertGain(0.044),
        duration: 0.46,
        attack: 0.024,
        lowpassFrequency: 980,
        resonance: 0.55,
        reverb: 0.1,
        startAt: startAt + 0.22,
        type: "triangle"
      });
      pulseWarmthLayer({
        duration: 0.5,
        endFrequency: 73.42,
        frequency: 87.31,
        gain: alertGain(0.024),
        startAt: startAt + 0.228
      });
    },
    mournLoss: () => {
      const context = getAudioContext();
      if (!context) {
        return;
      }

      const startAt = context.currentTime + 0.02;
      burstNoise({
        gain: alertGain(0.018),
        duration: 0.2,
        highpass: 120,
        lowpass: 720,
        reverb: 0.06,
        startAt
      });

      const notes = [
        {
          duration: 0.46,
          endFrequency: 261.63,
          frequency: 293.66,
          gain: alertGain(0.04),
          startAt,
          type: "triangle" as const
        },
        {
          duration: 0.58,
          endFrequency: 196,
          frequency: 220,
          gain: alertGain(0.036),
          startAt: startAt + 0.2,
          type: "sine" as const
        },
        {
          duration: 0.82,
          endFrequency: 146.83,
          frequency: 174.61,
          gain: alertGain(0.042),
          startAt: startAt + 0.48,
          type: "triangle" as const
        },
        {
          duration: 0.92,
          endFrequency: 73.42,
          frequency: 87.31,
          gain: alertGain(0.03),
          startAt: startAt + 0.5,
          type: "sine" as const
        }
      ];

      for (const note of notes) {
        pulseTone({
          ...note,
          attack: 0.028,
          lowpassFrequency: 1050,
          resonance: 0.55,
          reverb: 0.14
        });
        pulseWarmthLayer({
          duration: note.duration * 1.08,
          endFrequency: note.endFrequency * 0.5,
          frequency: note.frequency * 0.5,
          gain: note.gain * 0.38,
          startAt: note.startAt + 0.012
        });
      }
    },
    dispose: () => {
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close();
      }
      audioContext = null;
      mixBus = null;
      masterGain = null;
      reverbInput = null;
      noiseBuffer = null;
      warmWave = null;
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
        star: newestCard?.resolution === "scan_discard",
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
