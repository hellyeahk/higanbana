(() => {
  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d', { alpha: false });

  let width = 0;
  let height = 0;
  let dpr = 1;
  let sceneScale = 1;

  // Offscreen cached canvases for locked 60 FPS rendering (zero per-frame radial gradients / shadowBlur)
  let bgCanvas = null;
  let crownAuraSprite = null;
  let antherGlowSprite = null;
  let emberGlowSprite = null;

  // Spring-damped breeze physics driven by pointer/touch waves + nocturnal air currents
  const breeze = {
    targetX: 0,
    targetY: 0,
    posX: 0,
    posY: 0,
    velX: 0,
    velY: 0,
    waveBoost: 0,
    lastPointerX: null,
    lastPointerY: null
  };

  const startTime = performance.now();
  let stems = [];
  let grassBlades = [];
  let embers = [];

  // ============================================================================
  // MATH, EASING & C1-CONTINUOUS QUADRATIC MIDPOINT SPLINES
  // ============================================================================
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (edge0, edge1, x) => {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const easeInOutSine = (t) => -(Math.cos(Math.PI * clamp(t, 0, 1)) - 1) / 2;

  function cubicBezier(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const a = mt2 * mt;
    const b = 3 * mt2 * t;
    const c = 3 * mt * t2;
    const d = t2 * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    };
  }

  /**
   * Traces a C1-continuous quadratic midpoint spline through `points`.
   * Guarantees smooth organic curvature with zero jagged polygon joints.
   */
  function traceSmoothSpline(targetCtx, points, moveFirst = true) {
    const len = points.length;
    if (len === 0) return;

    if (moveFirst) {
      targetCtx.moveTo(points[0].x, points[0].y);
    } else {
      targetCtx.lineTo(points[0].x, points[0].y);
    }

    if (len === 1) return;
    if (len === 2) {
      targetCtx.lineTo(points[1].x, points[1].y);
      return;
    }

    for (let i = 1; i < len - 1; i++) {
      const midX = (points[i].x + points[i + 1].x) * 0.5;
      const midY = (points[i].y + points[i + 1].y) * 0.5;
      targetCtx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }

    const last = points[len - 1];
    targetCtx.lineTo(last.x, last.y);
  }

  function seededRandom(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  // ============================================================================
  // 3D VECTOR HELPERS & PERSPECTIVE PROJECTION
  // ============================================================================
  function cross3(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  }

  function normalize3(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }

  function rotateCrown3D(x, y, z, yaw, pitch, roll) {
    // Roll around Z (stem lean)
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const x1 = x * cr - y * sr;
    const y1 = x * sr + y * cr;
    const z1 = z;

    // Pitch around X (viewing tilt into the radial umbel ring)
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x2 = x1;
    const y2 = y1 * cp - z1 * sp;
    const z2 = y1 * sp + z1 * cp;

    // Yaw around Y
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const x3 = x2 * cy + z2 * sy;
    const y3 = y2;
    const z3 = -x2 * sy + z2 * cy;

    return { x: x3, y: y3, z: z3 };
  }

  function project3D(p, originX, originY, fov = 860) {
    const zOffset = fov + p.z;
    const scale = fov / Math.max(180, zOffset);
    return {
      x: originX + p.x * scale,
      y: originY + p.y * scale,
      z: p.z,
      scale
    };
  }

  // ============================================================================
  // OFFSCREEN SPRITE & TWILIGHT BACKGROUND CACHING (60 FPS OPTIMIZATION)
  // ============================================================================
  function buildGlowSprites() {
    // 1. Crimson-magenta umbel crown aura halo (256x256)
    crownAuraSprite = document.createElement('canvas');
    crownAuraSprite.width = 256;
    crownAuraSprite.height = 256;
    const cCtx = crownAuraSprite.getContext('2d');
    const cGrad = cCtx.createRadialGradient(128, 128, 4, 128, 128, 128);
    cGrad.addColorStop(0.0, 'rgba(255, 42, 85, 0.34)');
    cGrad.addColorStop(0.38, 'rgba(220, 20, 60, 0.16)');
    cGrad.addColorStop(0.72, 'rgba(136, 19, 55, 0.05)');
    cGrad.addColorStop(1.0, 'rgba(136, 19, 55, 0)');
    cCtx.fillStyle = cGrad;
    cCtx.fillRect(0, 0, 256, 256);

    // 2. Golden-amber anther glow sprite (64x64)
    antherGlowSprite = document.createElement('canvas');
    antherGlowSprite.width = 64;
    antherGlowSprite.height = 64;
    const aCtx = antherGlowSprite.getContext('2d');
    const aGrad = aCtx.createRadialGradient(32, 32, 1, 32, 32, 32);
    aGrad.addColorStop(0.0, 'rgba(254, 240, 138, 0.95)');
    aGrad.addColorStop(0.32, 'rgba(245, 158, 11, 0.48)');
    aGrad.addColorStop(0.68, 'rgba(220, 38, 38, 0.12)');
    aGrad.addColorStop(1.0, 'rgba(220, 38, 38, 0)');
    aCtx.fillStyle = aGrad;
    aCtx.fillRect(0, 0, 64, 64);

    // 3. Floating golden-crimson ember sprite (64x64)
    emberGlowSprite = document.createElement('canvas');
    emberGlowSprite.width = 64;
    emberGlowSprite.height = 64;
    const eCtx = emberGlowSprite.getContext('2d');
    const eGrad = eCtx.createRadialGradient(32, 32, 1, 32, 32, 32);
    eGrad.addColorStop(0.0, 'rgba(255, 232, 163, 0.95)');
    eGrad.addColorStop(0.35, 'rgba(255, 92, 115, 0.45)');
    eGrad.addColorStop(0.72, 'rgba(190, 18, 60, 0.12)');
    eGrad.addColorStop(1.0, 'rgba(190, 18, 60, 0)');
    eCtx.fillStyle = eGrad;
    eCtx.fillRect(0, 0, 64, 64);
  }

  function buildCachedBackground() {
    bgCanvas = document.createElement('canvas');
    bgCanvas.width = Math.max(1, Math.round(width));
    bgCanvas.height = Math.max(1, Math.round(height));
    const bCtx = bgCanvas.getContext('2d');

    // Deep midnight-indigo to ruby-plum twilight gradient
    const cx = width * 0.5;
    const cy = height * 0.62;
    const maxR = Math.max(width, height) * 0.95;
    const skyGrad = bCtx.createRadialGradient(cx, cy, 10, cx, cy, maxR);
    skyGrad.addColorStop(0.0, '#260e28');
    skyGrad.addColorStop(0.42, '#140924');
    skyGrad.addColorStop(0.78, '#0b0618');
    skyGrad.addColorStop(1.0, '#05030b');
    bCtx.fillStyle = skyGrad;
    bCtx.fillRect(0, 0, width, height);

    // Subtle lower horizon crimson-plum mist
    const mistGrad = bCtx.createLinearGradient(0, height * 0.55, 0, height);
    mistGrad.addColorStop(0.0, 'rgba(107, 5, 24, 0)');
    mistGrad.addColorStop(0.65, 'rgba(88, 12, 36, 0.16)');
    mistGrad.addColorStop(1.0, 'rgba(14, 24, 20, 0.48)');
    bCtx.fillStyle = mistGrad;
    bCtx.fillRect(0, height * 0.55, width, height * 0.45);

    // Soft static out-of-focus nocturnal bokeh circles
    const rand = seededRandom(8842);
    const bokehColors = [
      'rgba(225, 29, 72, 0.055)',
      'rgba(168, 85, 247, 0.045)',
      'rgba(251, 146, 60, 0.04)',
      'rgba(190, 24, 93, 0.05)'
    ];
    bCtx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 22; i++) {
      const bx = rand() * width;
      const by = (0.08 + rand() * 0.78) * height;
      const br = (34 + rand() * 86) * sceneScale;
      const col = bokehColors[i % bokehColors.length];
      const g = bCtx.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0.0, col);
      g.addColorStop(0.65, col);
      g.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      bCtx.fillStyle = g;
      bCtx.beginPath();
      bCtx.arc(bx, by, br, 0, Math.PI * 2);
      bCtx.fill();
    }
    bCtx.globalCompositeOperation = 'source-over';
  }

  // ============================================================================
  // BOTANICAL UMBEL CROWN & SCAPE INITIALIZATION
  // ============================================================================
  function createUmbelCrown(seed, scale, floretCount, budCount, yaw, tiltPitch) {
    const rand = seededRandom(seed);
    const florets = [];
    const baseAz = rand() * Math.PI * 2;

    // 5 to 7 outward-radiating florets arranged around a 360-degree horizontal ring
    for (let i = 0; i < floretCount; i++) {
      const azimuth = baseAz + (i / floretCount) * Math.PI * 2 + (rand() - 0.5) * 0.24;
      // Outward elevation near horizontal (-0.16 to +0.20 rad) so florets radiate sideways, never straight up
      const elevation = lerp(-0.15, 0.20, rand());
      const pedicelLen = (26 + rand() * 10) * scale;
      const tepalLen = (48 + rand() * 10) * scale;
      const tepalWidth = (8.2 + rand() * 1.8) * scale;
      const stamenLen = tepalLen * (2.15 + rand() * 0.25);
      const twist = (rand() - 0.5) * 0.45;
      const flutterPhase = rand() * Math.PI * 2;
      const flutterFreq = 1.9 + rand() * 1.1;

      florets.push({
        azimuth,
        elevation,
        pedicelLen,
        tepalLen,
        tepalWidth,
        stamenLen,
        twist,
        flutterPhase,
        flutterFreq,
        seed: seed + i * 31
      });
    }

    // 1 or 2 slender crimson buds angled outward in upper gaps of the umbel
    const buds = [];
    for (let b = 0; b < budCount; b++) {
      const azimuth = baseAz + (b + 0.5) * (Math.PI * 2 / Math.max(2, budCount)) + (rand() - 0.5) * 0.5;
      const elevation = 0.58 + rand() * 0.28; // angled outward-upward ~35-50 deg from horizontal
      buds.push({
        azimuth,
        elevation,
        pedicelLen: (22 + rand() * 8) * scale,
        budLen: (32 + rand() * 7) * scale,
        budRad: (4.6 + rand() * 1.0) * scale,
        phase: rand() * Math.PI * 2
      });
    }

    return {
      scale,
      yaw,
      tiltPitch,
      bloomDelay: 1.0,
      bloomDuration: 2.3,
      florets,
      buds
    };
  }

  function createScapeStem(opts) {
    return {
      id: opts.id,
      zOrder: opts.zOrder,
      // S-curve cubic Bezier offsets relative to bottom center (anchorX, anchorY)
      p0: opts.p0,
      p1: opts.p1,
      p2: opts.p2,
      p3: opts.p3,
      thickness: opts.thickness,
      growDelay: opts.growDelay,
      growDuration: opts.growDuration,
      swayPhase: opts.swayPhase,
      swayAmp: opts.swayAmp,
      crown: opts.crown
    };
  }

  function initMeadow() {
    // Layered cluster of gracefully S-curved Higanbana scapes (foreground & background depths)
    stems = [
      // 1. Background Left Tall Arching Scape
      createScapeStem({
        id: 'bg-left',
        zOrder: 1,
        p0: { x: -46, y: 18 },
        p1: { x: -115, y: -145 },
        p2: { x: -42, y: -310 },
        p3: { x: -96, y: -445 },
        thickness: 5.4,
        growDelay: 0.05,
        growDuration: 1.95,
        swayPhase: 0.4,
        swayAmp: 14,
        crown: Object.assign(
          createUmbelCrown(1101, 0.86, 6, 2, 0.22, 0.28),
          { bloomDelay: 1.25, bloomDuration: 2.35 }
        )
      }),
      // 2. Background Right Tall S-Curved Scape
      createScapeStem({
        id: 'bg-right',
        zOrder: 1,
        p0: { x: 52, y: 18 },
        p1: { x: 124, y: -155 },
        p2: { x: 48, y: -325 },
        p3: { x: 108, y: -462 },
        thickness: 5.4,
        growDelay: 0.14,
        growDuration: 2.0,
        swayPhase: 2.1,
        swayAmp: 15,
        crown: Object.assign(
          createUmbelCrown(2202, 0.88, 6, 1, -0.25, 0.30),
          { bloomDelay: 1.35, bloomDuration: 2.35 }
        )
      }),
      // 3. Midground Center-Left Graceful Sweeping Scape
      createScapeStem({
        id: 'mid-left',
        zOrder: 2,
        p0: { x: -18, y: 18 },
        p1: { x: 38, y: -125 },
        p2: { x: -78, y: -255 },
        p3: { x: -34, y: -368 },
        thickness: 6.2,
        growDelay: 0.22,
        growDuration: 1.85,
        swayPhase: 3.6,
        swayAmp: 12.5,
        crown: Object.assign(
          createUmbelCrown(3303, 0.98, 7, 1, 0.12, 0.26),
          { bloomDelay: 1.15, bloomDuration: 2.25 }
        )
      }),
      // 4. Foreground Right-Leaning Hero Scape
      createScapeStem({
        id: 'fg-right',
        zOrder: 3,
        p0: { x: 24, y: 18 },
        p1: { x: -24, y: -105 },
        p2: { x: 96, y: -210 },
        p3: { x: 64, y: -305 },
        thickness: 6.6,
        growDelay: 0.30,
        growDuration: 1.75,
        swayPhase: 4.9,
        swayAmp: 11.5,
        crown: Object.assign(
          createUmbelCrown(4404, 1.05, 7, 2, -0.18, 0.32),
          { bloomDelay: 1.25, bloomDuration: 2.2 }
        )
      }),
      // 5. Foreground Lower Left Companion Scape
      createScapeStem({
        id: 'fg-lower-left',
        zOrder: 3,
        p0: { x: -72, y: 18 },
        p1: { x: -58, y: -88 },
        p2: { x: -148, y: -176 },
        p3: { x: -126, y: -252 },
        thickness: 6.0,
        growDelay: 0.38,
        growDuration: 1.65,
        swayPhase: 1.3,
        swayAmp: 10.5,
        crown: Object.assign(
          createUmbelCrown(5505, 0.94, 6, 1, 0.30, 0.28),
          { bloomDelay: 1.35, bloomDuration: 2.15 }
        )
      })
    ];

    // Dark nocturnal grass blades along the very bottom edge
    const rand = seededRandom(7719);
    grassBlades = [];
    const bladeCount = 68;
    for (let i = 0; i < bladeCount; i++) {
      const frac = i / (bladeCount - 1);
      grassBlades.push({
        xFrac: frac + (rand() - 0.5) * 0.02,
        height: 28 + rand() * 54,
        width: 2.4 + rand() * 2.6,
        lean: (rand() - 0.5) * 34,
        phase: rand() * Math.PI * 2,
        shade: i % 3 === 0 ? '#071712' : (i % 3 === 1 ? '#0c241b' : '#123326')
      });
    }

    // Floating golden-crimson nocturnal embers
    embers = [];
    for (let i = 0; i < 32; i++) {
      embers.push({
        x: Math.random(),
        y: Math.random(),
        size: 10 + Math.random() * 14,
        speedY: 0.022 + Math.random() * 0.036,
        driftAmp: 16 + Math.random() * 32,
        driftFreq: 0.5 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
        twinkleFreq: 1.4 + Math.random() * 2.2,
        alpha: 0.45 + Math.random() * 0.55
      });
    }
  }

  // ============================================================================
  // RESIZING & HIGH-DPI SETUP
  // ============================================================================
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const scaleX = width / 560;
    const scaleY = height / 640;
    sceneScale = clamp(Math.min(scaleX, scaleY), 0.58, 1.24);

    buildCachedBackground();
  }

  window.addEventListener('resize', resize);

  // ============================================================================
  // INTERACTIVE BREEZE WAVE & TAP/CLICK TO PLANT NEW ARCHING HIGANBANA
  // ============================================================================
  function handlePointerMove(clientX, clientY) {
    const nx = clamp(clientX / Math.max(1, width), 0, 1) - 0.5;
    const ny = clamp(clientY / Math.max(1, height), 0, 1) - 0.5;

    if (breeze.lastPointerX !== null) {
      const dx = (clientX - breeze.lastPointerX) / Math.max(1, width);
      const dy = (clientY - breeze.lastPointerY) / Math.max(1, height);
      breeze.velX += clamp(dx * 165, -34, 34);
      breeze.velY += clamp(dy * 95, -20, 20);
      breeze.waveBoost = clamp(breeze.waveBoost + Math.abs(dx) * 3.2, 0, 1.5);
    }
    breeze.lastPointerX = clientX;
    breeze.lastPointerY = clientY;
    breeze.targetX = nx * 32;
    breeze.targetY = ny * 12;
  }

  window.addEventListener('pointermove', (e) => {
    handlePointerMove(e.clientX, e.clientY);
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length > 0) {
      handlePointerMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener('pointerdown', (e) => {
    handlePointerMove(e.clientX, e.clientY);
    plantHiganbanaAt(e.clientX, e.clientY);
  });

  function plantHiganbanaAt(clientX, clientY) {
    const nowSec = (performance.now() - startTime) / 1000;
    const anchorX = width * 0.5;
    const anchorY = height * 0.985;

    const tipX = (clientX - anchorX) / sceneScale;
    const tipY = clamp((clientY - anchorY) / sceneScale, -500, -180);
    const baseX = clamp(tipX * 0.52 + (Math.random() - 0.5) * 55, -230, 230);
    const sDirection = tipX >= baseX ? 1 : -1;
    const curveAmp = (38 + Math.random() * 44) * sDirection;

    const seed = Math.floor(nowSec * 1000) + Math.floor(clientX);
    const scale = 0.86 + Math.random() * 0.22;
    const florets = 5 + Math.floor(Math.random() * 3); // 5 to 7 florets
    const buds = 1 + (Math.random() > 0.45 ? 1 : 0);

    const newScape = createScapeStem({
      id: 'planted-' + seed,
      zOrder: 2 + (stems.length % 2),
      p0: { x: baseX, y: 18 },
      p1: { x: lerp(baseX, tipX, 0.28) - curveAmp, y: tipY * 0.34 },
      p2: { x: lerp(baseX, tipX, 0.72) + curveAmp * 0.9, y: tipY * 0.70 },
      p3: { x: tipX, y: tipY },
      thickness: 5.8,
      growDelay: nowSec,
      growDuration: 1.65,
      swayPhase: Math.random() * Math.PI * 2,
      swayAmp: 11 + Math.random() * 5,
      crown: Object.assign(
        createUmbelCrown(seed, scale, florets, buds, clamp(-tipX / 480, -0.35, 0.35), 0.28),
        { bloomDelay: nowSec + 0.95, bloomDuration: 2.05 }
      )
    });

    stems.push(newScape);
    if (stems.length > 11) {
      stems.splice(5, 1);
    }
  }

  // ============================================================================
  // STEM WAVE PHYSICS & SMOOTH TAPERED SCAPE RENDERER
  // ============================================================================
  function sampleWaveStemPoints(stem, anchorX, anchorY, maxT, timeSec) {
    const steps = 32;
    const pts = [];
    const b0 = { x: anchorX + stem.p0.x * sceneScale, y: anchorY + stem.p0.y * sceneScale };
    const b1 = { x: anchorX + stem.p1.x * sceneScale, y: anchorY + stem.p1.y * sceneScale };
    const b2 = { x: anchorX + stem.p2.x * sceneScale, y: anchorY + stem.p2.y * sceneScale };
    const b3 = { x: anchorX + stem.p3.x * sceneScale, y: anchorY + stem.p3.y * sceneScale };

    const waveAmp = (stem.swayAmp + breeze.waveBoost * 7.5) * sceneScale;

    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * maxT;
      const basePt = cubicBezier(b0, b1, b2, b3, t);

      // Travelling wind wave along height `t` so upper stem and crown lag and follow through smoothly
      const primaryWave = Math.sin(timeSec * 1.6 - t * 3.1 + stem.swayPhase) * waveAmp * Math.pow(t, 1.6);
      const secondaryWave = Math.sin(timeSec * 0.72 - t * 1.7 + stem.swayPhase * 1.5) * (waveAmp * 0.45) * Math.pow(t, 1.35);
      const pointerWave = breeze.posX * sceneScale * Math.pow(t, 1.55) * (0.88 + 0.18 * Math.sin(timeSec * 2.5 - t * 3.4));
      const verticalBob = (breeze.posY * 0.25 * sceneScale + Math.abs(primaryWave) * 0.08) * Math.pow(t, 1.7);

      pts.push({
        x: basePt.x + primaryWave + secondaryWave + pointerWave,
        y: basePt.y + verticalBob,
        t
      });
    }
    return pts;
  }

  function drawGracefulScape(pts, baseThick, tipThick) {
    const len = pts.length;
    if (len < 2) return;

    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i < len; i++) {
      const pCurr = pts[i];
      const pPrev = pts[Math.max(0, i - 1)];
      const pNext = pts[Math.min(len - 1, i + 1)];
      const dx = pNext.x - pPrev.x;
      const dy = pNext.y - pPrev.y;
      const dLen = Math.hypot(dx, dy) || 1;
      const nx = -dy / dLen;
      const ny = dx / dLen;

      const halfW = lerp(baseThick, tipThick, pCurr.t) * 0.5 * sceneScale;
      leftPts.push({ x: pCurr.x + nx * halfW, y: pCurr.y + ny * halfW });
      rightPts.push({ x: pCurr.x - nx * halfW, y: pCurr.y - ny * halfW });
    }

    const startPt = pts[0];
    const tipPt = pts[len - 1];

    ctx.save();
    ctx.beginPath();
    traceSmoothSpline(ctx, leftPts, true);
    traceSmoothSpline(ctx, rightPts.slice().reverse(), false);
    ctx.closePath();

    // Smooth botanical transition: deep emerald at base -> rich burgundy-crimson at crown
    const grad = ctx.createLinearGradient(startPt.x, startPt.y, tipPt.x, tipPt.y);
    grad.addColorStop(0.0, '#071b10');
    grad.addColorStop(0.45, '#174529');
    grad.addColorStop(0.76, '#58162c');
    grad.addColorStop(1.0, '#881337');

    ctx.fillStyle = grad;
    ctx.fill();

    // Delicate twilight rim highlight along right edge of the scape
    ctx.beginPath();
    traceSmoothSpline(ctx, rightPts, true);
    ctx.strokeStyle = 'rgba(244, 114, 182, 0.22)';
    ctx.lineWidth = Math.max(0.8, 1.05 * sceneScale);
    ctx.stroke();

    ctx.restore();
  }

  // ============================================================================
  // TRANSLUCENT PAPERY SPATHE BRACTS AT THE BRANCHING NODE
  // ============================================================================
  function drawSpatheBracts(nodeX, nodeY, stemLeanAngle, scale, bloomProg) {
    if (bloomProg <= 0.05) return;
    const s = scale * sceneScale;

    ctx.save();
    ctx.translate(nodeX, nodeY);
    ctx.rotate(stemLeanAngle * 0.7);

    for (let side = -1; side <= 1; side += 2) {
      const openTilt = side * lerp(0.18, 0.72, bloomProg);
      const bLen = (24 + (side > 0 ? 3 : 0)) * s;
      const bWid = 4.6 * s;

      ctx.save();
      ctx.rotate(openTilt);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(side * bWid, bLen * 0.45, side * bWid * 0.35, bLen);
      ctx.quadraticCurveTo(-side * bWid * 0.35, bLen * 0.55, 0, 0);
      ctx.closePath();

      ctx.fillStyle = 'rgba(159, 68, 76, 0.52)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(251, 182, 193, 0.32)';
      ctx.lineWidth = 0.8 * s;
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  // ============================================================================
  // OUTWARD-RADIATING 3D UMBEL CROWN (RECURVED RUFFLED TEPALS & J-CURVE STAMENS)
  // ============================================================================
  function drawHiganbanaUmbel(crownX, crownY, stemLeanAngle, crownCfg, bloomProg, timeSec) {
    if (bloomProg <= 0.02) return;

    const cScale = crownCfg.scale * sceneScale * (0.32 + 0.68 * bloomProg);
    const crownRoll = stemLeanAngle * 0.72;
    const crownPitch = crownCfg.tiltPitch + Math.sin(timeSec * 1.15 + crownCfg.yaw * 3) * 0.04;
    const crownYaw = crownCfg.yaw + Math.sin(timeSec * 0.8) * 0.045;

    // 1. Cached additive crimson-magenta halo behind the radial umbel crown
    const auraSize = 310 * cScale * (0.9 + 0.1 * Math.sin(timeSec * 1.6 + crownCfg.yaw));
    if (auraSize > 8 && crownAuraSprite) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = smoothstep(0.05, 0.75, bloomProg);
      ctx.drawImage(
        crownAuraSprite,
        crownX - auraSize * 0.5,
        crownY - auraSize * 0.5,
        auraSize,
        auraSize
      );
      ctx.restore();
    }

    // Draw papery spathe bracts at the apex node
    drawSpatheBracts(crownX, crownY, stemLeanAngle, crownCfg.scale, bloomProg);

    const renderQueue = [];
    const worldUpLocal = { x: 0, y: -1, z: 0 };

    // 2. Build 1 or 2 slender crimson buds angled outward in upper gaps
    for (let b = 0; b < crownCfg.buds.length; b++) {
      const bud = crownCfg.buds[b];
      const az = bud.azimuth + Math.sin(timeSec * 1.1 + bud.phase) * 0.03;
      const el = bud.elevation;
      const cosEl = Math.cos(el);
      const dirLocal = {
        x: Math.cos(az) * cosEl,
        y: -Math.sin(el),
        z: Math.sin(az) * cosEl
      };

      const pLen = bud.pedicelLen * (0.4 + 0.6 * bloomProg) * sceneScale;
      const bLen = bud.budLen * (0.45 + 0.55 * bloomProg) * sceneScale;
      const bRad = bud.budRad * (0.5 + 0.5 * bloomProg) * sceneScale;

      const base3 = rotateCrown3D(
        dirLocal.x * pLen,
        dirLocal.y * pLen,
        dirLocal.z * pLen,
        crownYaw,
        crownPitch,
        crownRoll
      );
      const tip3 = rotateCrown3D(
        dirLocal.x * (pLen + bLen),
        dirLocal.y * (pLen + bLen),
        dirLocal.z * (pLen + bLen),
        crownYaw,
        crownPitch,
        crownRoll
      );

      const pNode = project3D({ x: 0, y: 0, z: 0 }, crownX, crownY);
      const pBase = project3D(base3, crownX, crownY);
      const pTip = project3D(tip3, crownX, crownY);

      renderQueue.push({
        type: 'bud',
        z: (base3.z + tip3.z) * 0.5,
        pNode,
        pBase,
        pTip,
        bRad
      });
    }

    // 3. Build 5 to 7 outward-radiating florets around the 360-degree ring
    for (let fIdx = 0; fIdx < crownCfg.florets.length; fIdx++) {
      const fl = crownCfg.florets[fIdx];
      // Subtle independent secondary flutter on each floret
      const flutter = Math.sin(timeSec * fl.flutterFreq + fl.flutterPhase) * 0.045 * bloomProg;
      const az = fl.azimuth + flutter * 0.7;
      const el = fl.elevation + flutter;

      // Outward radial direction of the pedicel in crown local space (predominantly horizontal)
      const cosEl = Math.cos(el);
      const pedDirLocal = {
        x: Math.cos(az) * cosEl,
        y: -Math.sin(el),
        z: Math.sin(az) * cosEl
      };

      const pLen = fl.pedicelLen * (0.35 + 0.65 * bloomProg) * sceneScale;
      const pedTipLocal = {
        x: pedDirLocal.x * pLen,
        y: pedDirLocal.y * pLen,
        z: pedDirLocal.z * pLen
      };

      const pedTipWorld = rotateCrown3D(pedTipLocal.x, pedTipLocal.y, pedTipLocal.z, crownYaw, crownPitch, crownRoll);
      const pedTipProj = project3D(pedTipWorld, crownX, crownY);
      const nodeProj = project3D({ x: 0, y: 0, z: 0 }, crownX, crownY);

      renderQueue.push({
        type: 'pedicel',
        z: pedTipWorld.z * 0.5 - 2,
        p0: nodeProj,
        p1: pedTipProj,
        scale: cScale
      });

      // Floret axis points outward radially along the pedicel (never straight up!)
      const axisDir = normalize3(rotateCrown3D(pedDirLocal.x, pedDirLocal.y, pedDirLocal.z, crownYaw, crownPitch, crownRoll));
      let sideDir = cross3(worldUpLocal, axisDir);
      if (Math.hypot(sideDir.x, sideDir.y, sideDir.z) < 0.001) {
        sideDir = { x: 1, y: 0, z: 0 };
      } else {
        sideDir = normalize3(sideDir);
      }
      const upDir = normalize3(cross3(axisDir, sideDir));

      const tepalLen = fl.tepalLen * (0.35 + 0.65 * bloomProg) * sceneScale;
      const tepalWidth = fl.tepalWidth * (0.4 + 0.6 * bloomProg) * sceneScale;
      // Strongly recurved 150-180 degrees backward toward pedicel as floret opens
      const maxRecurveAngle = lerp(0.32, 2.86, smoothstep(0.12, 1.0, bloomProg));
      const ruffleAmp = tepalWidth * 0.42 * smoothstep(0.2, 1.0, bloomProg);

      // 3a. 6 Narrow Strongly Recurved Ruffled Tepals per Floret
      const uSteps = 14;
      for (let tIdx = 0; tIdx < 6; tIdx++) {
        const theta = (tIdx * Math.PI) / 3 + fl.twist;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        // Radial direction perpendicular to the outward floret axis
        const radDir = {
          x: upDir.x * cosT + sideDir.x * sinT,
          y: upDir.y * cosT + sideDir.y * sinT,
          z: upDir.z * cosT + sideDir.z * sinT
        };
        // Tangent direction perpendicular to both axisDir and radDir (for 3D edge ruffling)
        const tanDir = {
          x: -upDir.x * sinT + sideDir.x * cosT,
          y: -upDir.y * sinT + sideDir.y * cosT,
          z: -upDir.z * sinT + sideDir.z * cosT
        };

        const leftPts = [];
        const rightPts = [];
        const midPts = [];

        let curAlong = 0;
        let curRad = 0;
        const ds = tepalLen / uSteps;
        let zSum = 0;

        for (let iu = 0; iu <= uSteps; iu++) {
          const u = iu / uSteps;
          // Progressive recurve angle from outward throat (~0.35 rad) to strongly recurved (~164 deg)
          const curveAngle = 0.34 + maxRecurveAngle * Math.pow(u, 1.32);
          if (iu > 0) {
            curAlong += Math.cos(curveAngle) * ds;
            curRad += Math.sin(curveAngle) * ds;
          }

          // Narrow strap-like Lycoris radiata tepal silhouette
          const widthEnv = Math.sin(Math.PI * Math.pow(u, 0.64)) * (1 - 0.18 * u);
          const hw = tepalWidth * 0.5 * widthEnv;

          // Ruffled/wavy margin displacement
          const waveEnv = Math.sin(Math.PI * u);
          const ruffleWave = Math.sin(u * 14.5 + tIdx * 2.1 + fIdx * 1.3) * ruffleAmp * waveEnv;
          const outRuffle = Math.cos(u * 11.0 + tIdx * 1.7) * (ruffleAmp * 0.45) * waveEnv;

          const cx = pedTipWorld.x + axisDir.x * curAlong + radDir.x * curRad;
          const cy = pedTipWorld.y + axisDir.y * curAlong + radDir.y * curRad;
          const cz = pedTipWorld.z + axisDir.z * curAlong + radDir.z * curRad;

          const lx = cx - tanDir.x * hw + radDir.x * ruffleWave + axisDir.x * outRuffle;
          const ly = cy - tanDir.y * hw + radDir.y * ruffleWave + axisDir.y * outRuffle;
          const lz = cz - tanDir.z * hw + radDir.z * ruffleWave + axisDir.z * outRuffle;

          const rx = cx + tanDir.x * hw - radDir.x * ruffleWave - axisDir.x * outRuffle;
          const ry = cy + tanDir.y * hw - radDir.y * ruffleWave - axisDir.y * outRuffle;
          const rz = cz + tanDir.z * hw - radDir.z * ruffleWave - axisDir.z * outRuffle;

          midPts.push(project3D({ x: cx, y: cy, z: cz }, crownX, crownY));
          leftPts.push(project3D({ x: lx, y: ly, z: lz }, crownX, crownY));
          rightPts.push(project3D({ x: rx, y: ry, z: rz }, crownX, crownY));

          if (iu === 4 || iu === 9 || iu === 13) {
            zSum += cz;
          }
        }

        renderQueue.push({
          type: 'tepal',
          z: zSum / 3,
          leftPts,
          rightPts,
          midPts,
          scale: cScale
        });
      }

      // 3b. 6 Ultra-Long Sweeping Crimson Stamens + 1 Style with Graceful J-Curve
      const stamenReach = smoothstep(0.18, 1.0, bloomProg);
      if (stamenReach > 0.04) {
        const sSteps = 12;
        const totalFilaments = 7; // 6 stamens + 1 longer central style
        for (let sIdx = 0; sIdx < totalFilaments; sIdx++) {
          const isStyle = sIdx === 6;
          const sAz = isStyle ? 0.15 : (sIdx * Math.PI) / 3 + 0.28;
          const sLen = fl.stamenLen * (isStyle ? 1.12 : (0.94 + 0.1 * Math.sin(sIdx * 2.1))) * stamenReach * sceneScale;
          const coneSpread = isStyle ? 0.08 : (0.28 + 0.07 * Math.cos(sIdx * 1.9)) * stamenReach;

          const cosS = Math.cos(sAz);
          const sinS = Math.sin(sAz);
          const filRadDir = {
            x: upDir.x * cosS + sideDir.x * sinS,
            y: upDir.y * cosS + sideDir.y * sinS,
            z: upDir.z * cosS + sideDir.z * sinS
          };

          const tipFlutter = Math.sin(timeSec * (fl.flutterFreq * 1.25) + fl.flutterPhase + sIdx * 1.4) * 3.4 * sceneScale * stamenReach;
          const filPts = [];
          let tipWorld = pedTipWorld;

          for (let k = 0; k <= sSteps; k++) {
            const t = k / sSteps;
            // Sweep far outward horizontally along axisDir, fan radially, and curve gracefully upward (J-curve) at the tip
            const alongDist = sLen * (t - 0.06 * t * t);
            const radialDist = sLen * coneSpread * Math.pow(t, 1.22);
            const jCurveUp = sLen * (-0.11 * Math.sin(Math.PI * t) + 0.34 * Math.pow(t, 2.65));

            const wx = pedTipWorld.x + axisDir.x * alongDist + filRadDir.x * radialDist + sideDir.x * (tipFlutter * t * t);
            const wy = pedTipWorld.y + axisDir.y * alongDist + filRadDir.y * radialDist - jCurveUp + tipFlutter * 0.4 * t * t;
            const wz = pedTipWorld.z + axisDir.z * alongDist + filRadDir.z * radialDist;

            if (k === sSteps) {
              tipWorld = { x: wx, y: wy, z: wz };
            }
            filPts.push(project3D({ x: wx, y: wy, z: wz }, crownX, crownY));
          }

          renderQueue.push({
            type: 'stamen',
            z: tipWorld.z + 1.5,
            pts: filPts,
            isStyle,
            antherAngle: Math.atan2(
              filPts[sSteps].y - filPts[sSteps - 1].y,
              filPts[sSteps].x - filPts[sSteps - 1].x
            ) + Math.PI * 0.35,
            scale: cScale
          });
        }
      }
    }

    // 4. Sort all 3D parts back-to-front so rear, side-profile, and front florets layer naturally
    renderQueue.sort((a, b) => a.z - b.z);

    // 5. Render sorted 3D umbel elements
    for (let i = 0; i < renderQueue.length; i++) {
      const item = renderQueue[i];
      if (item.type === 'pedicel') {
        renderPedicel(item);
      } else if (item.type === 'bud') {
        renderCrimsonBud(item);
      } else if (item.type === 'tepal') {
        renderRecurvedTepal(item);
      } else if (item.type === 'stamen') {
        renderSweepingStamen(item);
      }
    }
  }

  function renderPedicel(item) {
    const { p0, p1, scale } = item;
    const midX = (p0.x + p1.x) * 0.5;
    const midY = (p0.y + p1.y) * 0.5 - 3.5 * scale;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.quadraticCurveTo(midX, midY, p1.x, p1.y);
    ctx.strokeStyle = '#9f1239';
    ctx.lineWidth = Math.max(1.1, 2.0 * scale);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  function renderCrimsonBud(item) {
    const { pNode, pBase, pTip, bRad } = item;

    // Slender pedicel to bud
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pNode.x, pNode.y);
    ctx.lineTo(pBase.x, pBase.y);
    ctx.strokeStyle = '#881337';
    ctx.lineWidth = Math.max(1.1, 1.8 * pBase.scale);
    ctx.stroke();

    const dx = pTip.x - pBase.x;
    const dy = pTip.y - pBase.y;
    const len = Math.hypot(dx, dy) || 1;
    const ang = Math.atan2(dy, dx);
    const r = bRad * pBase.scale;

    ctx.translate(pBase.x, pBase.y);
    ctx.rotate(ang);

    const budGrad = ctx.createLinearGradient(0, 0, len, 0);
    budGrad.addColorStop(0.0, '#6b0518');
    budGrad.addColorStop(0.55, '#dc143c');
    budGrad.addColorStop(1.0, '#ff85a1');

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * 0.25, -r * 1.15, len * 0.72, -r * 0.85, len, 0);
    ctx.bezierCurveTo(len * 0.72, r * 0.85, len * 0.25, r * 1.15, 0, 0);
    ctx.closePath();
    ctx.fillStyle = budGrad;
    ctx.fill();

    // Subtle longitudinal carpel seam & coral tip highlight
    ctx.beginPath();
    ctx.moveTo(len * 0.12, 0);
    ctx.lineTo(len * 0.92, 0);
    ctx.strokeStyle = 'rgba(255, 182, 193, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    ctx.restore();
  }

  function renderRecurvedTepal(item) {
    const { leftPts, rightPts, midPts, scale } = item;
    const rightRev = rightPts.slice().reverse();
    const basePt = midPts[0];
    const tipPt = midPts[midPts.length - 1];

    ctx.save();

    // Smooth C1-continuous outer tepal path
    ctx.beginPath();
    traceSmoothSpline(ctx, leftPts, true);
    traceSmoothSpline(ctx, rightRev, false);
    ctx.closePath();

    // Rich ruby (#6b0518) -> vivid crimson-scarlet (#dc143c -> #ff2a55)
    const grad = ctx.createLinearGradient(basePt.x, basePt.y, tipPt.x, tipPt.y);
    grad.addColorStop(0.0, '#6b0518');
    grad.addColorStop(0.45, '#dc143c');
    grad.addColorStop(0.85, '#ff2a55');
    grad.addColorStop(1.0, '#ff5c7c');

    ctx.fillStyle = grad;
    ctx.fill();

    // Luminous coral-pink rim highlight (#ff85a1) along ruffled margins
    ctx.strokeStyle = 'rgba(255, 133, 161, 0.72)';
    ctx.lineWidth = Math.max(0.75, 1.05 * scale);
    ctx.stroke();

    // Delicate luminous midrib vein
    ctx.beginPath();
    traceSmoothSpline(ctx, midPts.slice(1, -1), true);
    ctx.strokeStyle = 'rgba(255, 179, 198, 0.34)';
    ctx.lineWidth = Math.max(0.65, 0.85 * scale);
    ctx.stroke();

    ctx.restore();
  }

  function renderSweepingStamen(item) {
    const { pts, isStyle, antherAngle, scale } = item;
    const len = pts.length;
    if (len < 2) return;

    const pStart = pts[0];
    const pTip = pts[len - 1];

    ctx.save();
    ctx.beginPath();
    traceSmoothSpline(ctx, pts, true);
    ctx.strokeStyle = isStyle ? 'rgba(255, 117, 143, 0.85)' : 'rgba(244, 63, 94, 0.88)';
    ctx.lineWidth = Math.max(0.85, (isStyle ? 1.45 : 1.15) * scale * pTip.scale);
    ctx.lineCap = 'round';
    ctx.stroke();

    if (!isStyle) {
      // Cached additive golden-amber glow halo at anther tip
      const glowSize = 24 * scale * pTip.scale;
      if (antherGlowSprite && glowSize > 2) {
        ctx.globalCompositeOperation = 'screen';
        ctx.drawImage(
          antherGlowSprite,
          pTip.x - glowSize * 0.5,
          pTip.y - glowSize * 0.5,
          glowSize,
          glowSize
        );
        ctx.globalCompositeOperation = 'source-over';
      }

      // Glowing golden-amber anther (#fde047 / #f59e0b)
      const aw = 3.8 * scale * pTip.scale;
      const ah = 1.9 * scale * pTip.scale;
      ctx.translate(pTip.x, pTip.y);
      ctx.rotate(antherAngle);

      ctx.fillStyle = '#fde047';
      ctx.beginPath();
      ctx.ellipse(0, 0, aw, ah, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.ellipse(0, ah * 0.25, aw * 0.82, ah * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Delicate rose-gold stigma tip on the style
      ctx.fillStyle = '#fecdd3';
      ctx.beginPath();
      ctx.arc(pTip.x, pTip.y, 1.6 * scale * pTip.scale, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // ============================================================================
  // NOCTURNAL GRASS EDGE & FLOATING GOLDEN-CRIMSON EMBERS
  // ============================================================================
  function drawGrassEdge(timeSec) {
    ctx.save();
    for (let i = 0; i < grassBlades.length; i++) {
      const b = grassBlades[i];
      const bx = b.xFrac * width;
      const by = height + 4;
      const sway = Math.sin(timeSec * 1.45 + b.phase) * 7 * sceneScale + breeze.posX * 0.45 * sceneScale;
      const tipX = bx + (b.lean + sway) * sceneScale;
      const tipY = height - b.height * sceneScale;
      const ctrlX = bx + (b.lean * 0.35 + sway * 0.4) * sceneScale;
      const ctrlY = height - b.height * 0.52 * sceneScale;
      const hw = b.width * 0.5 * sceneScale;

      ctx.beginPath();
      ctx.moveTo(bx - hw, by);
      ctx.quadraticCurveTo(ctrlX - hw * 0.4, ctrlY, tipX, tipY);
      ctx.quadraticCurveTo(ctrlX + hw * 0.4, ctrlY, bx + hw, by);
      ctx.closePath();
      ctx.fillStyle = b.shade;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawEmbers(timeSec, dt) {
    if (!emberGlowSprite) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    for (let i = 0; i < embers.length; i++) {
      const e = embers[i];
      e.y -= e.speedY * dt;
      if (e.y < -0.06) {
        e.y = 1.06;
        e.x = Math.random();
      }

      const px = e.x * width + Math.sin(timeSec * e.driftFreq + e.phase) * e.driftAmp * sceneScale + breeze.posX * 0.4;
      const py = e.y * height;
      const twinkle = 0.5 + 0.5 * Math.sin(timeSec * e.twinkleFreq + e.phase * 1.7);
      const edgeFade = smoothstep(-0.04, 0.1, e.y) * smoothstep(1.04, 0.88, e.y);
      const alpha = e.alpha * twinkle * edgeFade;
      if (alpha <= 0.02) continue;

      const sz = e.size * sceneScale;
      ctx.globalAlpha = alpha;
      ctx.drawImage(emberGlowSprite, px - sz * 0.5, py - sz * 0.5, sz, sz);
    }

    ctx.restore();
  }

  // ============================================================================
  // MAIN 60 FPS ANIMATION LOOP
  // ============================================================================
  let prevTimestamp = performance.now();

  function render(now) {
    if (now - prevTimestamp < 1000 / 30) {
      requestAnimationFrame(render);
      return;
    }
    const dt = Math.min((now - prevTimestamp) / 1000, 0.05);
    prevTimestamp = now;
    const timeSec = (now - startTime) / 1000;

    // Update spring-damped breeze physics
    const stiffness = 16.0;
    const damping = 5.0;
    const ax = (breeze.targetX - breeze.posX) * stiffness - breeze.velX * damping;
    const ay = (breeze.targetY - breeze.posY) * stiffness - breeze.velY * damping;
    breeze.velX += ax * dt;
    breeze.velY += ay * dt;
    breeze.posX += breeze.velX * dt;
    breeze.posY += breeze.velY * dt;

    breeze.targetX = lerp(breeze.targetX, 0, 1.3 * dt);
    breeze.targetY = lerp(breeze.targetY, 0, 1.3 * dt);
    breeze.waveBoost = lerp(breeze.waveBoost, 0, 1.6 * dt);

    // 1. Blit pre-rendered midnight-indigo to ruby-plum twilight background
    if (bgCanvas) {
      ctx.drawImage(bgCanvas, 0, 0, width, height);
    }

    // 2. Render floating golden-crimson night embers
    drawEmbers(timeSec, dt);

    // 3. Render S-curved Higanbana scapes & outward-radiating 3D umbel crowns sorted back-to-front
    const anchorX = width * 0.5;
    const anchorY = height * 0.985;
    const sortedStems = stems.slice().sort((a, b) => a.zOrder - b.zOrder);

    for (let i = 0; i < sortedStems.length; i++) {
      const s = sortedStems[i];
      const growth = easeOutCubic((timeSec - s.growDelay) / s.growDuration);
      if (growth <= 0.01) continue;

      const stemPts = sampleWaveStemPoints(s, anchorX, anchorY, growth, timeSec);
      drawGracefulScape(stemPts, s.thickness, s.thickness * 0.64);

      if (growth > 0.62 && stemPts.length >= 3) {
        const tip = stemPts[stemPts.length - 1];
        const prev = stemPts[Math.max(0, stemPts.length - 3)];
        const stemLeanAngle = Math.atan2(tip.x - prev.x, -(tip.y - prev.y));
        const bloomProg = easeInOutSine((timeSec - s.crown.bloomDelay) / s.crown.bloomDuration);

        drawHiganbanaUmbel(tip.x, tip.y, stemLeanAngle, s.crown, bloomProg, timeSec);
      }
    }

    // 4. Render dark nocturnal grass silhouettes along bottom edge
    drawGrassEdge(timeSec);

    requestAnimationFrame(render);
  }

  window.onload = () => {
    buildGlowSprites();
    resize();
    initMeadow();
    prevTimestamp = performance.now();
    requestAnimationFrame(render);
  };
})();
