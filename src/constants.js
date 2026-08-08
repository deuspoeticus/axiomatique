// ─── Palette ────────────────────────────────────────────────────────────────
// Landed state: dark bg, off-white platforms, dark-gray decoys.
// Hover state: post-shader inverts everything → light bg, dark platforms.
export const PALETTE = {
  VOID:   0x1e1e1e,   // dark charcoal (landed background)
  NODE:   0xffffff,   // pure white (real platforms, quantum wireframes)
  DECOY:  0x787878,   // medium gray (decoys when grounded)
  ACCENT: 0xff0033,   // red (player, sonar reveals, sonar ring)
};

// ─── Camera ──────────────────────────────────────────────────────────────────
export const CAM_POS = { x: 15, y: 15, z: 15 };
export const CAM_FRUSTUM = 10; // half-size of orthographic frustum

// ─── Platform geometry ────────────────────────────────────────────────────────
export const PLATFORM_Y        = 0;
export const PLATFORM_HALF_H   = 0.25;  // BoxGeometry height 0.5 / 2
export const PLATFORM_TOP      = 0.25;
export const BASE_Z_DEPTH      = 1.2;   // BoxGeometry Z depth (unchanged geometry)

// ─── Player ──────────────────────────────────────────────────────────────────
export const PLAYER_HALF_H     = 1.0;   // BoxGeometry height 2.0 / 2
export const PLAYER_GROUNDED_Y = 1.25;  // PLATFORM_TOP + PLAYER_HALF_H
export const PLAYER_POS        = { x: 0, y: 1.25, z: 0 };
export const PLAYER_HOVER_Y    = 4.5;   // lift height while holding SPACEBAR
export const PLAYER_SQUASH_DUR = 0.14;  // seconds the squash lasts after slam

// ─── Physics ─────────────────────────────────────────────────────────────────
export const GRAVITY           = -15.0; // units / s²
export const FALL_SNAP_VEL     = -22.0; // immediate downward velocity on deliberate drop
export const DEATH_Y           = -3.0;  // Y below which player dies

// ─── Starting platform ────────────────────────────────────────────────────────
export const START_PLAT_CENTER_Z = -27;
export const START_PLAT_LEN      = 60;  // Z units — player on it for ~4.75s

// ─── Block pool ──────────────────────────────────────────────────────────────
export const POOL_SIZE = 256; // instances per mesh type

// ─── Audio ───────────────────────────────────────────────────────────────────
export const DEFAULT_BPM   = 100;  // Starting BPM — ramps up to BPM_MAX
export const BPM_MAX       = 200;  // Hard cap at maximum intensity
export const BPM_RAMP_BEATS = 16;  // Beats per phrase; BPM steps on each phrase boundary
export const SUB_FREQ      = 50;   // Hz, Bus A kick sub-bass
export const LOOKAHEAD_MS  = 100;  // scheduler lookahead window

// ─── Music intensity ─────────────────────────────────────────────────────────
// Intensity 0→1 drives layer entry and difficulty. Driven primarily by elapsed
// beats; combo streaks accelerate it, misses pull it back.
export const INITIAL_INTENSITY     = 0.30; // starting intensity — full groove from bar 1
export const INTENSITY_TOTAL_BEATS = 512; // beats to reach full intensity naturally
export const INTENSITY_COMBO_BONUS = 0.05; // added at combo multiples of 8
export const INTENSITY_MISS_PENALTY = 0.10; // subtracted on miss/decoy

// ─── Frequency band lanes ─────────────────────────────────────────────────────
// Lane −1 = sub-bass (Reese/kick)  → long slow platforms
// Lane  0 = mid (kick/snare)       → regular platforms
// Lane +1 = high (hats/stabs)      → short fast platforms
export const BASS_LANE = -1;
export const MID_LANE  =  0;
export const HIGH_LANE =  1;

// ─── Track ───────────────────────────────────────────────────────────────────
export const SPAWN_Z       = -60;  // Z where blocks are born
export const RECYCLE_Z     = 8;    // Z past which blocks return to pool
export const BLOCK_SPEED   = 12;   // units / second at DEFAULT_BPM

// ─── Phase times (seconds) — kept for PhaseManager compat ──────────────────
export const PHASE_TIMES = {
  DESCENT:      0,
  DESYNC:       240,  // 4:00
  PERFECT_LOOP: 295,  // 4:55
};

// ─── Sonar (shader) ──────────────────────────────────────────────────────────
export const SONAR_SPEED     = 1.0; // uv-units / second
export const SONAR_THICKNESS = 0.066;

// ─── Sonar (game logic) ───────────────────────────────────────────────────────
export const SONAR_CORRUPTION_COST = 10;     // corruption added per ping
export const SONAR_REVEAL_DUR      = 5.0;    // seconds a platform stays revealed after ring contact
export const SONAR_SWEEP_FACTOR    = 0.0233; // s/world-unit — Z=-60 reveals at ~1.4s ≈ ring duration
export const SONAR_MAX_DIST        = 55;     // world units — platforms farther than this are not revealed

// ─── Compass glyph timing ────────────────────────────────────────────────────
// Glyphs travel a quarter-circle (3 o'clock → 12 o'clock) in the same time
// a block travels from SPAWN_Z to the player at BLOCK_SPEED.
export const GLYPH_ARC   = Math.PI / 2;                        // radians to travel
export const GLYPH_TRAVEL = Math.abs(-60) / 12;                // seconds = 5
export const GLYPH_SPEED  = GLYPH_ARC / GLYPH_TRAVEL;         // ~0.314 rad/s

// ─── Lanes ────────────────────────────────────────────────────────────────────
export const LANE_SPACING = 6;        // world units between lane centers
export const ACTIVE_LANES = [-1, 0, 1]; // lane indices in use

// ─── Hover energy ────────────────────────────────────────────────────────────
export const HOVER_ENERGY_MAX    = 100;
export const HOVER_DRAIN_RATE    = 20;  // units/sec while hovering
export const HOVER_RECHARGE_RATE = 40;  // units/sec while grounded
export const HOVER_MIN_TO_START  = 10;  // minimum energy required to initiate hover
export const HOVER_LAND_BOOST    = 35;  // energy restored instantly on a good/perfect landing

// ─── Collision / corruption ───────────────────────────────────────────────────
export const COLL_WINDOW  = 1.4;   // legacy — kept until GameLoop refactor
export const MAX_CORRUPT  = 100;

// ─── Glyph table for Compass scramble ────────────────────────────────────────
export const ASCII_NOISE = '█▓▒░╬╠╣╦╩╔╗╚╝│─┼@#$%&?!<>~^*';
