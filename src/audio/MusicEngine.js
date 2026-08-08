/**
 * MusicEngine — Hard Techno / Dubstep procedural synthesiser.
 * Full groove (kick + snare + hat + Reese) from bar 1, intensity 0.30 start.
 * New instruments: bass screech (portamento glide), synth lead (minor pentatonic),
 * rhythmic noise bursts (white noise as instrument). Real LFO-modulated Reese.
 * BPM ramps 120→200. Layers escalate progressively.
 */
import {
  DEFAULT_BPM, BPM_MAX, BPM_RAMP_BEATS, LOOKAHEAD_MS,
  INITIAL_INTENSITY, INTENSITY_TOTAL_BEATS, INTENSITY_COMBO_BONUS, INTENSITY_MISS_PENALTY,
  BASS_LANE, MID_LANE, HIGH_LANE,
} from '../constants.js';

const BPM_STEP = 2.5;

// Layer thresholds — front-loaded so the groove is full from bar 1
const L_KICK    = 0.00;
const L_REESE   = 0.00;  // Reese bass essential to dubstep — in from bar 1
const L_CHAT    = 0.00;  // closed hat groove is foundational
const L_SNARE   = 0.00;  // 2&4 snare is foundational
const L_OHAT    = 0.15;  // offbeat open hat enters early
const L_STAB    = 0.15;  // stabs from the start
const L_SCREECH = 0.40;  // bass screech
const L_LEAD    = 0.25;  // synth lead audible from bar 1
const L_RISER   = 0.50;
const L_SCREAM  = 0.65;
const L_NOISE_R = 0.05;  // rhythmic noise bursts — present from bar 1
const L_NOISE   = 0.75;  // continuous noise bed
const L_CHAOS   = 0.88;

// Dark chromatic cluster: A1, Bb1(minor 2nd=tense), C2, E2, F2(tritone), Ab2, A2
const LEAD_NOTES = [55, 58.3, 65.4, 82.4, 87.3, 103.8, 110];

// Dark stab tones: A1, C2, E2, F2(tritone vs B), F#2, A2, Bb2 — no major intervals
const STAB_NOTES = [55, 65.4, 82.4, 87.3, 92.5, 110, 116.5];

// Phrase index parity for noise burst frequency alternation
let _phraseIndex = 0;

export class MusicEngine {
  constructor() {
    // Seeded Xorshift32 PRNG — unique per run, deterministic within a run
    let s = (Date.now() ^ (Math.random() * 0xffffffff | 0)) >>> 0;
    s ^= s >>> 16;
    s  = Math.imul(s, 0x45d9f3b) >>> 0;
    s ^= s >>> 16;
    this._seed = s || 1;

    this.ctx         = null;
    this.intensity   = INITIAL_INTENSITY;
    this.bpm         = DEFAULT_BPM;
    this.beatLen     = 60 / DEFAULT_BPM;
    this._running    = false;
    this._nextBeat   = 0;
    // Initialize beat count so natural intensity starts at INITIAL_INTENSITY,
    // preventing the 0.9-weighted blend from pulling intensity back down on startup.
    this._beatCount  = Math.floor(INITIAL_INTENSITY * INTENSITY_TOTAL_BEATS);
    this._phraseBeat = 0;
    this._phrasePlay = 0;
    this._timer      = -1;
    this._intensityBonus = 0;

    // 16-slot pattern — shared with LevelGenerator
    this._pattern = new Array(BPM_RAMP_BEATS);
    for (let i = 0; i < BPM_RAMP_BEATS; i++)
      this._pattern[i] = { lane: 0, noteLen: 1, hasEvent: false };

    // Master graph nodes
    this._master     = null;
    this._compressor = null;
    this._analyser   = null;
    this._busKick    = null;
    this._busBass    = null;
    this._busSnare   = null;
    this._busHat     = null;
    this._busStab    = null;
    this._busNoise   = null;
    this._lpf        = null;

    // FFT
    this.fftBuffer = null;

    // Noise bed (continuous)
    this._noiseBedActive = false;
    this._noiseBedSrc    = null;

    // Pre-baked noise buffer (2s)
    this._noiseBuffer = null;

    // Pre-baked distortion curves — allocated in init(), reused in scheduler
    this._kickDistCurve    = null;
    this._heavyDistCurve   = null;
    this._screechDistCurve = null;
    this._leadDistCurve    = null;
    this._stabDistCurve    = null;

    this.onBeat   = null;
    this.onPhrase = null;
  }

  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    const ctx = this.ctx;

