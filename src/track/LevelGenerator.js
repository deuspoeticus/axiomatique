/**
 * LevelGenerator — music-driven procedural level generation.
 *
 * Three lanes = three frequency bands (from constants.js):
 *   BASS_LANE  (-1) = sub-bass / Reese  → long slow platforms
 *   MID_LANE   ( 0) = kick / snare      → regular platforms
 *   HIGH_LANE  (+1) = hats / stabs      → short fast platforms
 *
 * setMusicalState() is called each phrase by Synth.engine.onPhrase.
 * next() reads from the musical pattern array to emit platform events
 * that are directly mapped from musical note structure.
 *
 * No `new` in the hot path after construction.
 */
import {
  BASS_LANE, MID_LANE, HIGH_LANE,
  BPM_RAMP_BEATS,
  INTENSITY_MISS_PENALTY,
} from '../constants.js';

const DIFFICULTY_EVENTS = 120; // legacy compat — still used for decoy ramp
const BREATHER_EVERY    = 10;  // one guaranteed safe center platform every N events

export class LevelGenerator {
  constructor() {
    // Seeded Xorshift32 PRNG
    let s = (Date.now() ^ (Math.random() * 0xffffffff | 0)) >>> 0;
    s ^= s >>> 16;
    s  = Math.imul(s, 0x45d9f3b) >>> 0;
    s ^= s >>> 16;
    this._seed = s || 1;

    this._eventCount   = 0;
    this._platCount    = 0;
    this._wantPlatform = true;

    // Current music state
    this._intensity = 0;
    this._bpm       = 120;
    // Pattern slots from MusicEngine — array of { lane, noteLen, hasEvent }
    this._pattern   = null;
    this._patSlot   = 0; // which slot in the 16-beat pattern to read next

    this._result = { type: 'gap', lane: 0, beats: 2 };
  }

  // Called by MusicEngine.onPhrase each phrase (16 beats)
  setMusicalState(pattern, bpm, intensity) {
    this._pattern   = pattern;
    this._bpm       = bpm;
    this._intensity = intensity;
    // _patSlot is NOT reset — it advances continuously across phrase boundaries.
    // Resetting to 0 each phrase causes only pos 0 (BASS) and pos 1 (MID) to be
    // consumed before the next reset, starving HIGH_LANE of platform events.
  }

  _rand() {
    let s = this._seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this._seed = s >>> 0;
    return this._seed / 0xffffffff;
  }

  _lerp(a, b, t) { return a + (b - a) * t; }

  // Returns the same pre-allocated object each call.
  next() {
    const n   = this._eventCount++;
    const iv  = this._intensity;
    const t   = Math.min(1.0, n / DIFFICULTY_EVENTS);
    const r   = this._result;

    if (this._wantPlatform) {
      this._wantPlatform = false;
      this._platCount++;

      // Guaranteed breather
      if (this._platCount >= 4 && this._platCount % BREATHER_EVERY === 0) {
        r.type  = 'node';
        r.lane  = MID_LANE;
        r.beats = 2 + (iv < 0.3 ? 1 : 0); // longer breather early game
        return r;
      }

      // Read from musical pattern if available
      if (this._pattern) {
        // Find next slot with a musical event
        let slot   = null;
        let tries  = 0;
        while (tries < BPM_RAMP_BEATS) {
          const s = this._pattern[this._patSlot % BPM_RAMP_BEATS];
          this._patSlot++;
          tries++;
          if (s && s.hasEvent) { slot = s; break; }
        }

        if (slot) {
          // Lane from music
          const lane = slot.lane;

          // Note length → platform beats (musical precision grows with intensity)
          let beats;
          if (lane === BASS_LANE) {
            // Bass: always longer platforms
            beats = this._lerp(2, 1, iv);
          } else if (lane === HIGH_LANE) {
            // High: short platforms get shorter as intensity rises
            beats = this._lerp(1, 0.5, iv);
          } else {
            // Mid: regular — starts 1 beat, can shrink to 0.5
            beats = this._lerp(1, 0.5, iv);
          }

          // Decoy chance tied to intensity; starts at 0% so early game is learnable
          const decoyChance = this._lerp(0.00, 0.55, iv);
          r.type  = this._rand() < decoyChance ? 'decoy' : 'node';
          r.lane  = lane;
          r.beats = Math.max(0.5, beats);
          return r;
        }
      }

      // Fallback (no pattern yet — early run); starts at 0% decoys
      const decoyChance = this._lerp(0.00, 0.52, t);
      const offLaneT    = this._lerp(0.00, 0.70, t);
      const rv = this._rand();
      let beats;
      if (t < 0.25)      beats = rv < 0.25 ? 1   : 2;
      else if (t < 0.55) beats = rv < 0.40 ? 1   : (rv < 0.65 ? 2 : 0.5);
      else               beats = rv < 0.55 ? 0.5 : 1;

      let lane = MID_LANE;
      if (this._rand() < offLaneT)
        lane = this._rand() < 0.5 ? BASS_LANE : HIGH_LANE;

      r.type  = this._rand() < decoyChance ? 'decoy' : 'node';
      r.lane  = lane;
      r.beats = Math.max(0.5, beats);

    } else {
      this._wantPlatform = true;

      // Gap length: shorter at high intensity (no breathing room)
      let minGap, maxGap;
      if (iv < 0.3) {
        minGap = 0.5; maxGap = 1;
      } else if (iv < 0.6) {
        minGap = 0.5; maxGap = 0.75;
      } else if (iv < 0.85) {
        minGap = 0.25; maxGap = 0.5;
      } else {
        // Max intensity: gaps can be short or long (sudden chaos)
        minGap = this._rand() < 0.3 ? 1.5 : 0.25;
        maxGap = minGap;
      }

      const range = maxGap - minGap;
      r.type  = 'gap';
      r.lane  = MID_LANE;
      r.beats = Math.max(0.25, minGap + this._rand() * range);
    }

    return r;
  }
}
