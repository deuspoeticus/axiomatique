const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform float u_time;
  uniform float u_pingTime;
  uniform float u_floating;     // 0.0 = grounded, 1.0 = fully hovering (smooth)
  uniform float u_corruption;   // 0.0 → 1.0
  uniform vec2  u_resolution;
  uniform float u_failureTime;  // u_time value at last failure event
  uniform float u_failureType;  // 0=none, 1=void fall, 2=decoy land
  uniform float u_whiteout;     // 1.0 = single white flash frame
  uniform float u_deathTime;    // u_time at kernel panic; -1 = alive

  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;

    // ── Failure event pre-compute ─────────────────────────────────────────────
    float failureAge  = u_time - u_failureTime;
    float isVoidFall  = step(0.5, u_failureType) * step(u_failureType, 1.5);
    float isDecoy     = step(1.5, u_failureType);
    float decayTime   = isVoidFall * 0.65 + isDecoy * 0.42 + (1.0 - isVoidFall - isDecoy) * 0.01;
    float failureIntensity = max(0.0, 1.0 - failureAge / decayTime);

    // ── Pre-compute sonar geometry (shared by distortion + ring draw) ─────────
    float pingAge = u_time - u_pingTime;
    float aspect  = u_resolution.x / u_resolution.y;
    vec2  aUV     = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
    float dist    = length(aUV);
    vec2  radial  = dist > 0.001 ? normalize(aUV) / vec2(aspect, 1.0) : vec2(0.0);
    float fade    = clamp(1.0 - pingAge / 1.4, 0.0, 1.0);

    // ── 5. Ripple: UV compression wave trailing just behind the ring ──────────
    // Warp strength grows with corruption — scanner destabilizes as system degrades.
    vec2 distUV = uv;
    if (pingAge > 0.0 && pingAge < 1.5) {
      float trail    = dist - (pingAge * 0.42 - 0.05);
      float ripple   = smoothstep(0.07, 0.0, abs(trail)) * fade;
      float warpAmt  = mix(0.010, 0.048, u_corruption);
      distUV        += radial * ripple * sign(trail) * warpAmt;
    }

    // ── Screen tear: void fall only — horizontal band displacement for 0.18s ──
    if (isVoidFall > 0.5 && failureAge < 0.18) {
      float tearT      = 1.0 - failureAge / 0.18;
      float tearNoise  = fract(sin(floor(uv.y * 36.0) * 91.3 + u_time * 220.0) * 43758.5);
      distUV.x        += (tearNoise - 0.5) * 0.045 * tearT;
    }

    // ── Chromatic aberration (sampled on distorted UV) ───────────────────────
    float failureAberr = isVoidFall * failureIntensity * 0.14
                       + isDecoy   * failureIntensity * 0.07;
    float aberr = 0.002 + u_corruption * 0.010 + failureAberr;
    float r = texture2D(tDiffuse, distUV + vec2( aberr, 0.0)).r;
    float g = texture2D(tDiffuse, distUV                    ).g;
    float b = texture2D(tDiffuse, distUV - vec2( aberr, 0.0)).b;
    vec4 col = vec4(r, g, b, 1.0);

    // ── Saturation boost ─────────────────────────────────────────────────────
    // Lambert shading washes out saturated colors on shadowed faces (red loses
    // all G/B, becomes near-black). Pulling colors 30% away from their luma
    // midpoint restores vibrancy without touching material or light values.
    // Neutral grays are unaffected (luma == all channels → no change).
    float satLuma = dot(col.rgb, vec3(0.299, 0.587, 0.114));
    col.rgb = mix(vec3(satLuma), col.rgb, 1.30);

    // ── Contrast ─────────────────────────────────────────────────────────────
    // Pushes darks down and brights up symmetrically around 0.5.
    col.rgb = (col.rgb - 0.5) * 1.14 + 0.5;

    // ── Single-pass fake bloom ────────────────────────────────────────────────
    // Samples four diagonal neighbours from tDiffuse, extracts only the bright
    // portion (smoothstep threshold), and adds it back as a soft halo.
    // Bright objects (white platforms, player) glow; dark areas are untouched.
    float bRad = 0.006;
    vec3 blur4 = (
      texture2D(tDiffuse, distUV + vec2( bRad,  bRad)).rgb +
      texture2D(tDiffuse, distUV + vec2(-bRad,  bRad)).rgb +
      texture2D(tDiffuse, distUV + vec2( bRad, -bRad)).rgb +
      texture2D(tDiffuse, distUV + vec2(-bRad, -bRad)).rgb
    ) * 0.25;
    float bloomLuma = dot(blur4, vec3(0.299, 0.587, 0.114));
    col.rgb += blur4 * smoothstep(0.40, 0.82, bloomLuma) * 0.20;

    // ── Scanlines ────────────────────────────────────────────────────────────
    // Amplitude 0.06: visible as faint light bands on the dark scene AND as
    // dark stripes on the inverted (light) scene — consistent CRT texture in both modes.
    col.rgb -= sin(uv.y * u_resolution.y * 2.0) * 0.060;

    // ── Failure scanline burst ────────────────────────────────────────────────
    float lineWindow = isVoidFall * 0.50 + isDecoy * 0.38;
    if (failureAge < lineWindow && failureAge >= 0.0 && lineWindow > 0.0) {
      float lineDensity = isVoidFall * 130.0 + isDecoy * 70.0;
      float scanBurst   = step(0.82, fract(uv.y * lineDensity + u_time * 100.0));
      col.r  += scanBurst * failureIntensity * 0.70;
      col.gb -= scanBurst * failureIntensity * 0.40;
    }

    // ── Hover inversion ───────────────────────────────────────────────────────
    // u_floating: 0 = grounded (dark bg), 0.5 = fully hovering (light bg).
    // invertT reaches 1.0 at hover → full RGB complement flip of the scene.
    // Applied BEFORE sonar ring so the ring stays in its own color space
    // on top of the inverted scene.
    float invertT = clamp(u_floating * 2.0, 0.0, 1.0);
    col.rgb = mix(col.rgb, vec3(1.0) - col.rgb, invertT);

    // ── Sonar ring ───────────────────────────────────────────────────────────
    if (pingAge > 0.0 && pingAge < 1.4) {
      float wave = abs(dist - pingAge * 0.42);

      // Grounded: white→red ring (additive on dark bg).
      // Hovering (inverted): red→black ring (subtractive on white bg) so it stays visible.
      // ringSign flips blend direction: +1 = brighten, -1 = darken.
      float ringSign   = mix(1.0, -1.0, invertT);
      vec3  ringCol    = mix(vec3(1.0, 1.0, 0.2), vec3(1.0), 1.0 - pingAge / 1.4);
      // In hover mode use accent red (visible on white); grounded keeps overbright white.
      vec3  ringColAdj = mix(ringCol, vec3(1.0, 0.0, 0.2), invertT);
      float brightness = mix(2.4, 1.0, pingAge / 1.4);

      // Glow halo
      float glow = smoothstep(0.11, 0.0, wave) * fade * 0.55;
      col.rgb   += glow * ringColAdj * brightness * ringSign;

      // Sharp ring
      float ring = smoothstep(0.018, 0.0, wave) * fade;
      col.rgb   += ring * brightness * ringColAdj * ringSign;

      // Echo: dimmer ghost ring trailing ~0.08s behind
      float echoAge = pingAge - 0.08;
      if (echoAge > 0.0) {
        float echoFade = clamp(1.0 - echoAge / 1.4, 0.0, 1.0);
        float echoWave = abs(dist - echoAge * 0.42);
        float echoGlow = smoothstep(0.09, 0.0, echoWave) * echoFade * 0.20;
        float echo     = smoothstep(0.018, 0.0, echoWave) * echoFade * 0.35;
        col.rgb       += (echoGlow + echo) * ringColAdj * ringSign;
      }
    }

    // ── Vignette — darkens screen edges in both modes ────────────────────────
    // Grounded (invertT=0): full standard vignette (dark edges on dark bg).
    // Hover (invertT=1): half-strength vignette (inverted scene is already light;
    // too-strong darkening would fight the inversion).
    float vig    = 1.0 - smoothstep(0.32, 0.90, length(uv - vec2(0.5)));
    float vigStr = mix(1.0, 0.5, invertT);   // full strength grounded, half in hover
    col.rgb     *= mix(1.0, vig, vigStr);

    // ── Failure red-edge vignette ─────────────────────────────────────────────
    float edgeDist  = length(uv - vec2(0.5)) * 2.0;
    float failVig   = smoothstep(0.3, 1.0, edgeDist) * failureIntensity;
    col.r  += failVig * (isVoidFall * 0.90 + isDecoy * 0.55);
    col.gb -= failVig * (isVoidFall * 0.30 + isDecoy * 0.18);

    // ── Corruption glitch lines ───────────────────────────────────────────────
    if (u_corruption > 0.25) {
      float glitch = step(
        0.994 - u_corruption * 0.012,
        fract(sin(floor(uv.y * u_resolution.y) * 127.1 + u_time * 43.7) * 43758.5)
      );
      col.r  += glitch * u_corruption * 0.6;
      col.gb -= glitch * u_corruption * 0.2;
    }

    // ── Kernel panic death screen ─────────────────────────────────────────────
    if (u_deathTime > 0.0) {
      float deadAge   = u_time - u_deathTime;
      float pulse     = sin(deadAge * 6.3) * 0.5 + 0.5;
      float fastPulse = sin(deadAge * 17.0) * 0.5 + 0.5;

      // Strobing scanline noise — denser and more aggressive than corruption glitch
      float scanY    = floor(uv.y * u_resolution.y * 0.5);
      float noiseLine = step(0.78 - pulse * 0.08,
        fract(sin(scanY * 91.3 + u_time * 44.0) * 43758.5));
      col.r  += noiseLine * 0.65 * (0.4 + 0.6 * pulse);
      col.gb -= noiseLine * 0.22;

      // Block glitch: random horizontal strips get channel-swapped
      float blockRow   = floor(uv.y * 18.0);
      float blockT     = floor(u_time * 7.0);
      float blockNoise = fract(sin(blockRow * 127.1 + blockT * 91.3) * 43758.5);
      if (blockNoise > 0.88) {
        col.rgb = col.brg;
      }

      // Pulsing red edge burn
      float edgeDead = smoothstep(0.20, 0.85, length(uv - vec2(0.5)) * 2.0);
      float burnAmt  = 0.22 + 0.14 * sin(deadAge * 4.1);
      col.r  += edgeDead * burnAmt;
      col.gb -= edgeDead * burnAmt * 0.55;

      // Channel smear
      float smearR = col.r;
      col.r = mix(col.r, col.g, 0.12 * fastPulse);
      col.b = mix(col.b, smearR,  0.10 * (1.0 - fastPulse));
    }

    vec4 finalCol = clamp(col, 0.0, 1.0);
    gl_FragColor  = u_whiteout > 0.5 ? vec4(1.0) : finalCol;
  }
`;

export const PostShader = {
  uniforms: {
    tDiffuse:      { value: null },
    u_time:        { value: 0.0 },
    u_pingTime:    { value: -100.0 },
    u_floating:    { value: 0.0 },
    u_corruption:  { value: 0.0 },
    u_resolution:  { value: null },
    u_failureTime: { value: -100.0 }, // u_time at last failure; -100 = inactive
    u_failureType: { value: 0.0 },    // 0=none, 1=void fall, 2=decoy land
    u_whiteout:    { value: 0.0 },    // 1=flash white this frame, auto-cleared next frame
    u_deathTime:   { value: -1.0 },   // u_time at kernel panic; -1 = alive
  },
  vertexShader,
  fragmentShader,
};
