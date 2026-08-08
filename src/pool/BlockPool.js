import * as THREE from 'three';
import { POOL_SIZE, PALETTE, PLATFORM_Y, BASE_Z_DEPTH, LANE_SPACING } from '../constants.js';

const _geoSolid = new THREE.BoxGeometry(2.0, 0.5, 1.2);
// Dense subdivided geometry for wireframe scribble — many more edges
const _geoWire = new THREE.BoxGeometry(2.0, 0.5, 1.2, 5, 2, 5);

const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion(); // identity — never mutated
const _scale = new THREE.Vector3();
const _WHITE_COL = new THREE.Color(1, 1, 1);
const _RED_COL = new THREE.Color(PALETTE.ACCENT);

const GHOST_POOL = 12;
const SCRIBBLE_CAP = POOL_SIZE * 2; // second scribble layer uses active-list index as slot
const LAND_DUR = 1.4;           // seconds for wireframe → solid transition on landing
const LANE_X = [-LANE_SPACING, 0, LANE_SPACING];

export class BlockPool {
  constructor(scene) {
    // ── Solid meshes — Lambert so the directional/hemisphere lights shade faces ─
    // emissive gives a brightness floor so shadowed faces don't go too dark.
    const nodeMat  = new THREE.MeshLambertMaterial({ color: PALETTE.NODE,  emissive: 0x222222 });
    const decoyMat = new THREE.MeshLambertMaterial({ color: PALETTE.DECOY, emissive: 0x101010 });
    this.nodeMesh = new THREE.InstancedMesh(_geoSolid, nodeMat, POOL_SIZE);
    this.decoyMesh = new THREE.InstancedMesh(_geoSolid, decoyMat, POOL_SIZE);

    _m4.makeScale(0, 0, 0);
    for (let i = 0; i < POOL_SIZE; i++) {
      this.nodeMesh.setMatrixAt(i, _m4);
      this.decoyMesh.setMatrixAt(i, _m4);
    }
    this.nodeMesh.instanceMatrix.needsUpdate = true;
    this.decoyMesh.instanceMatrix.needsUpdate = true;
    scene.add(this.nodeMesh);
    scene.add(this.decoyMesh);

    // ── Wireframe layer 1 — per-type (decoy color toggled in quantum mode) ───
    this._nodeWireMat = new THREE.MeshBasicMaterial({
      color: PALETTE.NODE, wireframe: true,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this._decoyWireMat = new THREE.MeshBasicMaterial({
      color: PALETTE.ACCENT, wireframe: true,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this.nodeWireMesh = new THREE.InstancedMesh(_geoWire, this._nodeWireMat, POOL_SIZE);
    this.decoyWireMesh = new THREE.InstancedMesh(_geoWire, this._decoyWireMat, POOL_SIZE);
    for (let i = 0; i < POOL_SIZE; i++) {
      this.nodeWireMesh.setMatrixAt(i, _m4);
      this.decoyWireMesh.setMatrixAt(i, _m4);
    }
    this.nodeWireMesh.instanceMatrix.needsUpdate = true;
    this.decoyWireMesh.instanceMatrix.needsUpdate = true;
    scene.add(this.nodeWireMesh);
    scene.add(this.decoyWireMesh);

    // ── Wireframe layer 2 — second scribble overlay, always white ────────────
    // Uses active-list index as slot (not pool slot) — SCRIBBLE_CAP capacity.
    const scribbleMat = new THREE.MeshBasicMaterial({
      color: PALETTE.NODE, wireframe: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.scribbleMesh = new THREE.InstancedMesh(_geoWire, scribbleMat, SCRIBBLE_CAP);
    for (let i = 0; i < SCRIBBLE_CAP; i++) this.scribbleMesh.setMatrixAt(i, _m4);
    this.scribbleMesh.instanceMatrix.needsUpdate = true;
    this._scribbleCount = 0; // how many scribble slots written last frame
    scene.add(this.scribbleMesh);

    // ── Ghost platforms — fake decoys on wrong lanes ──────────────────────────
    const ghostMat = new THREE.MeshBasicMaterial({
      color: PALETTE.NODE, wireframe: true,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this.ghostMesh = new THREE.InstancedMesh(_geoWire, ghostMat, GHOST_POOL);
    for (let i = 0; i < GHOST_POOL; i++) this.ghostMesh.setMatrixAt(i, _m4);
    this.ghostMesh.instanceMatrix.needsUpdate = true;
    scene.add(this.ghostMesh);

    // ── Glow meshes — additive, shown on sonar-revealed platforms ────────────
    const nodeGlowMat = new THREE.MeshBasicMaterial({
      color: PALETTE.NODE, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const decoyGlowMat = new THREE.MeshBasicMaterial({
      color: PALETTE.ACCENT, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.nodeGlowMesh = new THREE.InstancedMesh(_geoSolid, nodeGlowMat, POOL_SIZE);
    this.decoyGlowMesh = new THREE.InstancedMesh(_geoSolid, decoyGlowMat, POOL_SIZE);
    for (let i = 0; i < POOL_SIZE; i++) {
      this.nodeGlowMesh.setMatrixAt(i, _m4);
      this.decoyGlowMesh.setMatrixAt(i, _m4);
    }
    this.nodeGlowMesh.instanceMatrix.needsUpdate = true;
    this.decoyGlowMesh.instanceMatrix.needsUpdate = true;
    scene.add(this.nodeGlowMesh);
    scene.add(this.decoyGlowMesh);

    // ── Instance colors (decoy superposition default = white) ─────────────────
    for (let i = 0; i < POOL_SIZE; i++) this.decoyMesh.setColorAt(i, _WHITE_COL);
    this.decoyMesh.instanceColor.needsUpdate = true;
    this._colorDirty = false;

    // ── Free-slot stacks ──────────────────────────────────────────────────────
    this._nodeFree = new Int32Array(POOL_SIZE);
    this._decoyFree = new Int32Array(POOL_SIZE);
    this._nodeFreeLen = POOL_SIZE;
    this._decoyFreeLen = POOL_SIZE;
    for (let i = 0; i < POOL_SIZE; i++) {
      this._nodeFree[i] = POOL_SIZE - 1 - i;
      this._decoyFree[i] = POOL_SIZE - 1 - i;
    }

    // ── Active block records ──────────────────────────────────────────────────
    this._activeIdx = new Int32Array(POOL_SIZE * 2);
    this._activeType = new Uint8Array(POOL_SIZE * 2);
    this._activeX = new Float32Array(POOL_SIZE * 2);
    this._activeZ = new Float32Array(POOL_SIZE * 2);
    this._activeZStart = new Float32Array(POOL_SIZE * 2);
    this._activeZEnd = new Float32Array(POOL_SIZE * 2);
    this._activeZLen = new Float32Array(POOL_SIZE * 2);
    this._activeTriggered = new Uint8Array(POOL_SIZE * 2);
    this._activeRevealStart = new Float32Array(POOL_SIZE * 2);
    this._activeRevealEnd = new Float32Array(POOL_SIZE * 2);
    this._activeRevealed = new Uint8Array(POOL_SIZE * 2);
    this._activeLandTime = new Float32Array(POOL_SIZE * 2).fill(-1e9);
    this._activeLen = 0;

    // ── Sonar state ───────────────────────────────────────────────────────────
    this._sonarFired = false;
    this._sonarAge = 0;
    this._sonarDur = 0;

    // ── Quantum superposition state (set by GameLoop every frame) ─────────────
    this.quantumStrength = 0;
    this.quantumCorruption = 0;
    this.quantumTime = 0;
  }

  // ── Notify BlockPool that a platform was landed on (starts material transition). ──
  notifyLanded(ai, t) {
    if (ai >= 0 && ai < this._activeLen) this._activeLandTime[ai] = t;
  }

  acquire(type, x, zCenter, zLen) {
    const isNode = type === 'node';
    const freeArr = isNode ? this._nodeFree : this._decoyFree;
    const freeLen = isNode ? this._nodeFreeLen : this._decoyFreeLen;
    if (freeLen === 0) return -1;

    const slot = freeArr[freeLen - 1];
    if (isNode) this._nodeFreeLen--;
    else this._decoyFreeLen--;

    _pos.set(x, PLATFORM_Y, zCenter);
    _scale.set(1, 1, zLen / BASE_Z_DEPTH);
    _m4.compose(_pos, _quat, _scale);
    const solidMesh = isNode ? this.nodeMesh : this.decoyMesh;
    solidMesh.setMatrixAt(slot, _m4);
    solidMesh.instanceMatrix.needsUpdate = true;

    _m4.makeScale(0, 0, 0);
    const wireMesh = isNode ? this.nodeWireMesh : this.decoyWireMesh;
    wireMesh.setMatrixAt(slot, _m4);
    wireMesh.instanceMatrix.needsUpdate = true;

    const glowMesh = isNode ? this.nodeGlowMesh : this.decoyGlowMesh;
    glowMesh.setMatrixAt(slot, _m4);
    glowMesh.instanceMatrix.needsUpdate = true;

    if (!isNode) {
      this.decoyMesh.setColorAt(slot, _WHITE_COL);
      this._colorDirty = true;
    }

    const ai = this._activeLen++;
    this._activeIdx[ai] = slot;
    this._activeType[ai] = isNode ? 0 : 1;
    this._activeX[ai] = x;
    this._activeZ[ai] = zCenter;
    this._activeZLen[ai] = zLen;
    this._activeZStart[ai] = zCenter - zLen * 0.5;
    this._activeZEnd[ai] = zCenter + zLen * 0.5;
    this._activeTriggered[ai] = 0;
    this._activeRevealStart[ai] = 1e9;
    this._activeRevealEnd[ai] = 0;
    this._activeRevealed[ai] = 0;
    this._activeLandTime[ai] = -1e9;
    return ai;
  }

  fireSonar(sweepFactor, maxDist) {
    this._sonarFired = true;
    this._sonarAge = 0;
    this._sonarDur = maxDist * sweepFactor + 0.1;

    for (let i = 0; i < this._activeLen; i++) {
      const dist = Math.max(0, -this._activeZ[i]);
      if (this._activeRevealed[i] === 1 && this._activeType[i] === 1) {
        this.decoyMesh.setColorAt(this._activeIdx[i], _WHITE_COL);
        this._colorDirty = true;
      }
      this._activeRevealed[i] = 0;
      this._activeRevealStart[i] = dist > maxDist ? 1e9 : dist * sweepFactor;
    }
  }

  update(deltaTime, speed, recycleZ) {
    if (this._sonarFired) {
      this._sonarAge += deltaTime;
      if (this._sonarAge >= this._sonarDur) this._sonarFired = false;
    }

    const qs = this.quantumStrength;
    const qc = this.quantumCorruption;
    const qt = this.quantumTime;
    const quantumActive = qs > 0.01 && !this._sonarFired;

    // Decoy wireframe color: white (indistinguishable) in quantum, red in normal/sonar
    this._decoyWireMat.color.setHex(quantumActive ? PALETTE.NODE : PALETTE.ACCENT);

    let gSlot = 0;
    let scrSlot = 0;

    let i = 0;
    while (i < this._activeLen) {
      const dz = deltaTime * speed;
      this._activeZ[i] += dz;
      this._activeZStart[i] += dz;
      this._activeZEnd[i] += dz;

      if (this._activeZStart[i] > recycleZ) {
        this._releaseAt(i);
        const last = this._activeLen - 1;
        if (i !== last) {
          this._activeIdx[i] = this._activeIdx[last];
          this._activeType[i] = this._activeType[last];
          this._activeX[i] = this._activeX[last];
          this._activeZ[i] = this._activeZ[last];
          this._activeZLen[i] = this._activeZLen[last];
          this._activeZStart[i] = this._activeZStart[last];
          this._activeZEnd[i] = this._activeZEnd[last];
          this._activeTriggered[i] = this._activeTriggered[last];
          this._activeRevealStart[i] = this._activeRevealStart[last];
          this._activeRevealEnd[i] = this._activeRevealEnd[last];
          this._activeRevealed[i] = this._activeRevealed[last];
          this._activeLandTime[i] = this._activeLandTime[last];
        }
        this._activeLen--;
      } else {
        const isNode = this._activeType[i] === 0;
        const solidMesh = isNode ? this.nodeMesh : this.decoyMesh;
        const wireMesh = isNode ? this.nodeWireMesh : this.decoyWireMesh;
        const glowMesh = isNode ? this.nodeGlowMesh : this.decoyGlowMesh;
        const slot = this._activeIdx[i];
        const zScale = this._activeZLen[i] / BASE_Z_DEPTH;

        const wasRevealed = this._activeRevealed[i] === 1;
        const nowRevealed = wasRevealed
          || (this._sonarFired && this._sonarAge >= this._activeRevealStart[i]);

        if (nowRevealed && !wasRevealed) {
          this._activeRevealed[i] = 1;
          if (!isNode) {
            this.decoyMesh.setColorAt(slot, _RED_COL);
            this._colorDirty = true;
          }
        }

        if (nowRevealed) {
          // ── Sonar-revealed: always solid + glow, overrides quantum ────────
          _pos.set(this._activeX[i], PLATFORM_Y, this._activeZ[i]);
          _scale.set(1, 1, zScale);
          _m4.compose(_pos, _quat, _scale);
          solidMesh.setMatrixAt(slot, _m4);

          _m4.makeScale(0, 0, 0);
          wireMesh.setMatrixAt(slot, _m4);

          _pos.set(this._activeX[i], PLATFORM_Y, this._activeZ[i]);
          _scale.set(1.12, 1.2, zScale * 1.06);
          _m4.compose(_pos, _quat, _scale);
          glowMesh.setMatrixAt(slot, _m4);

        } else if (quantumActive) {
          // ── Quantum / scribble mode ───────────────────────────────────────
          const jitter = qs * 0.3;

          // Layer 1: wireMesh — chaotically scaled dense wireframe
          const px1 = this._activeX[i] + Math.sin(qt * 5.0 + slot * 1.7) * jitter;
          const pz1 = this._activeZ[i] + Math.cos(qt * 3.7 + slot * 2.1) * jitter * 0.5;
          const sx1 = 1.0 + Math.sin(qt * 13.0 + slot * 1.1) * 0.65 * qs;
          const sy1 = 1.0 + Math.sin(qt * 8.7 + slot * 2.3) * 0.75 * qs;
          _pos.set(px1, PLATFORM_Y, pz1);
          _scale.set(sx1, sy1, zScale);
          _m4.compose(_pos, _quat, _scale);
          wireMesh.setMatrixAt(slot, _m4);

          // Layer 2: scribbleMesh — different phase, different position offset
          const px2 = this._activeX[i] + Math.cos(qt * 9.2 + slot * 2.7) * jitter;
          const pz2 = this._activeZ[i] + Math.sin(qt * 5.1 + slot * 0.9) * jitter * 0.5;
          const sx2 = 1.0 + Math.cos(qt * 7.3 + slot * 2.7) * 0.6 * qs;
          const sy2 = 1.0 + Math.cos(qt * 11.5 + slot * 0.8) * 0.7 * qs;
          _pos.set(px2, PLATFORM_Y, pz2);
          _scale.set(sx2, sy2, zScale);
          _m4.compose(_pos, _quat, _scale);
          this.scribbleMesh.setMatrixAt(scrSlot, _m4);
          scrSlot++;

          // Hide solid and glow
          _m4.makeScale(0, 0, 0);
          solidMesh.setMatrixAt(slot, _m4);
          glowMesh.setMatrixAt(slot, _m4);

          // ── Ghost platforms on adjacent lanes (corruption > 50%) ──────────
          if (qc > 0.5 && gSlot < GHOST_POOL) {
            const ghostIntensity = Math.min(1, (qc - 0.5) * 4);
            const baseLaneIdx = Math.round(this._activeX[i] / LANE_SPACING) + 1;
            const shift1 = Math.sin(qt * 0.8 + i * 1.3) > 0 ? 1 : 2;
            const lane1 = (baseLaneIdx + shift1) % 3;

            const g1sx = 1.0 + Math.sin(qt * 11.0 + gSlot * 1.7) * 0.5;
            const g1sy = 1.0 + Math.sin(qt * 7.3 + gSlot * 2.5) * 0.6;
            const g1py = PLATFORM_Y + Math.sin(qt * 4.1 + gSlot * 1.9) * ghostIntensity * 0.3;
            _pos.set(LANE_X[lane1], g1py, pz1);
            _scale.set(g1sx, g1sy, zScale);
            _m4.compose(_pos, _quat, _scale);
            this.ghostMesh.setMatrixAt(gSlot++, _m4);

            if (qc > 0.75 && gSlot < GHOST_POOL) {
              const shift2 = shift1 === 1 ? 2 : 1;
              const lane2 = (baseLaneIdx + shift2) % 3;
              const g2sx = 1.0 + Math.cos(qt * 9.2 + gSlot * 1.3) * 0.45;
              const g2sy = 1.0 + Math.cos(qt * 6.5 + gSlot * 2.1) * 0.6;
              const g2py = PLATFORM_Y + Math.cos(qt * 5.3 + gSlot * 2.7) * 0.3;
              _pos.set(LANE_X[lane2], g2py, pz2);
              _scale.set(g2sx, g2sy, zScale);
              _m4.compose(_pos, _quat, _scale);
              this.ghostMesh.setMatrixAt(gSlot++, _m4);
            }
          }

        } else {
          // ── Normal mode (grounded) ────────────────────────────────────────
          _pos.set(this._activeX[i], PLATFORM_Y, this._activeZ[i]);
          _scale.set(1, 1, zScale);
          _m4.compose(_pos, _quat, _scale);

          // Not revealed: check landing transition (wireframe → solid flicker)
          _m4.makeScale(0, 0, 0);
          glowMesh.setMatrixAt(slot, _m4);

          const elapsed = qt - this._activeLandTime[i];
          if (elapsed < LAND_DUR) {
            const flickerRate = 28 * (1.0 - elapsed / LAND_DUR);
            if (Math.sin(qt * flickerRate + slot * 0.8) > 0.0) {
              // Wire phase of flicker
              _pos.set(this._activeX[i], PLATFORM_Y, this._activeZ[i]);
              _scale.set(1, 1, zScale);
              _m4.compose(_pos, _quat, _scale);
              wireMesh.setMatrixAt(slot, _m4);
              _m4.makeScale(0, 0, 0);
              solidMesh.setMatrixAt(slot, _m4);
            } else {
              // Solid phase of flicker
              _pos.set(this._activeX[i], PLATFORM_Y, this._activeZ[i]);
              _scale.set(1, 1, zScale);
              _m4.compose(_pos, _quat, _scale);
              solidMesh.setMatrixAt(slot, _m4);
              _m4.makeScale(0, 0, 0);
              wireMesh.setMatrixAt(slot, _m4);
            }
          } else {
            // Fully resolved: solid only
            _pos.set(this._activeX[i], PLATFORM_Y, this._activeZ[i]);
            _scale.set(1, 1, zScale);
            _m4.compose(_pos, _quat, _scale);
            solidMesh.setMatrixAt(slot, _m4);
            _m4.makeScale(0, 0, 0);
            wireMesh.setMatrixAt(slot, _m4);
          }
        }

        i++;
      }
    }

    // Zero out stale scribble slots from previous frame
    _m4.makeScale(0, 0, 0);
    for (let j = scrSlot; j < this._scribbleCount; j++) {
      this.scribbleMesh.setMatrixAt(j, _m4);
    }
    this._scribbleCount = scrSlot;

    // Zero out unused ghost slots
    while (gSlot < GHOST_POOL) this.ghostMesh.setMatrixAt(gSlot++, _m4);

    this.nodeMesh.instanceMatrix.needsUpdate = true;
    this.decoyMesh.instanceMatrix.needsUpdate = true;
    this.nodeWireMesh.instanceMatrix.needsUpdate = true;
    this.decoyWireMesh.instanceMatrix.needsUpdate = true;
    this.scribbleMesh.instanceMatrix.needsUpdate = true;
    this.ghostMesh.instanceMatrix.needsUpdate = true;
    this.nodeGlowMesh.instanceMatrix.needsUpdate = true;
    this.decoyGlowMesh.instanceMatrix.needsUpdate = true;

    if (this._colorDirty && this.decoyMesh.instanceColor) {
      this.decoyMesh.instanceColor.needsUpdate = true;
      this._colorDirty = false;
    }
  }

  getPlatformUnderPlayer(playerX) {
    const halfSpacing = LANE_SPACING * 0.5;
    for (let i = 0; i < this._activeLen; i++) {
      if (Math.abs(this._activeX[i] - playerX) >= halfSpacing) continue;
      if (this._activeZStart[i] > 0) continue;
      if (this._activeZEnd[i] < 0) continue;
      return i;
    }
    return -1;
  }

  _releaseAt(ai) {
    const slot = this._activeIdx[ai];
    const isNode = this._activeType[ai] === 0;

    _m4.makeScale(0, 0, 0);
    (isNode ? this.nodeMesh : this.decoyMesh).setMatrixAt(slot, _m4);
    (isNode ? this.nodeWireMesh : this.decoyWireMesh).setMatrixAt(slot, _m4);
    (isNode ? this.nodeGlowMesh : this.decoyGlowMesh).setMatrixAt(slot, _m4);

    if (!isNode) {
      this.decoyMesh.setColorAt(slot, _WHITE_COL);
      this._colorDirty = true;
    }

    if (isNode) this._nodeFree[this._nodeFreeLen++] = slot;
    else this._decoyFree[this._decoyFreeLen++] = slot;
  }

  get activeCount() { return this._activeLen; }
}
