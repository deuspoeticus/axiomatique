import {
  DEFAULT_BPM, SPAWN_Z, BLOCK_SPEED, LANE_SPACING,
  START_PLAT_CENTER_Z, START_PLAT_LEN,
  PLAYER_GROUNDED_Y, PLAYER_HOVER_Y, DEATH_Y, FALL_SNAP_VEL,
  SONAR_CORRUPTION_COST, SONAR_SWEEP_FACTOR, SONAR_MAX_DIST,
  HOVER_ENERGY_MAX, HOVER_LAND_BOOST,
  PALETTE,
} from '../constants.js';
import { STATE_GROUNDED, STATE_HOVERING, STATE_FALLING } from './Player.js';
import { LevelGenerator } from '../track/LevelGenerator.js';

// Beat clock uses synth.beatLen (dynamic) — no hardcoded constant.
const MAX_CORRUPT = 100;

export class GameLoop {
  constructor({ renderer, scene, camera, composer, uniforms },
              trackEngine, synth, compass, player, phaseManager) {
    this._composer     = composer;
    this._camera       = camera;
    this._uniforms     = uniforms;
    this._trackEngine  = trackEngine;
    this._synth        = synth;
    this._compass      = compass;
    this._player       = player;
    this._phaseManager = phaseManager;

    this._lastTime  = 0;
    this._rafId     = -1;
    this._progress  = 0;
    this._beatClock = 0;
    this._totalTime = 0;
    this._corrupt   = 0; // 0→MAX_CORRUPT

    // Procedural level generation
    this._levelGen    = new LevelGenerator();
    this._seqBeatRem  = 0;   // beats remaining for current event
    this._seqNewElem  = true; // request next event on first beat

    // Lane state
    this._playerLane = 0; // -1 | 0 | 1

    // Fall state
    this._isFalling      = false;
    this._fallDeathFired = false;

    // Camera shake state (pre-allocated, no `new` in rAF)
    this._cameraBaseX    = camera.position.x;
    this._cameraBaseY    = camera.position.y;
    this._cameraBaseZ    = camera.position.z;
    this._shakeStartTime = -1;
    this._shakeEndTime   = -1;
    this._shakeDuration  = 0;
    this._shakeAmplitude = 0;

    // Whiteout: set to true when u_whiteout fires; cleared next frame
    this._whiteoutPending = false;

    // HUD element refs (grabbed once, not queried every frame)
    this._hudScore   = document.getElementById('scoreVal');
    this._hudCorrupt = document.getElementById('corruptVal');
    this._hudCombo   = document.getElementById('comboVal');
    this._hudHover   = document.getElementById('hoverBar');
    this._hudPhase   = document.getElementById('phaseLabel');
    this._statusEl   = document.getElementById('status');
    this._combo      = 0;
    this._score      = 0;
    this._phase      = 'playing';
    this._lastPhase  = '';

    // Wire player callbacks
    player.onSpaceRelease = () => this._handleSpaceRelease();
    player.onSonarFire    = () => this._fireSonar();
    player.onLaneChange   = (dir) => {
      this._playerLane = Math.max(-1, Math.min(1, this._playerLane + dir));
      const x = this._playerLane * LANE_SPACING;
      player.mesh.position.x   = x;
      player._ghost.position.x = x;
    };

    // Wire MusicEngine phrase callback → LevelGenerator
    const engine = synth.engine;
    if (engine) {
      engine.onPhrase = (pattern) => {
        this._levelGen.setMusicalState(pattern, engine.bpm, engine.intensity);
      };
    }

    this._paused = true;

    this._tick = this._tick.bind(this);
  }

  // Begin rendering the static scene immediately (before user gesture / synth init).
  startPaused() {
    this._trackEngine._pool.acquire('node', 0, START_PLAT_CENTER_Z, START_PLAT_LEN);
    this._lastTime = performance.now();
    this._rafId    = requestAnimationFrame(this._tick);
  }

  // Called after user gesture — begins physics, beats, audio.
  resume() {
    this._paused   = false;
    this._lastTime = performance.now();
  }

  // Legacy alias kept so existing callers still work.
  start() {
    this.startPaused();
    this.resume();
  }

  stop() {
    cancelAnimationFrame(this._rafId);
  }

