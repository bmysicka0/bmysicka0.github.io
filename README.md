<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Birdsong</title>
  <style>
:root { color-scheme: dark light; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    body { background: #00F; overflow: hidden; }
    canvas { position: fixed; inset: 0; display: block; width: 100%; height: 100%; image-rendering: pixelated; }
    /* brand overlay */
    #brand {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      color: #FFF;
      font-family: 'Times New Roman', Times, serif;
      font-weight: bold;
      font-size: clamp(40px, 12vw, 160px);
      line-height: 1.05;
      text-align: center;
      z-index: 2;
      pointer-events: none;
      text-shadow: 0 2px 0 rgba(0,0,0,0.15);
    }
    /* optional debug overlay toggle with "d" key */
    #debug { position: fixed; inset: auto 8px 8px auto; color: #FFF; font: 12px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; opacity: .55; }
</style>
</head>
<body>
<div id="brand" aria-hidden="true">b i r d s o n g</div>
<canvas id="c"></canvas>
<div id="debug" hidden></div>
<script>
(() => {
  const TAU = Math.PI * 2;
  const rand = (a=0, b=1) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a,b,t)=>a+(b-a)*t;

  const qs = new URLSearchParams(location.search);
  const MAX_BIRDS = clamp(+qs.get('n') || 36, 1, 300);
  const TORUS = true; // wrap world like a torus

  // Boids tuning (units are roughly px/sec and px)
  const BOIDS = {
    perception: 300,   // neighbor radius
    separation: 150,   // too-close radius
    maxSpeed: 250,    // speed clamp
    maxForce: 160,    // steering clamp (accel)
    edgeMargin: 80,   // border avoid band
    edgeForce: 1.0,   // border steering multiplier
    weights: {
      alignment: 0.1,
      cohesion: 0.1,
      separation: 1.0,
    },
  };

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const dbg = document.getElementById('debug');

  let DPR = Math.max(1, Math.min(3, self.devicePixelRatio || 1));
  let W = 0, H = 0;

  function resize() {
    DPR = Math.max(1, Math.min(3, self.devicePixelRatio || 1));
    W = Math.floor(innerWidth * DPR);
    H = Math.floor(innerHeight * DPR);
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    ctx.setTransform(1,0,0,1,0,0);
    ctx.imageSmoothingEnabled = false;
  }
  addEventListener('resize', resize);
  resize();

  // ASCII palette for strokes based on local slope
  const GLYPHS = ['_', '-', '-', '-', '.', '/', '\\', '^'];

  // Convert slope -> glyph
  function glyphForSlope(m) {
    const a = Math.abs(m);
    if (a < 0.2) return GLYPHS[0];
    if (a < 0.4) return GLYPHS[1];
    if (a < 0.7) return m > 0 ? '/' : '\\';
    if (a < 1.2) return m > 0 ? '/' : '\\';
    return '^';
  }

  // Bird built from y(x) = cos(1.2 * t * x) * t for x in [-2,2]
  class Bird {
    constructor(seed = Math.random()) {
      // world position (pixels, DPI scaled)
      this.x = rand(0, W);
      this.y = rand(0, H);
      this.vx = rand(-30, 60); // px/sec at DPR=1, scaled later
      this.vy = rand(-20, 20);
      this.ax = 0; // steering accel from boids
      this.ay = 0;

      // intrinsic parameters
      this.t = lerp(0.5, 1.0, Math.random()); // 0.5..1 as requested
      this.k = 1.2; // multiplier inside cos
      this.scale = rand(10, 22) * DPR; // cell size for ASCII grid
      this.cols = 9; // columns sampling x in [-2,2]
      this.rows = 5; // vertical cells used to place chars

      this.phase = rand(0, TAU);
      this.flap = rand(0.4, 1.0); // animation speed factor
      this.alpha = rand(0.6, 1);

      // trail jitter so instances look distinct
      this.wobble = rand(0.6, 2.0);
    }

    update(dt) {
      // subtle flutter as a small vertical accel
      const flutter = 10 * DPR;
      const wob = Math.sin(perfNow * 0.001 * this.wobble + this.phase) * flutter;
      const ax = this.ax;
      const ay = this.ay + wob;

      // integrate velocity from accel
      this.vx += ax * dt;
      this.vy += ay * dt;

      // clamp speed
      const maxSpeed = BOIDS.maxSpeed * DPR;
      const sp = Math.hypot(this.vx, this.vy);
      if (sp > maxSpeed && sp > 0) {
        const s = maxSpeed / sp;
        this.vx *= s; this.vy *= s;
      }

      // position integration (already in px/sec)
      this.x += this.vx * dt;
      this.y += this.vy * dt;

      // toroidal wrap
      if (TORUS) {
        if (this.x < 0) this.x += W; else if (this.x >= W) this.x -= W;
        if (this.y < 0) this.y += H; else if (this.y >= H) this.y -= H;
      }

      // keep within bounds softly; exact clamping avoids drifting offscreen
      this.x = clamp(this.x, 0, W);
      this.y = clamp(this.y, 0, H);

      // subtle flapping by varying t in [0.5, 1]
      const flapAmt = 0.12; // keep within range
      this.t = clamp(this.t + Math.sin(perfNow * 0.002 * this.flap + this.phase) * flapAmt * dt, 0.5, 1.0);
    }

    draw(ctx, time) {
      // Monospace text settings (FFF on 00F)
      const fontPx = Math.max(10, (this.scale * 0.9) | 0);
      ctx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#FFF';
      ctx.globalAlpha = this.alpha;

      const cols = this.cols;
      const rows = this.rows;
      const cell = this.scale;
      const halfW = ((cols - 1) / 2) * cell;
      const halfH = ((rows - 1) / 2) * cell;

      // Determine wrap draw offsets for seamless rendering near edges
      const offsX = [0];
      const offsY = [0];
      if (TORUS) {
        if (this.x < halfW) offsX.push(W);
        if (this.x > W - halfW) offsX.push(-W);
        if (this.y < halfH) offsY.push(H);
        if (this.y > H - halfH) offsY.push(-H);
      }

      for (const ox of offsX) for (const oy of offsY) {
        // sample x in [-2,2]
        for (let ci = 0; ci < cols; ci++) {
          const u = ci / (cols - 1);           // 0..1
          const x = -2 + u * 4;                // -2..2
          const px = this.x + ox + (ci - (cols-1)/2) * cell; // pixel x

          // animated phase shifts position a bit => bird "flaps"
          const tt = this.t * (1 + 0.15 * Math.sin(time * 0.0015 + this.phase));
          const y = Math.cos(this.k * tt * x) * tt; // -1..1-ish

          // derivative for slope -> glyph
          const dy = - this.k * tt * tt * Math.sin(this.k * tt * x);
          const ch = glyphForSlope(dy);

          // map y ∈ [-1,1] into row indices ~ [-2,2]
          const r = Math.round(lerp(-(rows-1)/2, (rows-1)/2, (y + 1) * 0.5));
          const py = this.y + oy + r * cell;

          ctx.fillText(ch, px, py);
        }
      }

      ctx.globalAlpha = 1;
    }
  }

  // Build flock
  const birds = Array.from({ length: MAX_BIRDS }, () => new Bird());

  let last = performance.now();
  let perfNow = last;

  function frame(now) {
    perfNow = now;
    const dt = clamp((now - last) / 1000, 0, 0.033); // cap dt
    last = now;

    // Clear (00F)
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle = '#00F';
    ctx.fillRect(0, 0, W, H);

    // mild starfield dots to accent motion (still #FFF at low alpha)
    ctx.globalAlpha = 0.04;
    ctx.fillStyle = '#FFF';
    for (let i = 0; i < 40; i++) {
      const x = (Math.random() * W) | 0;
      const y = (Math.random() * H) | 0;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;

    // Boids steering pass (O(n^2))
    const perception = BOIDS.perception * DPR;
    const sepR = BOIDS.separation * DPR;
    const maxForce = BOIDS.maxForce * DPR;
    const maxSpeed = BOIDS.maxSpeed * DPR;
    const margin = BOIDS.edgeMargin * DPR;
    for (let i = 0; i < birds.length; i++) {
      const b = birds[i];
      let count = 0;
      let avgVX = 0, avgVY = 0; // alignment
      let offSumX = 0, offSumY = 0; // cohesion via avg offset (torus safe)
      let sepX = 0, sepY = 0;   // separation (away from neighbors)

      // neighbor accumulation
      for (let j = 0; j < birds.length; j++) {
        if (i === j) continue;
        const o = birds[j];
        let dx = o.x - b.x;
        let dy = o.y - b.y;
        if (TORUS) {
          if (dx > W*0.5) dx -= W; else if (dx < -W*0.5) dx += W;
          if (dy > H*0.5) dy -= H; else if (dy < -H*0.5) dy += H;
        }
        const d2 = dx*dx + dy*dy;
        if (d2 <= perception * perception) {
          count++;
          avgVX += o.vx; avgVY += o.vy;
          offSumX += dx; offSumY += dy;
          if (d2 <= sepR * sepR) {
            const d = Math.sqrt(d2) || 1;
            // push directly away (normalized)
            sepX -= dx / d;
            sepY -= dy / d;
          }
        }
      }

      let ax = 0, ay = 0;
      if (count > 0) {
        // Alignment: steer towards average velocity direction
        avgVX /= count; avgVY /= count;
        let len = Math.hypot(avgVX, avgVY) || 1;
        let desiredX = (avgVX / len) * maxSpeed;
        let desiredY = (avgVY / len) * maxSpeed;
        let steerX = desiredX - b.vx;
        let steerY = desiredY - b.vy;
        let steerLen = Math.hypot(steerX, steerY) || 1;
        if (steerLen > maxForce) { steerX = (steerX / steerLen) * maxForce; steerY = (steerY / steerLen) * maxForce; }
        ax += steerX * BOIDS.weights.alignment;
        ay += steerY * BOIDS.weights.alignment;

        // Cohesion: steer toward average offset (torus-friendly)
        let toCtrX = offSumX / count; let toCtrY = offSumY / count;
        len = Math.hypot(toCtrX, toCtrY) || 1;
        desiredX = (toCtrX / len) * maxSpeed;
        desiredY = (toCtrY / len) * maxSpeed;
        steerX = desiredX - b.vx;
        steerY = desiredY - b.vy;
        steerLen = Math.hypot(steerX, steerY) || 1;
        if (steerLen > maxForce) { steerX = (steerX / steerLen) * maxForce; steerY = (steerY / steerLen) * maxForce; }
        ax += steerX * BOIDS.weights.cohesion;
        ay += steerY * BOIDS.weights.cohesion;

        // Separation: steer away from close neighbors
        if (sepX !== 0 || sepY !== 0) {
          len = Math.hypot(sepX, sepY) || 1;
          desiredX = (sepX / len) * maxSpeed;
          desiredY = (sepY / len) * maxSpeed;
          steerX = desiredX - b.vx;
          steerY = desiredY - b.vy;
          steerLen = Math.hypot(steerX, steerY) || 1;
          if (steerLen > maxForce) { steerX = (steerX / steerLen) * maxForce; steerY = (steerY / steerLen) * maxForce; }
          ax += steerX * BOIDS.weights.separation;
          ay += steerY * BOIDS.weights.separation;
        }
      }

      // Edge behavior (disabled for TORUS)
      if (!TORUS) {
        const turn = maxForce * BOIDS.edgeForce;
        if (b.x < margin) ax += turn;
        else if (b.x > W - margin) ax -= turn;
        if (b.y < margin) ay += turn;
        else if (b.y > H - margin) ay -= turn;
      }

      b.ax = ax;
      b.ay = ay;
    }

    // Update + draw using computed steering
    for (const b of birds) { b.update(dt); b.draw(ctx, now); }

    // Debug overlay
    if (!dbg.hidden) {
      dbg.textContent = `birds: ${birds.length}\nDPR: ${DPR.toFixed(2)}\nFPS: ${(1/dt).toFixed(0)}`;
    }

    ctx.restore();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Toggle debug with "d"
  addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'd') dbg.hidden = !dbg.hidden;
  });
})();
</script>
</body>
</html>
