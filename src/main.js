import { createRenderer }  from './engine/Renderer.js';
import { TrackEngine }     from './track/TrackEngine.js';
import { LaneGuides }      from './track/LaneGuides.js';
import { Synth }           from './audio/Synth.js';
import { Compass }         from './ui/Compass.js';
import { Player }          from './game/Player.js';
import { PhaseManager }    from './game/PhaseManager.js';
import { GameLoop }        from './game/GameLoop.js';

// ── Bootstrap ──────────────────────────────────────────────────────────────
const renderCtx    = createRenderer();
new LaneGuides(renderCtx.scene);
const synth        = new Synth();
const trackEngine  = new TrackEngine(renderCtx.scene, synth);
const compass      = new Compass();
const player       = new Player(renderCtx.scene, renderCtx.uniforms, synth);
const phaseManager = new PhaseManager();
const loop         = new GameLoop(renderCtx, trackEngine, synth, compass, player, phaseManager);

// Wire synth → track engine FFT buffer after construction
trackEngine.linkSynth(synth);

// ── Show paused scene immediately — AudioContext boot gate on first gesture ──
const bootEl = document.getElementById('boot');
let started  = false;

loop.startPaused();

function boot() {
  if (started) return;
  started = true;
  bootEl.style.display = 'none';
  synth.init();
  loop.resume();
}

if (sessionStorage.getItem('autoboot')) {
  sessionStorage.removeItem('autoboot');
  boot();
} else {
  window.addEventListener('keydown', boot, { once: true });
  window.addEventListener('pointerdown', boot, { once: true });
}