  // ── Core loop — ZERO `new` inside ───────────────────────────────────────
  _tick(now) {
    this._rafId = requestAnimationFrame(this._tick);

    const tSec = now / 1000;

    // Paused: render the static scene with live shader time, nothing else.
    if (this._paused) {
      this._uniforms.u_time.value       = tSec;
      this._uniforms.u_corruption.value = 0;
      this._composer.render();
      this._lastTime = now;
      return;
    }

    const dt       = Math.min((now - this._lastTime) / 1000, 0.05);
    this._lastTime = now;

    // Clear whiteout one frame after it was set
    if (this._whiteoutPending) {
      this._uniforms.u_whiteout.value = 0.0;
      this._whiteoutPending = false;
    }

    if (this._phase !== 'playing') {
      this._uniforms.u_time.value       = tSec;
      this._uniforms.u_corruption.value = this._phase === 'dead' ? 1.0 : this._corrupt / MAX_CORRUPT;
      this._composer.render();
      return;
    }

    this._totalTime += dt;

    // ── 1. Phase update ───────────────────────────────────────────────────────
    this._phaseManager.update(dt, this._uniforms, this._synth, this._trackEngine);

    // ── 2. Beat clock — driven by live synth.beatLen (ramps with BPM) ───────────────
    const beatSec = this._synth.beatLen; // live value from MusicEngine
    this._beatClock += dt;
    if (this._beatClock >= beatSec) {
      this._beatClock -= beatSec;
      this._advanceBeat();
    }

    // ── 3. Player physics ─────────────────────────────────────────────────────
    this._player.update(dt);

    // ── 4. Move platforms ─────────────────────────────────────────────────────
    this._trackEngine.update(dt);

    // ── 4b. Landing detection ─────────────────────────────────────────────────
    this._checkLanding(tSec);

    // ── 5c. Superposition: decoys appear white while not grounded ─────────────
    const pool = this._trackEngine._pool;
    if (this._player.state === STATE_GROUNDED) {
      pool.decoyMesh.material.color.setHex(PALETTE.DECOY); // gray — true color
    } else {
      pool.decoyMesh.material.color.setHex(PALETTE.NODE);  // white — superposition
    }

    // ── 5d. Quantum state — drives jitter + wireframe bleed in BlockPool ──────
    const floatNorm   = this._player._floating * 2.0;     // 0→1 (Player caps _floating at 0.5)
    const corruptNorm = this._corrupt / MAX_CORRUPT;
    pool.quantumStrength   = floatNorm * Math.max(0.25, corruptNorm);
    pool.quantumCorruption = corruptNorm;
    pool.quantumTime       = tSec;

    // ── 6. Compass draw ───────────────────────────────────────────────────────
    this._progress = Math.min(1, this._score / 1600);
    const isScrambled = this._corrupt > MAX_CORRUPT * 0.5;
    this._compass.draw(dt, this._progress, isScrambled);

    // ── 7. Post-processing uniforms ───────────────────────────────────────────
    this._uniforms.u_time.value       = tSec;
    this._uniforms.u_corruption.value = corruptNorm;
    // Boost vignette depth with corruption while hovering (Player caps u_floating at 0.5)
    this._uniforms.u_floating.value   = this._player._floating + floatNorm * corruptNorm * 0.5;

    // Camera shake — mutates camera position in-place, no allocation
    if (tSec < this._shakeEndTime) {
      const decay  = (this._shakeEndTime - tSec) / this._shakeDuration;
      const offset = Math.sin(tSec * 40) * this._shakeAmplitude * decay;
      this._camera.position.x = this._cameraBaseX + offset;
      this._camera.position.z = this._cameraBaseZ - offset;
    } else if (tSec >= this._shakeEndTime && this._shakeEndTime > 0) {
      this._camera.position.x = this._cameraBaseX;
      this._camera.position.z = this._cameraBaseZ;
      this._shakeEndTime = -1;
    }

    // ── 8. HUD ───────────────────────────────────────────────────────────────────
    if (this._hudScore)   this._hudScore.textContent   = Math.floor(this._score);
    if (this._hudCorrupt) this._hudCorrupt.textContent = Math.floor(this._corrupt);
    if (this._hudCombo)   this._hudCombo.textContent   = this._combo;
    if (this._hudHover) {
      const pct = this._player.hoverEnergy;
      this._hudHover.style.height     = pct + '%';
      this._hudHover.style.background = pct < 25 ? '#ff0033' : '#ffffff';
    }
    this._updatePhaseLabel();

    // ── 9. Render ─────────────────────────────────────────────────────────────
    this._composer.render();
  }

