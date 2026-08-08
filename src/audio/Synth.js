/**
 * Synth — thin facade over MusicEngine.
 * All callers (GameLoop, TrackEngine, Player) use these same method names.
 * MusicEngine owns the actual audio graph.
 */
import { LOOKAHEAD_MS } from '../constants.js';
import { MusicEngine } from './MusicEngine.js';

export const BEAT_NODE  = 0;
export const BEAT_DECOY = 1;

export class Synth {
  constructor() {
    this._engine = new MusicEngine();
    this.onBeat  = null; // (audioTime, type, lane) => void — set by TrackEngine
  }

  init() {
    if (this._engine.ready) return;
    this._engine.init();
    // Bridge MusicEngine beats → legacy onBeat callback
    this._engine.onBeat = (audioTime, lane, noteLen) => {
      if (this.onBeat) {
        // map lane to legacy type: bass lane = node (True North), others = decoy signal
        const type = lane === -1 ? BEAT_NODE : BEAT_DECOY;
        this.onBeat(audioTime, type, lane);
      }
    };
  }

  // ── Delegated API ─────────────────────────────────────────────────────────

  getFFT()             { return this._engine.getFFT(); }
  setHovering(on)      { this._engine.setHovering(on); }
  setBPM(bpm)          { this._engine.setBPM(bpm); }
  notifyCombo(combo)   { this._engine.notifyCombo(combo); }
  notifyMiss()         { this._engine.notifyMiss(); }

  triggerHitBoom()     { this._engine.triggerHitBoom(); }
  triggerPerfectLand() { this._engine.triggerPerfectLand(); }
  triggerGoodLand()    { this._engine.triggerGoodLand(); }
  triggerGapFall()     { this._engine.triggerGapFall(); }
  triggerDecoyLand()   { this._engine.triggerDecoyLand(); }
  triggerFailure()     { this._engine.triggerFailure(); }

  /** Called by GameLoop to register combo result */
  registerCombo(combo) { this._engine.notifyCombo(combo); }
  /** Called by GameLoop on miss */
  registerMiss()       { this._engine.notifyMiss(); }

  // ── Properties GameLoop reads ─────────────────────────────────────────────

  /** Live beat length in seconds — GameLoop uses this for its beat clock */
  get beatLen()      { return this._engine.beatLen; }
  get bpm()          { return this._engine.bpm; }
  get intensity()    { return this._engine.intensity; }
  get fftBuffer()    { return this._engine.fftBuffer; }
  get currentTime()  { return this._engine.currentTime; }
  get ready()        { return this._engine.ready; }

  /** Full 16-slot musical pattern — consumed by LevelGenerator */
  get musicalPattern() { return this._engine._pattern; }
  get engine()         { return this._engine; }
}
