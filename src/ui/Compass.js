import { GLYPH_ARC, GLYPH_SPEED, GLYPH_TRAVEL, ASCII_NOISE, DEFAULT_BPM } from '../constants.js';

const MAX_BARS = 48;

// Arc width per beat — how many radians one beat occupies on the ring.
// Derived from: how many beats fit in the lookahead window (GLYPH_TRAVEL seconds).
const ARC_PER_BEAT = GLYPH_ARC / (GLYPH_TRAVEL * (DEFAULT_BPM / 60));

export class Compass {
  constructor() {
    this._canvas = document.getElementById('ui');
    this._ctx = this._canvas.getContext('2d');

    // Pre-allocated bar pool — one entry per sequence element visible on the ring.
    this._bars = [];
    for (let i = 0; i < MAX_BARS; i++) {
      this._bars.push({
        active: false,
        pType: 'gap',   // 'node' | 'decoy' | 'gap'
        angle: 0.0,     // trailing-edge angle (starts at 0 = 3 o'clock)
        arcWidth: 0.0,     // angular extent in radians
        scrambled: false,
        scrambleT: 0.0,
      });
    }

    this._asciiLen = ASCII_NOISE.length;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    this._canvas.width = window.innerWidth;
    this._canvas.height = window.innerHeight;
    this._cx = this._canvas.width * 0.5;
    this._cy = this._canvas.height * 0.5;
    this._r = Math.min(this._canvas.width, this._canvas.height) * 0.40;
  }

  // Spawn a platform bar at 3 o'clock. pType: 'node' | 'decoy'. beats: length in beats.
  addBar(pType, beats) {
    for (let i = 0; i < MAX_BARS; i++) {
      if (!this._bars[i].active) {
        this._bars[i].active = true;
        this._bars[i].pType = pType;
        this._bars[i].angle = 0.0;
        this._bars[i].arcWidth = beats * ARC_PER_BEAT;
        this._bars[i].scrambled = false;
        this._bars[i].scrambleT = 0.0;
        return;
      }
    }
  }

  // Spawn a gap entry — no visual, but it occupies arc space for timing purposes.
  addGap(beats) {
    for (let i = 0; i < MAX_BARS; i++) {
      if (!this._bars[i].active) {
        this._bars[i].active = true;
        this._bars[i].pType = 'gap';
        this._bars[i].angle = 0.0;
        this._bars[i].arcWidth = beats * ARC_PER_BEAT;
        this._bars[i].scrambled = false;
        this._bars[i].scrambleT = 0.0;
        return;
      }
    }
  }

  scrambleAll() {
    for (let i = 0; i < MAX_BARS; i++) {
      if (this._bars[i].active) {
        this._bars[i].scrambled = true;
        this._bars[i].scrambleT = 1.2;
      }
    }
  }

  // ── Draw one frame — no `new` inside. ────────────────────────────────────
  draw(dt, progress, isScrambled) {
    const ctx = this._ctx;
    const cx = this._cx;
    const cy = this._cy;
    const r = this._r;
    const W = this._canvas.width;
    const H = this._canvas.height;

    ctx.clearRect(0, 0, W, H);

    // Responsive stroke/radius values — all derived from the compass radius.
    const lwRing = r * 0.005;   // outer ring stroke
    const lwArc = r * 0.007;   // progress arc stroke
    const lwTick = r * 0.009;   // playhead tick stroke
    const lwBar = r * 0.021;   // platform bar stroke
    const dotRadius = r * 0.010;   // center dot radius
    const tickIn = r * 0.028;   // tick start (inside the ring)
    const tickOut = r * 0.035;   // tick end (outside the ring)

    // ── Outer ring ───────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = lwRing;
    ctx.stroke();

    // ── Progress arc (clockwise from 12 o'clock = -π/2) ─────────────────────
    if (progress > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lwArc;
      ctx.stroke();
    }

    // ── Playhead: center dot + short tick at 12 o'clock on the ring ─────────
    ctx.beginPath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx, cy - r + tickIn);
    ctx.lineTo(cx, cy - r - tickOut);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = lwTick;
    ctx.stroke();

    // ── Platform / gap bars ──────────────────────────────────────────────────
    for (let i = 0; i < MAX_BARS; i++) {
      const b = this._bars[i];
      if (!b.active) continue;

      // Advance angle (trailing edge moves counter-clockwise toward 12 o'clock)
      b.angle += GLYPH_SPEED * dt;

      // Deactivate when the leading edge has passed 12 o'clock
      if (b.angle - b.arcWidth >= GLYPH_ARC + 0.05) {
        b.active = false;
        continue;
      }

      // Scramble timer decay
      if (b.scrambled) {
        b.scrambleT -= dt;
        if (b.scrambleT <= 0) b.scrambled = false;
      }

      // Gaps draw nothing
      if (b.pType === 'gap' && !b.scrambled && !isScrambled) continue;

      // Arc from trailing edge (-b.angle) to leading edge (-(b.angle + arcWidth)).
      // anticlockwise=true → counter-clockwise in screen coords (upward from 3 o'clock).
      const trailingAngle = -b.angle;
      const leadingAngle = -(b.angle + b.arcWidth);

      let color;
      if (b.scrambled || isScrambled) {
        color = '#ff0033';
      } else if (b.pType === 'node') {
        color = '#ffffff';
      } else {
        color = '#787878'; // decoy — intentionally lower contrast than nodes
      }

      ctx.beginPath();
      ctx.arc(cx, cy, r, trailingAngle, leadingAngle, true);
      ctx.strokeStyle = color;
      ctx.lineWidth = lwBar;
      ctx.stroke();
    }
  }
}