  // ── Procedural beat spawner — fires once per beat. ──────────────────────
  _advanceBeat() {
    if (this._seqNewElem) {
      const desc   = this._levelGen.next();
      this._seqBeatRem = desc.beats;
      this._seqNewElem = false;

      if (desc.type !== 'gap') {
        // Use live beatLen and live speed so platform Z = exactly N beats of travel
        const beatSec = this._synth.beatLen;
        const speed   = this._trackEngine._speed_live;
        const zLen    = desc.beats * beatSec * speed;
        const center  = SPAWN_Z - zLen * 0.5;
        const laneX   = desc.lane * LANE_SPACING;
        this._trackEngine._pool.acquire(desc.type, laneX, center, zLen);
        this._compass.addBar(desc.type, desc.beats);
      } else {
        this._compass.addGap(desc.beats);
      }
    }

    this._seqBeatRem--;
    if (this._seqBeatRem <= 0) this._seqNewElem = true;
  }

  // ── Per-frame landing detection. ─────────────────────────────────────────
  _checkLanding(tSec) {
    const pool    = this._trackEngine._pool;
    const player  = this._player;
    const platIdx = pool.getPlatformUnderPlayer(player.mesh.position.x);
    const state   = player.state;

    if (state === STATE_FALLING) {
      if (platIdx >= 0) {
        // Platform under player — land when Y descends to surface level.
        if (player.currentY <= PLAYER_GROUNDED_Y + 0.05) {
          const isDecoy = pool._activeType[platIdx] === 1;
          if (isDecoy) {
            // Decoy: apply penalty, then free-fall from hover height.
            this._corrupt = Math.min(MAX_CORRUPT, this._corrupt + 15);
            this._synth.triggerDecoyLand();
            this._compass.scrambleAll();
            this._combo = 0;
            // Visual failure spike: chromatic + scan lines + shake (lighter)
            this._uniforms.u_failureTime.value = tSec;
            this._uniforms.u_failureType.value = 2.0;
            this._shakeStartTime = tSec;
            this._shakeEndTime   = tSec + 0.28;
            this._shakeDuration  = 0.28;
            this._shakeAmplitude = 0.14;
            // Respawn mid-air in free fall — player must press space to recover
            player._currentY      = PLAYER_HOVER_Y;
            player._ghost.visible = false;
            player.startFalling(0);
            this._isFalling      = true;
            this._fallDeathFired = false;
          } else {
            const zStart  = pool._activeZStart[platIdx];
            const zEnd    = pool._activeZEnd[platIdx];
            const rel     = (0 - zStart) / (zEnd - zStart);
            const quality = (rel > 0.333 && rel < 0.667) ? 'perfect' : 'good';
            pool.notifyLanded(platIdx, tSec);
            player.land(quality);
            this._isFalling = false;
            this._combo++;
            if (quality === 'perfect') {
              this._score  += 200 + this._combo * 50;
              this._corrupt = Math.max(0, this._corrupt - 10);
              this._synth.triggerPerfectLand();
              this._synth.notifyCombo(this._combo);
            } else {
              this._score  += 100 + this._combo * 25;
              this._corrupt = Math.max(0, this._corrupt - 5);
              this._synth.triggerGoodLand();
              this._synth.notifyCombo(this._combo);
            }
            player.hoverEnergy = Math.min(HOVER_ENERGY_MAX, player.hoverEnergy + HOVER_LAND_BOOST);
            this._player.registerHit();
          }
        }
      } else {
        // No platform — check death threshold.
        if (player.currentY < DEATH_Y && !this._fallDeathFired) {
          this._fallDeathFired = true;
          this._combo  = 0;
          this._corrupt = Math.min(MAX_CORRUPT, this._corrupt + 20);
          this._player.registerMiss();
          this._synth.triggerGapFall();
          this._synth.notifyMiss();
          // Visual failure spike: whiteout flash + full chromatic explosion + shake
          this._uniforms.u_failureTime.value = tSec;
          this._uniforms.u_failureType.value = 1.0;
          this._uniforms.u_whiteout.value    = 1.0;
          this._whiteoutPending = true;
          this._shakeStartTime  = tSec;
          this._shakeEndTime    = tSec + 0.48;
          this._shakeDuration   = 0.48;
          this._shakeAmplitude  = 0.28;
          if (this._corrupt >= MAX_CORRUPT) {
            this._triggerDeath(tSec);
          } else {
            // Mercy respawn: drop back in from hover height — press space to catch yourself
            player._currentY      = PLAYER_HOVER_Y;
            player._ghost.visible = false;
            player.startFalling(0);
            this._isFalling      = true;
            this._fallDeathFired = false;
          }
        }
      }
    }

    // GROUNDED: verify platform still exists under player; fall if it's gone.
    if (state === STATE_GROUNDED && platIdx < 0) {
      player.startFalling();
      this._isFalling      = true;
      this._fallDeathFired = false;
    }
  }

