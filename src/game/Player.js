import * as THREE from 'three';
import {
  PALETTE, PLAYER_POS, PLAYER_HOVER_Y, PLAYER_GROUNDED_Y, PLATFORM_TOP, GRAVITY, FALL_SNAP_VEL,
  HOVER_ENERGY_MAX, HOVER_DRAIN_RATE, HOVER_RECHARGE_RATE, HOVER_MIN_TO_START,
} from '../constants.js';

export const STATE_GROUNDED = 0;
export const STATE_HOVERING = 1;
export const STATE_FALLING  = 2;

const LERP_SPEED   = 10;  // Y interpolation coefficient (hovering)
const FLOAT_LERP   = 10;  // u_floating lerp coefficient (shader)

export class Player {
  constructor(scene, uniforms, synth) {
    this._uniforms = uniforms;
    this._synth    = synth;

    this.state           = STATE_GROUNDED;
    this.successCount    = 0;
    this.corruptionLevel = 0;
    this.hoverEnergy     = HOVER_ENERGY_MAX;

    // ── Main cube (red, rises on hover) — Lambert for face-depth shading ────
    // emissive: red has no G/B so shadowed faces drop to near-black without a floor.
    // 0x660000 keeps the player vivid red on all visible sides while preserving depth.
    const geo = new THREE.BoxGeometry(2.0, 2.0, 2.0);
    // 0xff2244: slightly more G+B than ACCENT (0xff0033) → same hue, higher lightness.
    // High emissive keeps the player vivid red on shadowed faces without washing out.
    const mat = new THREE.MeshLambertMaterial({ color: 0xff2244, emissive: 0x991122 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(PLAYER_POS.x, PLAYER_POS.y, PLAYER_POS.z);
    scene.add(this.mesh);

    // ── Ghost: clean 12-edge box outline, exactly half the player cube ────────
    // EdgesGeometry extracts only hard edges — no face diagonals.
    // White (PALETTE.NODE) keeps it distinct from red decoy wireframes (PALETTE.ACCENT).
    const ghostEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    // ACCENT (red) so after the hover inversion it becomes cyan — high contrast
    // over the dark-inverted platforms, clearly marking the landing target.
    const ghostMat   = new THREE.LineBasicMaterial({
      color: PALETTE.ACCENT,
      transparent: true,
      opacity: 0.75,
    });
    this._ghost = new THREE.LineSegments(ghostEdges, ghostMat);
    this._ghost.position.set(PLAYER_POS.x, PLATFORM_TOP + 0.52, PLAYER_POS.z);
    this._ghost.visible = false;
    scene.add(this._ghost);

    // Animated state — all primitives, no allocation in update()
    this._currentY  = PLAYER_POS.y;
    this._targetY   = PLAYER_POS.y;
    this._velocityY = 0;       // units/s, used during STATE_FALLING
    this._flashT    = 0;       // 0..1 landing flash, decays to red
    this._floating  = 0.0;    // 0→1 smooth, drives shader vignette

    this.onSpaceRelease = null; // () => void — set by GameLoop
    this.onSonarFire    = null; // () => void — called when ENTER fires
    this.onLaneChange   = null; // (dir: -1|1) => void — set by GameLoop

    this._onKeyDown = (e) => this._handleKeyDown(e);
    this._onKeyUp   = (e) => this._handleKeyUp(e);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
  }

  _handleKeyDown(e) {
    if (e.repeat) return;

    // SPACE lifts from grounded or falling (emergency recovery)
    if (e.code === 'Space' &&
        (this.state === STATE_GROUNDED || this.state === STATE_FALLING) &&
        this.hoverEnergy >= HOVER_MIN_TO_START) {
      e.preventDefault();
      this.state          = STATE_HOVERING;
      this._targetY       = PLAYER_HOVER_Y;
      this._velocityY     = 0;
      this._ghost.visible = true;
      this._synth.setHovering(true);
    }

    // ENTER fires sonar (right hand — keeps space thumb free)
    if (e.code === 'Enter' && this.state === STATE_HOVERING) {
      e.preventDefault();
      this._uniforms.u_pingTime.value = this._uniforms.u_time.value;
      if (this.onSonarFire) this.onSonarFire();
    }

    // A / Left arrow — step left lane (allowed mid-air)
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
      if (this.onLaneChange) this.onLaneChange(-1);
    }

    // D / Right arrow — step right lane (allowed mid-air)
    if (e.code === 'KeyD' || e.code === 'ArrowRight') {
      if (this.onLaneChange) this.onLaneChange(1);
    }
  }

  _handleKeyUp(e) {
    if (e.code === 'Space' && this.state === STATE_HOVERING) {
      e.preventDefault();
      this._ghost.visible = false;
      this._synth.setHovering(false);
      if (this.onSpaceRelease) this.onSpaceRelease();
    }
  }

  // ── Per-frame update — zero `new`. ──────────────────────────────────────
  update(dt) {
    // Ghost reticle tracks the player's lane continuously (mid-air switches included)
    this._ghost.position.x = this.mesh.position.x;

    if (this.state === STATE_FALLING) {
      this._velocityY      += GRAVITY * dt;
      this._currentY       += this._velocityY * dt;
      this.mesh.position.y  = this._currentY;
    } else if (this.state === STATE_GROUNDED) {
      this._currentY        = PLAYER_GROUNDED_Y;
      this.mesh.position.y  = PLAYER_GROUNDED_Y;
      this.hoverEnergy      = Math.min(HOVER_ENERGY_MAX, this.hoverEnergy + HOVER_RECHARGE_RATE * dt);
    } else { // STATE_HOVERING
      this._currentY += (this._targetY - this._currentY) * Math.min(1, LERP_SPEED * dt);
      this.mesh.position.y = this._currentY;
      this.hoverEnergy = Math.max(0, this.hoverEnergy - HOVER_DRAIN_RATE * dt);
      if (this.hoverEnergy === 0) {
        this._ghost.visible = false;
        this._synth.setHovering(false);
        if (this.onSpaceRelease) this.onSpaceRelease();
      }
    }

    // Landing flash: cube briefly brightens toward white then decays back to red
    if (this._flashT > 0) {
      this._flashT = Math.max(0, this._flashT - dt * 4);
      this.mesh.material.color.setRGB(
        1.0,
        1.0 - this._flashT * 0.7,
        1.0 - this._flashT * 0.7
      );
    } else {
      this.mesh.material.color.setHex(0xff2244);
    }

    // Smooth floating value → drives shader vignette
    const floatTarget = this.state === STATE_HOVERING ? 0.5 : 0.0;
    this._floating   += (floatTarget - this._floating) * Math.min(1, FLOAT_LERP * dt);
    this._uniforms.u_floating.value = this._floating;
  }

  // ── Landing from a fall — called by GameLoop when platform detected below. ──
  land(quality) {
    this.state        = STATE_GROUNDED;
    this._currentY    = PLAYER_GROUNDED_Y;
    this._targetY     = PLAYER_GROUNDED_Y;
    this._velocityY   = 0;
    this._flashT      = quality === 'perfect' ? 1.0 : 0.5;
  }

  // ── Landing instantly from hover (SPACE released over platform). ──────────
  landFromHover() {
    this.state      = STATE_GROUNDED;
    this._targetY   = PLAYER_GROUNDED_Y;
    this._velocityY = 0;
    this._flashT    = 0.4;
  }

  // ── Begin falling. snapVel: immediate initial velocity (negative = downward). ──
  // Deliberate drops (space release) pass FALL_SNAP_VEL for instant commitment;
  // passive falls (running off an edge) start at 0 and let gravity build.
  startFalling(snapVel = 0) {
    this.state      = STATE_FALLING;
    this._velocityY = snapVel;
  }

  get currentY() { return this._currentY; }

  registerHit() {
    this.successCount++;
    this._synth.triggerHitBoom();
    this.corruptionLevel = Math.max(0, this.corruptionLevel - 8 / 100);
    this._uniforms.u_corruption.value = this.corruptionLevel;
  }

  registerMiss() {
    this.corruptionLevel = Math.min(1, this.corruptionLevel + 22 / 100);
    this._uniforms.u_corruption.value = this.corruptionLevel;
    this._synth.triggerFailure();
  }
}
