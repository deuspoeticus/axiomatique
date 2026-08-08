import { SPAWN_Z, RECYCLE_Z, BLOCK_SPEED, DEFAULT_BPM } from '../constants.js';
import { BlockPool } from '../pool/BlockPool.js';

export class TrackEngine {
  constructor(scene, synth) {
    this._pool  = new BlockPool(scene);
    this._synth = synth;
    this._bpm   = DEFAULT_BPM;
    this._speed = BLOCK_SPEED;
    this._speedOverride = false; // when PhaseManager sets speed explicitly

    // Ring buffer: pre-allocated, not used for spawning (GameLoop handles that)
    this._schedBeat = new Float32Array(512);
    this._schedType = new Uint8Array(512);
    this._schedLane = new Int32Array(512);
    this._schedHead = 0;
    this._schedTail = 0;

    this._fftBuf = null;
  }

  linkSynth(synth) {
    this._synth  = synth;
    this._fftBuf = synth.fftBuffer;
  }

  scheduleBeat(audioTime, type, lane) {
    const tail = (this._schedTail + 1) & 511;
    if (tail === this._schedHead) return;
    this._schedBeat[this._schedTail] = audioTime;
    this._schedType[this._schedTail] = type === 'node' ? 0 : 1;
    this._schedLane[this._schedTail] = lane ?? 0;
    this._schedTail = tail;
  }

  // ── Main update — called inside rAF. Zero `new`. ────────────────────────
  update(deltaTime) {
    // Scale speed with live BPM so platforms always arrive on beat.
    // BPM ratio: current_bpm / default_bpm — grows from 1.0 to ~1.67 at 200 BPM.
    let speed = this._speed;
    if (!this._speedOverride && this._synth && this._synth.ready) {
      speed = BLOCK_SPEED * (this._synth.bpm / DEFAULT_BPM);
    }
    this._pool.update(deltaTime, speed, RECYCLE_Z);
  }

  // setSpeed is called by PhaseManager — treat it as an override floor
  setSpeed(speed) {
    this._speed = speed;
    this._speedOverride = true; // PhaseManager took control; stop auto-scaling
  }

  setBPM(bpm) { this._bpm = bpm; }
  get activeCount() { return this._pool.activeCount; }
  get _speed_live() {
    if (!this._speedOverride && this._synth && this._synth.ready)
      return BLOCK_SPEED * (this._synth.bpm / DEFAULT_BPM);
    return this._speed;
  }
}