  // ── SHIFT pressed while hovering: fire sonar ring. ──────────────────────
  _fireSonar() {
    this._trackEngine._pool.fireSonar(SONAR_SWEEP_FACTOR, SONAR_MAX_DIST);
    this._corrupt = Math.min(MAX_CORRUPT, this._corrupt + SONAR_CORRUPTION_COST);
  }

  // ── SPACE released while hovering: decide land, bounce, or fall. ─────────
  _handleSpaceRelease() {
    const pool    = this._trackEngine._pool;
    const platIdx = pool.getPlatformUnderPlayer(this._player.mesh.position.x);

    if (platIdx >= 0 && pool._activeType[platIdx] === 0) {
      pool.notifyLanded(platIdx, performance.now() / 1000);
      this._player.landFromHover();
      this._isFalling = false;
      this._combo++;
      this._score  += 100;
      this._corrupt = Math.max(0, this._corrupt - 5);
      this._synth.triggerGoodLand();
      this._synth.notifyCombo(this._combo);
      this._player.hoverEnergy = Math.min(HOVER_ENERGY_MAX, this._player.hoverEnergy + HOVER_LAND_BOOST);
      this._player.registerHit();
    } else if (platIdx >= 0 && pool._activeType[platIdx] === 1) {
      // Decoy under player — snap-fall onto it; penalty fires on physical contact in _checkLanding.
      this._player.startFalling(FALL_SNAP_VEL);
      this._isFalling      = true;
      this._fallDeathFired = false;
    } else {
      // No platform — snap downward immediately (deliberate drop feels committed).
      this._player.startFalling(FALL_SNAP_VEL);
      this._isFalling      = true;
      this._fallDeathFired = false;
    }
  }

  _triggerDeath(tSec) {
    this._phase = 'dead';
    this._uniforms.u_deathTime.value = tSec;
    const score = Math.floor(this._score);
    if (this._statusEl) {
      this._statusEl.textContent   = `KERNEL PANIC\nCORRUPTION: 100%\n\nFINAL SCORE: ${score}\n\n[ANY KEY TO RESTART]`;
      this._statusEl.style.display = 'block';
    }
    setTimeout(() => {
      window.addEventListener('keydown', () => {
        sessionStorage.setItem('autoboot', '1');
        window.location.reload();
      }, { once: true });
    }, 800);
  }

  _showStatus(msg) {
    if (!this._statusEl) return;
    this._statusEl.textContent   = msg;
    this._statusEl.style.display = 'block';
  }

  _updatePhaseLabel() {
    if (!this._hudPhase) return;
    const bpm = this._synth.ready ? Math.round(this._synth.bpm) : 120;
    const pct = this._synth.ready ? Math.round(this._synth.intensity * 100) : 0;
    let phase;
    if (this._totalTime >= 295)      phase = 'PHASE III // THE PERFECT LOOP';
    else if (this._totalTime >= 240) phase = 'PHASE II  // THE DESYNC';
    else                             phase = 'PHASE I   // THE DESCENT';
    const label = `${phase}  │  ${bpm} BPM  │  INTENSITY ${pct}%`;
    if (label !== this._lastPhase) {
      this._hudPhase.textContent = label;
      this._lastPhase = label;
    }
  }
}
