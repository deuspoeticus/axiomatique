import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass }     from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { PostShader }     from './shaders/PostShader.js';
import { CAM_POS, CAM_FRUSTUM, PALETTE, PLAYER_POS } from '../constants.js';

export function createRenderer() {
  const canvas = document.getElementById('c');

  // ── WebGL renderer ──────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // ── Scene ───────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.VOID);

  // ── Isometric face shading — gives platforms and player 3D depth ─────────
  // Hemisphere: sky bright, ground dark charcoal → top faces lit, bottom faces dim.
  const hemi = new THREE.HemisphereLight(0xffffff, 0x252525, 0.75);
  scene.add(hemi);
  // Directional from upper-right-front (aligns with isometric sun angle):
  // illuminates top face strongly, right/front face partially, left/back not at all.
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(2, 4, 2);
  scene.add(sun);

  // ── Isometric orthographic camera ───────────────────────────────────────────
  const aspect = window.innerWidth / window.innerHeight;
  const f = CAM_FRUSTUM;
  const camera = new THREE.OrthographicCamera(
    -f * aspect, f * aspect, f, -f, 0.1, 200
  );
  camera.position.set(CAM_POS.x, CAM_POS.y, CAM_POS.z);
  camera.lookAt(PLAYER_POS.x, PLAYER_POS.y, PLAYER_POS.z);

  // ── Post-processing chain: RenderPass → ShaderPass(PostShader) ──────────────
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const postPass = new ShaderPass(PostShader);
  postPass.renderToScreen = true;
  composer.addPass(postPass);

  const uniforms = postPass.uniforms;
  uniforms.u_resolution.value = new THREE.Vector2(window.innerWidth, window.innerHeight);

  // ── Resize handler ──────────────────────────────────────────────────────────
  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const a = w / h;
    camera.left   = -f * a;
    camera.right  =  f * a;
    camera.top    =  f;
    camera.bottom = -f;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    uniforms.u_resolution.value.set(w, h);
  }
  window.addEventListener('resize', onResize);

  return { renderer, scene, camera, composer, uniforms };
}