    // Graph: buses → compressor → master → lpf → destination
    this._compressor = ctx.createDynamicsCompressor();
    this._compressor.threshold.value = -16;  // more aggressive sidechain feel
    this._compressor.knee.value      = 4;
    this._compressor.ratio.value     = 8;
    this._compressor.attack.value    = 0.002;
    this._compressor.release.value   = 0.10;

    this._master = ctx.createGain();
    this._master.gain.value = 0.82;

    this._lpf = ctx.createBiquadFilter();
    this._lpf.type = 'lowpass';
    this._lpf.frequency.value = 20000;

    this._compressor.connect(this._master);
    this._master.connect(this._lpf);
    this._lpf.connect(ctx.destination);

    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this.fftBuffer = new Float32Array(this._analyser.frequencyBinCount);
    this._master.connect(this._analyser);

    const mkBus = (vol) => {
      const g = ctx.createGain();
      g.gain.value = vol;
      g.connect(this._compressor);
      return g;
    };
    this._busKick  = mkBus(1.3);
    this._busBass  = mkBus(0.0);
    this._busSnare = mkBus(0.0);  // ramped immediately in _mixBuses(true)
    this._busHat   = mkBus(0.0);
    this._busStab  = mkBus(0.0);
    this._busNoise = mkBus(0.0);

    // Pre-bake 2s noise buffer
    const sr = ctx.sampleRate;
    this._noiseBuffer = ctx.createBuffer(1, sr * 2, sr);
    const nd = this._noiseBuffer.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // Pre-bake distortion curves (avoids allocation in scheduler hot path)
    this._kickDistCurve    = this._distCurve(320);
    this._heavyDistCurve   = this._distCurve(700);
    this._screechDistCurve = this._distCurve(500);
    this._leadDistCurve    = this._distCurve(220);
    this._stabDistCurve    = this._distCurve(450);

    // Set bus gains immediately (not ramped) so the very first beat is full volume
    this._mixBuses(true);

