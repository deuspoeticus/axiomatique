import { PHASE_TIMES } from '../constants.js';

export const PHASE_DESCENT      = 0;
export const PHASE_DESYNC       = 1;
export const PHASE_PERFECT_LOOP = 2;

export class PhaseManager {
  constructor() {
    this.phase   = PHASE_DESCENT;
    this._elapsed = 0;
  }

  // Returns the current phase enum. Call once per frame inside GameLoop.
  update(deltaTime, uniforms, synth, trackEngine) {
    this._elapsed += deltaTime;
    const e = this._elapsed;

    // ── Phase transitions ─────────────────────────────────────────────────────
    if (e >= PHASE_TIMES.PERFECT_LOOP && this.phase !== PHASE_PERFECT_LOOP) {
      this.phase = PHASE_PERFECT_LOOP;
      this._enterPerfectLoop(uniforms, synth, trackEngine);
    } else if (e >= PHASE_TIMES.DESYNC && this.phase === PHASE_DESCENT) {
      this.phase = PHASE_DESYNC;
      this._enterDesync(synth, trackEngine);
    }

    // ── Per-frame phase behaviour ─────────────────────────────────────────────
    if (this.phase === PHASE_DESYNC) {
      // Slowly drift corruption visual even without player mistakes
      const drift = Math.sin(e * 0.8) * 0.15 + 0.1;
      uniforms.u_corruption.value = Math.min(
        1.0,
        Math.max(uniforms.u_corruption.value, drift)
      );
    }

    return this.phase;
  }

  _enterDesync(synth, trackEngine) {
    // MusicEngine owns BPM ramping — we just push block speed up for DESYNC feel.
    // synth.setBPM is intentionally NOT called here.
    trackEngine.setSpeed(16);
  }

  _enterPerfectLoop(uniforms, synth, trackEngine) {
    // Resolve corruption visual on entering the final phase
    uniforms.u_corruption.value = 0;
    this.perfectLoopActive = true;
  }

  get elapsed()           { return this._elapsed; }
  get perfectLoopActive() { return this._perfectLoop; }
  set perfectLoopActive(v){ this._perfectLoop = v; }
}
