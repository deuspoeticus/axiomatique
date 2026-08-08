import * as THREE from 'three';
import { ACTIVE_LANES, LANE_SPACING, PLATFORM_TOP } from '../constants.js';

// Subtle runway lines — one per lane, spanning the full visible Z range.
// Static geometry, added once, never updated in rAF.
const GUIDE_Y    = PLATFORM_TOP + 0.02; // just above platform surface
const GUIDE_Z_FAR  = -110;              // beyond spawn zone
const GUIDE_Z_NEAR =   12;              // just past recycle threshold

export class LaneGuides {
  constructor(scene) {
    const mat = new THREE.LineBasicMaterial({
      color: 0x888888,
      transparent: true,
      opacity: 0.75,
    });

    for (const lane of ACTIVE_LANES) {
      const x = lane * LANE_SPACING;
      const verts = new Float32Array([
        x, GUIDE_Y, GUIDE_Z_FAR,
        x, GUIDE_Y, GUIDE_Z_NEAR,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      scene.add(new THREE.Line(geo, mat));
    }
  }
}