    this._nextBeat = ctx.currentTime + 0.1;
    this._running  = true;
    this._timer = setInterval(() => this._schedule(), LOOKAHEAD_MS);
  }

  // ── Seeded PRNG (Xorshift32) — used for all behavioral randomness ────────
  _rand() {
    let s = this._seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this._seed = s >>> 0;
    return this._seed / 0xffffffff;
  }

  // ── Scheduler ────────────────────────────────────────────────────────────

  _schedule() {
    if (!this._running) return;
    // Fire at 16th-note rate: each pos in the 16-slot phrase = one 16th note.
    // beatLen (quarter note) is kept for GameLoop; internally we subdivide by 4.
    const sixteenth = this.beatLen / 4;
    const horizon   = this.ctx.currentTime + LOOKAHEAD_MS / 1000 + 0.1;
    while (this._nextBeat < horizon) {
      this._fireBeat(this._nextBeat);
      this._nextBeat += sixteenth;
    }
  }

  _fireBeat(t) {
    const pos        = this._phraseBeat;
    // Kick on beats 1 & 3 (pos 0, 8); snare on beats 2 & 4 (pos 4, 12).
    // pos % 8 === 0 keeps them on separate beats so neither masks the other.
    const isKickBeat  = (pos % 8) === 0;   // beats 1 and 3
    const isDownbeat  = (pos % 4) === 0;   // all quarter notes (for pattern slot logic)
    const iv          = this.intensity;

    // ── Determine what fires at this position ───────────────────────────────
    const hasKick   = iv >= L_KICK   && isKickBeat;
    const hasSnare  = iv >= L_SNARE  && (pos === 4 || pos === 12);
    const hasChat   = iv >= L_CHAT   && pos % 2 === 0;
    const hasOhat   = iv >= L_OHAT   && pos % 4 === 2;
    // "e" positions (16th after each beat) — industrial, off the 8th-note groove grid
    const hasStab   = iv >= L_STAB   && (pos === 1 || pos === 9 || (iv > 0.50 && pos === 5) || (iv > 0.65 && pos === 13));
    // "ah" positions (16th before next beat) — syncopated, tense
    const hasLead   = iv >= L_LEAD   && (pos === 3 || pos === 11 || (iv > 0.55 && (pos === 7 || pos === 15)));
    const hasScr    = iv >= L_SCREECH && pos === 0 && this._rand() < 0.4 + iv * 0.4;
    const hasScream = iv >= L_SCREAM && pos === 0 && this._rand() < (iv - L_SCREAM) * 2.5;
    const hasNR     = iv >= L_NOISE_R && pos % 4 === 1;

    // ── Synthesis ───────────────────────────────────────────────────────────
    if (hasKick)  this._triggerKick(t, iv);
    if (hasSnare) { this._triggerSnare(t, iv); this._triggerNoiseShot(t, iv); }
    if (hasChat)  this._triggerClosedHat(t, iv);
    if (hasOhat)  this._triggerOpenHat(t, iv);

    // Dubstep half-time Reese: fires once per bar (pos 0), sustained for the full bar.
    // At chaos intensity a second hit on pos 8 restores techno double-time energy.
    if (iv >= L_REESE && (pos === 0 || (iv >= L_CHAOS && pos === 8))) {
      const dur = this.beatLen * (iv >= L_CHAOS ? 2 : 4);
      this._triggerReese(t, dur, iv);
    }

    if (hasStab)  this._triggerStab(t, iv);
    if (hasLead)  this._triggerLead(t, iv);
    if (hasScr)   this._triggerScreech(t, iv);
    if (hasScream) this._triggerScream(t, iv);
    if (hasNR)    this._triggerNoiseBurst(t, (_phraseIndex % 2 === 0) ? 1200 : 3500, 0.06 + iv * 0.08, iv);

    // Riser: 2 beats before phrase end
    if (iv >= L_RISER && pos === BPM_RAMP_BEATS - 2)
      this._triggerRiser(t, iv);

    // Noise bed
    if (iv >= L_NOISE) this._ensureNoiseBed(iv);
    else this._muteNoiseBed();

    // Chaos: extra kick fills on 16th position 3/7/11/15
    if (iv >= L_CHAOS) {
      if (pos % 4 === 3 && this._rand() < (iv - L_CHAOS) * 3)
        this._triggerKick(t, iv * 0.65);
      if (pos === 8 && this._rand() < (iv - L_CHAOS) * 2)
        this._triggerSnare(t, iv * 0.8);
    }

    // ── Update pattern slot for LevelGenerator ──────────────────────────────
    const p = this._pattern[pos];

    // Lane assignment reflects actual frequency content of each instrument.
    // BASS_LANE: kick / Reese (20–120 Hz sub-bass)
    // MID_LANE:  snare / stabs / leads (300–5000 Hz)
    // HIGH_LANE: hats / noise bursts (5–12 kHz)
    p.hasEvent = hasKick || hasSnare || hasChat || hasOhat || hasStab || hasLead || hasNR;

    if (hasKick) {
      p.lane = BASS_LANE; p.noteLen = 1.0;
    } else if (hasSnare) {
      p.lane = MID_LANE;  p.noteLen = 0.75;
    } else if (hasStab || hasLead) {
      p.lane = MID_LANE;  p.noteLen = 0.5;
    } else if (hasOhat || hasNR) {
      p.lane = HIGH_LANE; p.noteLen = hasOhat ? 0.5 : 0.25;
    } else if (hasChat) {
      p.lane = HIGH_LANE; p.noteLen = 0.25;
    } else {
      p.lane = HIGH_LANE; p.noteLen = 0.25;
    }

    // Only notify on kick (quarter-note downbeats) to keep GameLoop's platform
    // clock at the correct rate — the pattern array carries full 16th-note info.
    if (this.onBeat && hasKick)
      this.onBeat(t, BASS_LANE, 1.0);

    // ── Advance phrase state ─────────────────────────────────────────────────
    this._phraseBeat = (pos + 1) % BPM_RAMP_BEATS;
    this._beatCount++;

    if (this._phrasePlay < BPM_RAMP_BEATS - 1) {
      this._phrasePlay++;
    } else {
      this._phrasePlay = 0;
      this._advancePhrase();
    }
  }

  _advancePhrase() {
    _phraseIndex++;

    if (this.bpm < BPM_MAX) {
      this.bpm    = Math.min(BPM_MAX, this.bpm + BPM_STEP);
      this.beatLen = 60 / this.bpm;
    }

    const natural = Math.min(1, this._beatCount / INTENSITY_TOTAL_BEATS);
    // Blend toward natural; never let it drop below the miss floor or natural
    const blended = this.intensity * 0.9 + natural * 0.1 + (this._intensityBonus || 0);
    this.intensity = Math.min(1, Math.max(natural, blended));
    this._intensityBonus = 0;

    this._mixBuses();

    if (this.onPhrase) this.onPhrase(this._pattern.slice());
  }

  _mixBuses(instant = false) {
    const iv   = this.intensity;
    const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
    const ramp = (node, val) => {
      if (!node) return;
      if (instant) node.gain.value = val;
      else node.gain.setTargetAtTime(val, this.ctx.currentTime, 0.5);
    };

    ramp(this._busBass,  lerp(0, 1.0,  (iv - L_REESE)   / (1 - L_REESE   + 0.001)));
    ramp(this._busSnare, lerp(0, 2.8,  (iv - L_SNARE)   / (1 - L_SNARE   + 0.001)));
    ramp(this._busHat,   lerp(0, 0.75, (iv - L_CHAT)    / (1 - L_CHAT    + 0.001)));
    ramp(this._busStab,  lerp(0, 0.9,  (iv - L_STAB)    / (1 - L_STAB    + 0.001)));
    ramp(this._busNoise, lerp(0, 1.0,  (iv - L_NOISE_R) / (1 - L_NOISE_R + 0.001)));
  }

  // ── Synthesis ─────────────────────────────────────────────────────────────

  // Three-layer punchy hard techno kick
  _triggerKick(t, iv) {
    const ctx = this.ctx;

    // Layer 1: Sub body — sine 240→30 Hz, heavy distortion
    const sub    = ctx.createOscillator();
    const subDist = ctx.createWaveShaper();
    const subEnv = ctx.createGain();
    sub.frequency.setValueAtTime(240 + iv * 60, t);
    sub.frequency.exponentialRampToValueAtTime(30, t + 0.07);
    subDist.curve = this._kickDistCurve;
    subEnv.gain.setValueAtTime(2.2, t);
    subEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.48 + iv * 0.08);
    sub.connect(subDist); subDist.connect(subEnv); subEnv.connect(this._busKick);
    sub.start(t); sub.stop(t + 0.6);

    // Layer 2: Mid thud — sine 90 Hz, no distortion, chest punch
    const mid    = ctx.createOscillator();
    const midEnv = ctx.createGain();
    mid.frequency.value = 90;
    midEnv.gain.setValueAtTime(1.2, t);
    midEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
    mid.connect(midEnv); midEnv.connect(this._busKick);
    mid.start(t); mid.stop(t + 0.12);

    // Layer 3: Click transient — bandpass noise 3.5 kHz, 5ms
    const click    = ctx.createBufferSource();
    const clickBPF = ctx.createBiquadFilter();
    const clickEnv = ctx.createGain();
    click.buffer = this._noiseBuffer;
    clickBPF.type = 'bandpass'; clickBPF.frequency.value = 3500; clickBPF.Q.value = 2;
    clickEnv.gain.setValueAtTime(1.8, t);
    clickEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.005);
    click.connect(clickBPF); clickBPF.connect(clickEnv); clickEnv.connect(this._busKick);
    click.start(t); click.stop(t + 0.01);
  }

  // Real LFO-modulated Reese bass — actual "wub wub", tuned deep
  _triggerReese(t, dur, iv) {
    const ctx      = this.ctx;
    const detune   = 16 + iv * 24;
    // Dubstep wub rate: slow (0.6 Hz = 1 wub/1.7s) → medium (2.5 Hz = fast wubs)
    // Keeps the bass in half-time "wub wub" territory, never going techno-speed
    const wubRate  = 0.6 + iv * 1.9;
    const wubDepth = 1800 + iv * 2500;     // wide sweep = dramatic dark wob
    const baseFreq = 41.2;                  // E1 — one step deeper than A1 (55 Hz)

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = osc2.type = 'sawtooth';
    osc1.frequency.value = baseFreq;
    osc2.frequency.value = baseFreq;
    osc1.detune.value = -detune;
    osc2.detune.value = +detune;

    // Resonant lowpass — the "wub" filter, lower base for deeper sound
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 120;              // low base → LFO sweeps from darkness upward
    lpf.Q.value = 22 + iv * 12;            // maximum resonance — that signature wub squeal

    // LFO driving filter cutoff
    const lfo     = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = wubRate;
    lfoGain.gain.value  = wubDepth;
    lfo.connect(lfoGain);
    lfoGain.connect(lpf.frequency);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, t);
    env.gain.linearRampToValueAtTime(1.3, t + 0.018);
    env.gain.setValueAtTime(1.0, t + dur * 0.08);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    // Deep sub sine — felt more than heard, adds weight
    const sub    = ctx.createOscillator();
    const subEnv = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.value = 20.6;             // low sub (one octave below E1)
    subEnv.gain.setValueAtTime(0.001, t);
    subEnv.gain.linearRampToValueAtTime(1.2, t + 0.03);
    subEnv.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc1.connect(lpf); osc2.connect(lpf);
    lpf.connect(env); env.connect(this._busBass);
    sub.connect(subEnv); subEnv.connect(this._busBass);

    const stop = t + dur + 0.02;
    osc1.start(t); osc2.start(t); lfo.start(t); sub.start(t);
    osc1.stop(stop); osc2.stop(stop); lfo.stop(stop); sub.stop(stop);
  }

  // Industrial snare — 6-layer stack: sub-punch, mid-crunch, edge, crack, body, thwack
  _triggerSnare(t, iv) {
    const ctx = this.ctx;

    // Layer A: Sub-punch — sine 200→60 Hz over 25ms (physical impact, felt in chest)
    const punch    = ctx.createOscillator();
    const punchEnv = ctx.createGain();
    punch.frequency.setValueAtTime(200, t);
    punch.frequency.exponentialRampToValueAtTime(60, t + 0.025);
    punchEnv.gain.setValueAtTime(3.5, t);
    punchEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.030);
    punch.connect(punchEnv); punchEnv.connect(this._busSnare);
    punch.start(t); punch.stop(t + 0.035);

    // Layer B: Mid-presence crunch — BPF noise at 2200 Hz through heavy dist (fills 1–3 kHz gap)
    const mid    = ctx.createBufferSource();
    const midBPF = ctx.createBiquadFilter();
    const midDst = ctx.createWaveShaper();
    const midEnv = ctx.createGain();
    mid.buffer = this._noiseBuffer;
    midBPF.type = 'bandpass'; midBPF.frequency.value = 2200; midBPF.Q.value = 4;
    midDst.curve = this._heavyDistCurve;
    midEnv.gain.setValueAtTime(3.5 + iv * 1.0, t);
    midEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.040);
    mid.connect(midBPF); midBPF.connect(midDst); midDst.connect(midEnv);
    midEnv.connect(this._busSnare);
    mid.start(t); mid.stop(t + 0.05);

    // Layer 0: Ultra-short edge click (8-10 kHz, 12ms) — cuts through everything
    const edge    = ctx.createBufferSource();
    const edgeHPF = ctx.createBiquadFilter();
    const edgeEnv = ctx.createGain();
    edge.buffer = this._noiseBuffer;
    edgeHPF.type = 'highpass'; edgeHPF.frequency.value = 8500;
    edgeEnv.gain.setValueAtTime(4.5, t);
    edgeEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
    edge.connect(edgeHPF); edgeHPF.connect(edgeEnv); edgeEnv.connect(this._busSnare);
    edge.start(t); edge.stop(t + 0.015);

    // Layer 1: Heavily distorted crack (4 kHz noise through heavy waveshaper — brutal crunch)
    const crack    = ctx.createBufferSource();
    const crackHPF = ctx.createBiquadFilter();
    const crackDist = ctx.createWaveShaper();
    const crackEnv = ctx.createGain();
    crack.buffer = this._noiseBuffer;
    crackHPF.type = 'highpass'; crackHPF.frequency.value = 3500;
    crackDist.curve = this._heavyDistCurve;  // brutal 700-amount distortion
    crackEnv.gain.setValueAtTime(5.0 + iv * 1.2, t);
    crackEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.055 + iv * 0.025);
    crack.connect(crackHPF); crackHPF.connect(crackDist); crackDist.connect(crackEnv);
    crackEnv.connect(this._busSnare);
    crack.start(t); crack.stop(t + 0.1);

    // Layer 2: Heavy body (bandpass 600 Hz, longer)
    const body    = ctx.createBufferSource();
    const bodyBPF = ctx.createBiquadFilter();
    const bodyEnv = ctx.createGain();
    body.buffer = this._noiseBuffer;
    bodyBPF.type = 'bandpass'; bodyBPF.frequency.value = 600; bodyBPF.Q.value = 1.2;
    bodyEnv.gain.setValueAtTime(2.2 + iv * 0.8, t);
    bodyEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.16 + iv * 0.05);
    body.connect(bodyBPF); bodyBPF.connect(bodyEnv); bodyEnv.connect(this._busSnare);
    body.start(t); body.stop(t + 0.24);

    // Layer 3: Pitch snap (sine 300→80 Hz, 70ms) — the "thwack"
    const tone    = ctx.createOscillator();
    const toneEnv = ctx.createGain();
    tone.frequency.setValueAtTime(300, t);
    tone.frequency.exponentialRampToValueAtTime(80, t + 0.07);
    toneEnv.gain.setValueAtTime(1.8, t);
    toneEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    tone.connect(toneEnv); toneEnv.connect(this._busSnare);
    tone.start(t); tone.stop(t + 0.1);

    // Clap echoes at medium+ intensity — louder and more prominent
    if (iv > 0.35) {
      [0.008, 0.016].forEach(offset => {
        const c    = ctx.createBufferSource();
        const chpf = ctx.createBiquadFilter();
        const ce   = ctx.createGain();
        c.buffer = this._noiseBuffer;
        chpf.type = 'highpass'; chpf.frequency.value = 6000;
        ce.gain.setValueAtTime(2.2 * iv, t + offset);
        ce.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.035);
        c.connect(chpf); chpf.connect(ce); ce.connect(this._busSnare);
        c.start(t + offset); c.stop(t + offset + 0.04);
      });
    }
  }

  _triggerClosedHat(t, iv) {
    const ctx   = this.ctx;
    const noise = ctx.createBufferSource();
    const hpf   = ctx.createBiquadFilter();
    const env   = ctx.createGain();
    noise.buffer = this._noiseBuffer;
    hpf.type = 'highpass'; hpf.frequency.value = 9000;  // tighter, brighter
    const decay = 0.035 + iv * 0.025;
    env.gain.setValueAtTime(0.7, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + decay);
    noise.connect(hpf); hpf.connect(env); env.connect(this._busHat);
    noise.start(t); noise.stop(t + decay + 0.01);
  }

  _triggerOpenHat(t, iv) {
    const ctx   = this.ctx;
    const noise = ctx.createBufferSource();
    const hpf   = ctx.createBiquadFilter();
    const env   = ctx.createGain();
    noise.buffer = this._noiseBuffer;
    hpf.type = 'highpass'; hpf.frequency.value = 7000;
    const decay = 0.11 + iv * 0.12;
    env.gain.setValueAtTime(0.55, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + decay);
    noise.connect(hpf); hpf.connect(env); env.connect(this._busHat);
    noise.start(t); noise.stop(t + decay + 0.01);
  }

  // Tritone-dyad stab — two oscillators a tritone apart = instant "devil's interval" darkness
  _triggerStab(t, iv) {
    const ctx     = this.ctx;
    const baseFreq = STAB_NOTES[Math.floor(this._rand() * STAB_NOTES.length)];
    const triFreq  = baseFreq * 1.4142;  // tritone above (augmented 4th = diabolus in musica)

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const dist = ctx.createWaveShaper();
    const lpf  = ctx.createBiquadFilter();
    const env  = ctx.createGain();

    osc1.type = 'sawtooth'; osc2.type = 'square';
    osc1.frequency.value = baseFreq;
    osc2.frequency.value = triFreq;
    // Pitch slides DOWN after attack for a dark "falling" feel
    osc1.frequency.setValueAtTime(baseFreq, t);
    osc1.frequency.exponentialRampToValueAtTime(baseFreq * 0.88, t + this.beatLen * 0.4);
    osc2.frequency.setValueAtTime(triFreq, t);
    osc2.frequency.exponentialRampToValueAtTime(triFreq * 0.88, t + this.beatLen * 0.4);

    dist.curve = this._stabDistCurve;
    // Filter crashes DOWN from bright → dark (not upward sweep)
    lpf.type = 'lowpass'; lpf.Q.value = 6;
    lpf.frequency.setValueAtTime(10000, t);
    lpf.frequency.exponentialRampToValueAtTime(200 + iv * 300, t + 0.05);

    const dur = this.beatLen * 0.42;
    env.gain.setValueAtTime(0.001, t);
    env.gain.linearRampToValueAtTime(1.1, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc1.connect(dist); osc2.connect(dist);
    dist.connect(lpf); lpf.connect(env); env.connect(this._busStab);
    osc1.start(t); osc2.start(t);
    osc1.stop(t + dur + 0.01); osc2.stop(t + dur + 0.01);
  }

  // Dark industrial lead — heavy detune, filter crashes DOWN from bright to muffled
  _triggerLead(t, iv) {
    const ctx  = this.ctx;
    const freq = LEAD_NOTES[Math.floor(this._rand() * LEAD_NOTES.length)];

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const dist = ctx.createWaveShaper();
    const filt = ctx.createBiquadFilter();
    const env  = ctx.createGain();

    osc1.type = osc2.type = 'sawtooth';
    osc1.frequency.value = freq;
    osc2.frequency.value = freq;
    osc2.detune.value = 28;  // heavier detune = more industrial, less clean chorus
    dist.curve = this._leadDistCurve;

    // Filter CRASHES DOWN — bright → dark, creates falling/heavy feel instead of excitement
    filt.type = 'lowpass'; filt.Q.value = 12;
    filt.frequency.setValueAtTime(12000, t);
    filt.frequency.exponentialRampToValueAtTime(80 + iv * 250, t + 0.06);

    const dur = this.beatLen * (0.5 + iv * 0.5);
    env.gain.setValueAtTime(0.001, t);
    env.gain.linearRampToValueAtTime(1.0, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc1.connect(dist); osc2.connect(dist);
    dist.connect(filt); filt.connect(env); env.connect(this._busStab);
    osc1.start(t); osc2.start(t);
    osc1.stop(t + dur + 0.01); osc2.stop(t + dur + 0.01);
  }

  // Bass screech — portamento glide up then fall, heavy distortion
  _triggerScreech(t, iv) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const dist = ctx.createWaveShaper();
    const env  = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(55, t);
    osc.frequency.exponentialRampToValueAtTime(220 + iv * 660, t + 0.12);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.32);

    dist.curve = this._screechDistCurve;

    env.gain.setValueAtTime(0.001, t);
    env.gain.linearRampToValueAtTime(1.1, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.38);

    osc.connect(dist); dist.connect(env); env.connect(this._busStab);
    osc.start(t); osc.stop(t + 0.42);
  }

  // FM screech — sparse, high-freq chaos
  _triggerScream(t, iv) {
    const ctx   = this.ctx;
    const mod   = ctx.createOscillator();
    const car   = ctx.createOscillator();
    const mGain = ctx.createGain();
    const dist  = ctx.createWaveShaper();
    const env   = ctx.createGain();

    mod.frequency.value  = 80 + iv * 60;
    mGain.gain.value     = 700 + iv * 900;
    car.type = 'sawtooth';
    car.frequency.value = 880 + iv * 440;
    dist.curve = this._heavyDistCurve;

    const dur = this.beatLen * 2;
    env.gain.setValueAtTime(0.001, t);
    env.gain.linearRampToValueAtTime(0.8, t + 0.01);
    env.gain.setValueAtTime(0.65, t + dur * 0.7);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    mod.connect(mGain); mGain.connect(car.frequency);
    car.connect(dist); dist.connect(env); env.connect(this._busStab);
    mod.start(t); mod.stop(t + dur + 0.01);
    car.start(t); car.stop(t + dur + 0.01);
  }

  // White noise as rhythmic instrument — bandpass bursts on 16th offbeats
  _triggerNoiseBurst(t, centerFreq, decay, iv) {
    const ctx   = this.ctx;
    const noise = ctx.createBufferSource();
    const bpf   = ctx.createBiquadFilter();
    const env   = ctx.createGain();

    noise.buffer = this._noiseBuffer;
    bpf.type = 'bandpass'; bpf.frequency.value = centerFreq; bpf.Q.value = 2 + iv * 5;

    env.gain.setValueAtTime(1.2 + iv * 0.6, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + decay);

    noise.connect(bpf); bpf.connect(env); env.connect(this._busNoise);
    noise.start(t); noise.stop(t + decay + 0.01);
  }

  // Heavy resonant noise shot — co-fires with snare for percussive white noise accent
  _triggerNoiseShot(t, iv) {
    const ctx   = this.ctx;
    const noise = ctx.createBufferSource();
    const hpf   = ctx.createBiquadFilter();
    const bpf   = ctx.createBiquadFilter();
    const env   = ctx.createGain();

    noise.buffer = this._noiseBuffer;
    // Two-stage filter: HPF removes rumble, BPF centres on 2–5 kHz presence band
    hpf.type = 'highpass'; hpf.frequency.value = 1800;
    bpf.type = 'bandpass'; bpf.frequency.value = 2800 + iv * 2200; bpf.Q.value = 1 + iv * 3;

    env.gain.setValueAtTime(2.0 + iv * 1.0, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.08 + iv * 0.04);

    noise.connect(hpf); hpf.connect(bpf); bpf.connect(env); env.connect(this._busNoise);
    noise.start(t); noise.stop(t + 0.15);
  }

  // 2-beat filtered noise riser before phrase drops
  _triggerRiser(t, iv) {
    const ctx   = this.ctx;
    const noise = ctx.createBufferSource();
    const filt  = ctx.createBiquadFilter();
    const env   = ctx.createGain();

    noise.buffer = this._noiseBuffer;
    filt.type = 'lowpass';
    const dur = this.beatLen * 2;
    filt.frequency.setValueAtTime(200, t);
    filt.frequency.exponentialRampToValueAtTime(16000, t + dur);

    env.gain.setValueAtTime(0.001, t);
    env.gain.linearRampToValueAtTime(0.4 + iv * 0.4, t + dur * 0.8);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    noise.connect(filt); filt.connect(env); env.connect(this._busNoise);
    noise.start(t); noise.stop(t + dur + 0.01);
  }

  _ensureNoiseBed(iv) {
    if (this._noiseBedActive) return;
    this._noiseBedActive = true;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    const bpf = ctx.createBiquadFilter();
    const g   = ctx.createGain();
    src.buffer = this._noiseBuffer;
    src.loop = true;
    bpf.type = 'bandpass'; bpf.frequency.value = 1200 + iv * 2800; bpf.Q.value = 0.6;
    g.gain.value = 0.35;
    src.connect(bpf); bpf.connect(g); g.connect(this._busNoise);
    src.start();
    this._noiseBedSrc = src;
  }

  _muteNoiseBed() { this._noiseBedActive = false; }

  // ── Waveshaper curve ─────────────────────────────────────────────────────
  _distCurve(amount) {
    const n = 256;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  getFFT() {
    if (this._analyser) this._analyser.getFloatFrequencyData(this.fftBuffer);
    return this.fftBuffer;
  }

  setHovering(on) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this._lpf.frequency.setTargetAtTime(on ? 700 : 20000, now, 0.08);
  }

  notifyCombo(combo) {
    if (!this._intensityBonus) this._intensityBonus = 0;
    if (combo > 0 && combo % 8 === 0)
      this._intensityBonus = Math.min(0.12, this._intensityBonus + INTENSITY_COMBO_BONUS);
  }

  notifyMiss() {
    // Floor at 0.15 — keeps groove audible even after many consecutive misses
    this.intensity = Math.max(0.15, this.intensity - INTENSITY_MISS_PENALTY);
    this._mixBuses();
  }

  setBPM(bpm) {
    this.bpm     = bpm;
    this.beatLen = 60 / bpm;
  }

  // ── Event sounds (compat with Synth facade) ───────────────────────────────

  triggerKick(t) { this._triggerKick(t ?? this.ctx.currentTime, this.intensity); }

  // Metallic "ping" chord — clearly distinct from kick/bass
  triggerHitBoom() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t   = ctx.currentTime;
    // Three harmonic sines: C5/E5/G5 chord (523/659/784 Hz) — bright, not bassy
    [523, 659, 784].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0.4 - i * 0.08, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.10 + i * 0.04);
      osc.connect(env); env.connect(this._busHat);
      osc.start(t); osc.stop(t + 0.18);
    });
  }

  triggerPerfectLand() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t   = ctx.currentTime;
    this.triggerHitBoom();
    // Extra bright ping for perfect — higher octave
    [1046, 1319, 1568].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0.35 - i * 0.07, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.18 + i * 0.05);
      osc.connect(env); env.connect(this._busHat);
      osc.start(t); osc.stop(t + 0.28);
    });
  }

  triggerGoodLand() { this.triggerHitBoom(); }

  triggerGapFall() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t   = ctx.currentTime;
    // Pitch collapse with screech
    this._triggerScreech(t, Math.max(0.5, this.intensity));
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.setValueAtTime(500, t);
    osc.frequency.exponentialRampToValueAtTime(25, t + 0.55);
    env.gain.setValueAtTime(1.0, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.connect(env); env.connect(this._busKick);
    osc.start(t); osc.stop(t + 0.65);
    // Noise burst
    this._triggerNoiseBurst(t, 800, 0.45, this.intensity);
    this.notifyMiss();
  }

  triggerDecoyLand() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t   = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.18);
    env.gain.setValueAtTime(0.9, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(env); env.connect(this._busKick);
    osc.start(t); osc.stop(t + 0.25);
    // Add a screech sting
    if (this.intensity > 0.3) this._triggerScreech(t, this.intensity);
    this.notifyMiss();
  }

  triggerFailure() {
    if (!this.ctx) return;
    this._busKick.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    setTimeout(() => {
      if (this._busKick)
        this._busKick.gain.setTargetAtTime(1.3, this.ctx.currentTime, 0.3);
    }, 2000);
    this.notifyMiss();
  }

  get currentTime() { return this.ctx ? this.ctx.currentTime : 0; }
  get ready()       { return !!this.ctx; }
}
