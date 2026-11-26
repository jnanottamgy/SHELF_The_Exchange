/*!
 * Tiny Terra — app: rendering, interaction and UI.
 * Depends only on js/terra.js. No libraries, no network.
 */
(function () {
  'use strict';

  const Terra = window.Terra;
  if (!Terra) {
    document.body.textContent = 'Tiny Terra could not load its planet engine (js/terra.js).';
    return;
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const TEX_W = 512;
  const INV_2PI = 1 / (2 * Math.PI), INV_PI = 1 / Math.PI, DEG = 180 / Math.PI;
  const ZOOM_MIN = 0.55, ZOOM_MAX = 2.2;
  const PITCH_LIMIT = 1.35;
  const SUN = normalize3([-0.62, 0.22, 0.75]);      // sun direction, fixed in space
  const BUILD_BUDGET_MS = 9;                        // per-frame planet building budget
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const PRESET_ORBS = {
    earth: ['#38bdf8', '#22c55e', '#1e3a8a'],
    archipelago: ['#67e8f9', '#0ea5e9', '#065f46'],
    desert: ['#fcd34d', '#d97706', '#7c2d12'],
    ice: ['#f8fafc', '#bae6fd', '#1e40af'],
    inferno: ['#fdba74', '#dc2626', '#3b0a0a'],
    highlands: ['#e5e7eb', '#78716c', '#14532d'],
  };

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const dom = {
    stage: $('stage'), canvas: $('view'), seedForm: $('seed-form'), seed: $('seed'), seedStatus: $('seed-status'),
    random: $('btn-random'), share: $('btn-share'), save: $('btn-save'), help: $('btn-help'), how: $('btn-how'),
    brand: $('brand'), forming: $('forming'), formingBar: $('forming-bar'), formingText: $('forming-text'),
    hint: $('hint'), tip: $('tip'), tipSwatch: $('tip-swatch'), tipBiome: $('tip-biome'), tipElev: $('tip-elev'),
    tipTemp: $('tip-temp'), tipSun: $('tip-sun'), tipCoord: $('tip-coord'),
    play: $('btn-play'), clock: $('hud-clock'), zoomIn: $('btn-zoom-in'), zoomOut: $('btn-zoom-out'), reset: $('btn-reset'),
    viewGlobe: $('view-globe'), viewMap: $('view-map'),
    presets: $('presets'),
    sl: { temp: $('sl-temp'), water: $('sl-water'), terrain: $('sl-terrain'), speed: $('sl-speed') },
    out: { temp: $('out-temp'), water: $('out-water'), terrain: $('out-terrain'), speed: $('out-speed') },
    tg: { clouds: $('tg-clouds'), lights: $('tg-lights'), grid: $('tg-grid'), lapse: $('tg-lapse') },
    pName: $('p-name'), pDesignation: $('p-designation'), pClass: $('p-class'), pNote: $('p-note'),
    habValue: $('hab-value'), habNum: $('hab-num'), habVerdict: $('hab-verdict'), habLife: $('hab-life'),
    lifeText: $('life-text'), habTraits: $('hab-traits'),
    stWater: $('st-water'), stLand: $('st-land'), stIce: $('st-ice'), stTemp: $('st-temp'), stPeak: $('st-peak'),
    stPeakUnit: $('st-peak-unit'), biomeBar: $('biome-bar'), biomeLegend: $('biome-legend'),
    helpModal: $('help'), helpClose: $('help-close'), toast: $('toast'),
    skyFar: $('sky-far'), skyNear: $('sky-near'), skyTwinkle: $('sky-twinkle'),
  };
  const ctx = dom.canvas.getContext('2d');
  dom.sound = $('btn-sound');

  // Sound (js/audio.js). Optional: the app works the same without it.
  const audio = window.TerraAudio || null;
  const sfx = (name) => { if (audio) audio.sfx(name); };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const initial = Terra.parseHash(location.hash);
  const state = {
    seed: initial.seed,
    temp: initial.temp, water: initial.water, terrain: initial.terrain,
    speed: reduceMotion ? 1 : initial.speed, view: initial.view,
    paused: false, clouds: true, lights: true, grid: false,
  };

  const view = {
    yaw: -0.35, pitch: 0.32, zoom: 1, targetZoom: 1, spin: 0, cloudShift: 0,
    vyaw: 0, vpitch: 0, mapPan: 0, vpan: 0,
  };

  let planet = null;     // seed-dependent fields
  let climate = null;    // texture + stats for current settings
  let builder = null;    // in-progress planet build
  let climateDirty = false, statsDirty = false, lastStatsAt = 0;
  let dirty = true;      // needs a redraw even when nothing is animating
  let tween = null;      // preset slider animation
  let fade = null;       // crossfade between planets
  let introStart = -1;   // first planet entrance
  let dpr = 1, cssW = 0, cssH = 0;
  let layout = { cx: 0, cy: 0, R: 1, stageW: 1, stageH: 1, map: null };
  let qualityCap = 640, shadeEma = 8, frameCount = 0;
  let hover = null;      // last pointer position for the inspector
  let interacted = false;

  // ---------------------------------------------------------------------------
  // Math helpers
  // ---------------------------------------------------------------------------
  function normalize3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /** Rotation taking view-space normals to planet-space positions. */
  function planetMatrix() {
    const A = view.yaw + view.spin, p = view.pitch;
    const cA = Math.cos(A), sA = Math.sin(A), cp = Math.cos(p), sp = Math.sin(p);
    return [cA, sA * sp, -sA * cp, 0, cp, sp, sA, -cA * sp, cA * cp];
  }
  /** Sun direction in view space (the camera orbits; the sun stays put). */
  function sunView() {
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    const tx = cy * SUN[0] + sy * SUN[2], ty = SUN[1], tz = -sy * SUN[0] + cy * SUN[2];
    return [tx, cp * ty - sp * tz, sp * ty + cp * tz];
  }
  /** Sun direction in planet space (for the flat map). */
  function sunPlanet() {
    const c = Math.cos(view.spin), s = Math.sin(view.spin);
    return [c * SUN[0] - s * SUN[2], SUN[1], s * SUN[0] + c * SUN[2]];
  }

  // ---------------------------------------------------------------------------
  // Sky: three repeating star tiles with parallax
  // ---------------------------------------------------------------------------
  function buildSky() {
    const make = (count, seed, maxR, glow) => {
      const c = document.createElement('canvas');
      c.width = c.height = 512;
      const g = c.getContext('2d');
      const r = Terra.mulberry32(seed);
      for (let i = 0; i < count; i++) {
        const x = r() * 512, y = r() * 512, rad = 0.25 + Math.pow(r(), 3) * maxR;
        const hue = r() < 0.15 ? '255,214,170' : r() < 0.3 ? '170,200,255' : '255,255,255';
        const a = 0.25 + r() * 0.75;
        if (glow && rad > 0.9) {
          const gr = g.createRadialGradient(x, y, 0, x, y, rad * 5);
          gr.addColorStop(0, 'rgba(' + hue + ',' + a * 0.5 + ')');
          gr.addColorStop(1, 'rgba(' + hue + ',0)');
          g.fillStyle = gr;
          g.fillRect(x - rad * 5, y - rad * 5, rad * 10, rad * 10);
        }
        g.fillStyle = 'rgba(' + hue + ',' + a + ')';
        g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
      }
      try { return 'url(' + c.toDataURL('image/png') + ')'; } catch (e) { return 'none'; }
    };
    dom.skyFar.style.backgroundImage = make(260, 11, 0.9, false);
    dom.skyNear.style.backgroundImage = make(70, 23, 1.6, true);
    dom.skyTwinkle.style.backgroundImage = make(26, 37, 2.0, true);
  }
  let skyX = NaN, skyY = NaN;
  function updateSky() {
    const x = Math.round(-view.yaw * 60), y = Math.round(view.pitch * 40);
    if (x === skyX && y === skyY) return;
    skyX = x; skyY = y;
    dom.skyFar.style.backgroundPosition = (x * 0.5) + 'px ' + (y * 0.5) + 'px';
    dom.skyNear.style.backgroundPosition = x + 'px ' + y + 'px';
    dom.skyTwinkle.style.backgroundPosition = (x * 1.4) + 'px ' + (y * 1.4) + 'px';
  }

  // ---------------------------------------------------------------------------
  // Layout & sizing
  // ---------------------------------------------------------------------------
  function resize() {
    const rect = dom.canvas.getBoundingClientRect();
    const nd = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * nd)), h = Math.max(1, Math.round(rect.height * nd));
    if (dom.canvas.width !== w || dom.canvas.height !== h) { dom.canvas.width = w; dom.canvas.height = h; }
    dpr = nd; cssW = rect.width; cssH = rect.height;
    computeLayout();
    positionGlider();
    dirty = true;
  }

  function computeLayout() {
    const c = dom.canvas.getBoundingClientRect();
    const s = dom.stage.getBoundingClientRect();
    const short = window.innerHeight <= 960 && window.innerWidth > 980;
    const top = short ? 92 : 104, bottom = short ? 56 : 70; // room for the view switch, mission and HUD
    const stageW = Math.max(120, s.width), stageH = Math.max(120, s.height);
    const availH = Math.max(100, stageH - top - bottom);
    const cx = s.left - c.left + stageW / 2;
    const cy = s.top - c.top + top + availH / 2;
    const baseR = Math.max(40, Math.min(stageW * 0.44, availH * 0.47));
    let mapW = Math.min(stageW - 16, availH * 2);
    mapW = Math.max(160, mapW);
    const mapH = mapW / 2;
    layout = {
      cx, cy, baseR, stageW, stageH,
      map: { x: cx - mapW / 2, y: cy - mapH / 2, w: mapW, h: mapH },
    };
  }

  // ---------------------------------------------------------------------------
  // Globe shading (per pixel, into an ImageData buffer)
  // ---------------------------------------------------------------------------
  function frameParams() {
    return {
      m: planetMatrix(), sun: sunView(), clouds: state.clouds, lights: state.lights, grid: state.grid,
      cloudShift: view.cloudShift, atm: climate.stats.atmosphere,
    };
  }

  /**
   * Shades an N×N globe into `data` (an RGBA buffer `stride` pixels wide).
   * Normals are computed on the fly, so zooming allocates nothing.
   */
  function shadeGlobe(data, stride, N, P) {
    const tex = climate.rgb, wat = climate.water, lights = climate.lights, ltype = climate.lightType, clouds = climate.clouds;
    const hgt = climate.height, sl = climate.seaLevel;
    const W = planet.W, H = planet.H, CW = planet.CW, CH = planet.CH;
    // Coast edge width in texels: about one screen pixel at this zoom.
    const coastSharp = clamp(W / (Math.PI * N), 0.08, 1);
    const m = P.m, m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[3], m11 = m[4], m12 = m[5], m20 = m[6], m21 = m[7], m22 = m[8];
    const sx = P.sun[0], sy = P.sun[1], sz = P.sun[2];
    let hx = sx, hy = sy, hz = sz + 1;
    const hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
    const showClouds = P.clouds, showLights = P.lights, grid = P.grid;
    const ar = P.atm[0], ag = P.atm[1], ab = P.atm[2];
    const cShift = P.cloudShift;
    const gridEps = 0.55 * (512 / N);
    const rad = N / 2, invR = 1 / rad, lim = 1 + 1.5 * invR, lim2 = lim * lim;
    const inner = 1 - 2 * invR, inner2 = inner > 0 ? inner * inner : 0;
    for (let y = 0; y < N; y++) {
      const dy = (y + 0.5 - rad) * invR;
      if (dy * dy >= lim2) continue;
      const half = Math.sqrt(lim2 - dy * dy) * rad;
      let xs = Math.floor(rad - half - 1), xe = Math.ceil(rad + half + 1);
      if (xs < 0) xs = 0;
      if (xe > N) xe = N;
      let o = (y * stride + xs) * 4;
      for (let x = xs; x < xe; x++, o += 4) {
        const dx = (x + 0.5 - rad) * invR;
        const d2 = dx * dx + dy * dy;
        let alpha = 255, vx = dx, vy = -dy;
        if (d2 > inner2) {
          const dist = Math.sqrt(d2);
          const cover = (1 - dist) * rad + 0.5;
          if (cover <= 0) { data[o + 3] = 0; continue; }
          alpha = cover >= 1 ? 255 : cover * 255;
          if (dist > 0.9995) { const k = 0.9995 / dist; vx *= k; vy *= k; }
        }
        const vz = Math.sqrt(Math.max(0, 1 - vx * vx - vy * vy));
        const px = m00 * vx + m01 * vy + m02 * vz;
        let py = m10 * vx + m11 * vy + m12 * vz;
        const pz = m20 * vx + m21 * vy + m22 * vz;
        if (py > 1) py = 1; else if (py < -1) py = -1;
        const lon = Math.atan2(px, pz), lat = Math.asin(py);
        const u = (lon * INV_2PI + 0.5) * W - 0.5;
        const v = (0.5 - lat * INV_PI) * H - 0.5;
        let x0 = Math.floor(u); const fx = u - x0;
        if (x0 < 0) x0 += W; else if (x0 >= W) x0 -= W;
        const x1 = x0 + 1 === W ? 0 : x0 + 1;
        let y0 = Math.floor(v), fy = v - y0;
        if (y0 < 0) { y0 = 0; fy = 0; } else if (y0 >= H - 1) { y0 = H - 1; fy = 0; }
        const y1 = y0 + 1 < H ? y0 + 1 : y0;
        const r0 = y0 * W, r1 = y1 * W;
        const ia = r0 + x0, ib = r0 + x1, ic = r1 + x0, id = r1 + x1;
        const a = ia * 3, b = ib * 3, c = ic * 3, d = id * 3;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        let R, G, B, wet;
        const ha = hgt[ia], hb = hgt[ib], hc = hgt[ic], hd = hgt[id];
        const la = ha >= sl, lb = hb >= sl, lc = hc >= sl, ld = hd >= sl;
        if (la === lb && lb === lc && lc === ld) {
          R = tex[a] * w00 + tex[b] * w10 + tex[c] * w01 + tex[d] * w11;
          G = tex[a + 1] * w00 + tex[b + 1] * w10 + tex[c + 1] * w01 + tex[d + 1] * w11;
          B = tex[a + 2] * w00 + tex[b + 2] * w10 + tex[c + 2] * w01 + tex[d + 2] * w11;
          wet = la ? 0 : (wat[ia] * w00 + wat[ib] * w10 + wat[ic] * w01 + wat[id] * w11);
        } else {
          // The coastline crosses this texel cell: blend land-only and
          // sea-only colours along the interpolated height, so coasts stay
          // smooth curves instead of a staircase of texels.
          let wl = 0, ws = 0, Rl = 0, Gl = 0, Bl = 0, Rs = 0, Gs = 0, Bs = 0;
          if (la) { wl += w00; Rl += tex[a] * w00; Gl += tex[a + 1] * w00; Bl += tex[a + 2] * w00; }
          else { ws += w00; Rs += tex[a] * w00; Gs += tex[a + 1] * w00; Bs += tex[a + 2] * w00; }
          if (lb) { wl += w10; Rl += tex[b] * w10; Gl += tex[b + 1] * w10; Bl += tex[b + 2] * w10; }
          else { ws += w10; Rs += tex[b] * w10; Gs += tex[b + 1] * w10; Bs += tex[b + 2] * w10; }
          if (lc) { wl += w01; Rl += tex[c] * w01; Gl += tex[c + 1] * w01; Bl += tex[c + 2] * w01; }
          else { ws += w01; Rs += tex[c] * w01; Gs += tex[c + 1] * w01; Bs += tex[c + 2] * w01; }
          if (ld) { wl += w11; Rl += tex[d] * w11; Gl += tex[d + 1] * w11; Bl += tex[d + 2] * w11; }
          else { ws += w11; Rs += tex[d] * w11; Gs += tex[d + 1] * w11; Bs += tex[d + 2] * w11; }
          const hi = ha * w00 + hb * w10 + hc * w01 + hd * w11;
          let span = Math.max(ha, hb, hc, hd) - Math.min(ha, hb, hc, hd);
          if (span < 1e-6) span = 1e-6;
          let kk = (hi - sl) / (span * coastSharp) + 0.5;
          kk = kk < 0 ? 0 : kk > 1 ? 1 : kk;
          if (wl < 1e-6) kk = 0; else if (ws < 1e-6) kk = 1;
          const il = wl > 1e-6 ? kk / wl : 0, is = ws > 1e-6 ? (1 - kk) / ws : 0;
          R = Rl * il + Rs * is; G = Gl * il + Gs * is; B = Bl * il + Bs * is;
          wet = 1 - kk;
        }
        const ni = (fy < 0.5 ? r0 : r1) + (fx < 0.5 ? x0 : x1);

        // Sunlight with a soft terminator.
        const ndl = vx * sx + vy * sy + vz * sz;
        let day = (ndl + 0.12) * 3.4;
        day = day < 0 ? 0 : day > 1 ? 1 : day;
        day = day * day * (3 - 2 * day);
        const diff = ndl > 0 ? ndl : 0;
        const lit = 0.05 + day * (0.4 + 0.72 * diff);
        R *= lit; G *= lit; B *= lit;
        const tw = 1 - Math.abs(ndl + 0.03) * 6;
        if (tw > 0) { const t2 = tw * tw * 0.55; R += 72 * t2; G += 30 * t2; B += 10 * t2; }

        // Sun glint on open water.
        if (wet > 0.02 && ndl > 0) {
          const nh = vx * hx + vy * hy + vz * hz;
          if (nh > 0.82) {
            const s = (Math.pow(nh, 160) * 0.55 + Math.pow(nh, 16) * 0.08) * day * wet;
            R += 255 * s; G += 246 * s; B += 222 * s;
          }
        }

        // City lights and lava glow on the night side (soft, bilinear).
        if (showLights && day < 0.98) {
          const L = lights[ia] * w00 + lights[ib] * w10 + lights[ic] * w01 + lights[id] * w11;
          if (L > 0.5) {
            const nf = (1 - day) * L * (1 / 255);
            if (ltype[ni] === 2) { R += 255 * nf; G += 88 * nf; B += 24 * nf; }
            else { R += 268 * nf; G += 204 * nf; B += 124 * nf; }
          }
        }

        // Clouds (half-resolution layer, drifting with the wind).
        if (showClouds) {
          let cu = (u + 0.5) * 0.5 - 0.5 + cShift;
          cu %= CW; if (cu < 0) cu += CW;
          let cv = (v + 0.5) * 0.5 - 0.5;
          if (cv < 0) cv = 0; else if (cv > CH - 1) cv = CH - 1;
          const cx0 = cu | 0, cfx = cu - cx0, cx1 = cx0 + 1 === CW ? 0 : cx0 + 1;
          const cy0 = cv | 0, cfy = cv - cy0, cy1 = cy0 + 1 < CH ? cy0 + 1 : cy0;
          const q0 = cy0 * CW, q1 = cy1 * CW;
          const cr = (clouds[q0 + cx0] * (1 - cfx) + clouds[q0 + cx1] * cfx) * (1 - cfy) +
            (clouds[q1 + cx0] * (1 - cfx) + clouds[q1 + cx1] * cfx) * cfy;
          if (cr > 0) {
            const cd = cr >= 1 ? 0.78 : cr * cr * (3 - 2 * cr) * 0.78;
            const cl = 0.035 + day * (0.5 + 0.55 * diff);
            R += (248 * cl - R) * cd; G += (250 * cl - G) * cd; B += (255 * cl - B) * cd;
          }
        }

        if (grid) {
          const latD = lat * DEG, lonD = lon * DEG;
          const gl = Math.abs(latD - Math.round(latD / 30) * 30);
          const go = Math.abs(lonD - Math.round(lonD / 30) * 30) * Math.cos(lat);
          if (gl < gridEps || go < gridEps) {
            const k = Math.abs(latD) < gridEps ? 0.55 : 0.32;
            R += (110 - R) * k; G += (231 - G) * k; B += (255 - B) * k;
          }
        }

        // Atmosphere: limb scattering, brighter on the lit side.
        const rim = 1 - vz, rim2 = rim * rim, rim4 = rim2 * rim2;
        let ad = (ndl + 0.3) * 1.5;
        ad = ad < 0 ? 0 : ad > 1 ? 1 : ad;
        const atm = (rim2 * 0.32 + rim4 * 1.05) * ad + 0.035 * day;
        R += ar * atm; G += ag * atm; B += ab * atm;

        data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = alpha;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Map shading
  // ---------------------------------------------------------------------------
  let mapCanvas = null, mapImg = null;
  function shadeMap() {
    const W = planet.W, H = planet.H, CW = planet.CW, CH = planet.CH;
    if (!mapCanvas || mapCanvas.width !== W || mapCanvas.height !== H) {
      mapCanvas = document.createElement('canvas');
      mapCanvas.width = W; mapCanvas.height = H;
      mapImg = mapCanvas.getContext('2d').createImageData(W, H);
    }
    const data = mapImg.data;
    const tex = climate.rgb, lights = climate.lights, ltype = climate.lightType, clouds = climate.clouds;
    const { rowSin, rowCos, colSin, colCos } = planet;
    const s = sunPlanet(), sx = s[0], sy = s[1], sz = s[2];
    const showClouds = state.clouds, showLights = state.lights;
    const cShift = view.cloudShift;
    let i = 0;
    for (let y = 0; y < H; y++) {
      const sl = rowSin[y], cl = rowCos[y];
      let cv = (y + 0.5) * 0.5 - 0.5;
      if (cv < 0) cv = 0; else if (cv > CH - 1) cv = CH - 1;
      const cy0 = cv | 0, cfy = cv - cy0, cy1 = cy0 + 1 < CH ? cy0 + 1 : cy0;
      const q0 = cy0 * CW, q1 = cy1 * CW;
      for (let x = 0; x < W; x++, i++) {
        const ndl = cl * colSin[x] * sx + sl * sy + cl * colCos[x] * sz;
        let day = (ndl + 0.12) * 3.4;
        day = day < 0 ? 0 : day > 1 ? 1 : day;
        day = day * day * (3 - 2 * day);
        const diff = ndl > 0 ? ndl : 0;
        const lit = 0.12 + day * (0.42 + 0.6 * diff);
        const o3 = i * 3;
        let R = tex[o3] * lit, G = tex[o3 + 1] * lit, B = tex[o3 + 2] * lit;
        const tw = 1 - Math.abs(ndl + 0.03) * 6;
        if (tw > 0) { const t2 = tw * tw * 0.45; R += 72 * t2; G += 30 * t2; B += 10 * t2; }
        if (showLights) {
          const L = lights[i];
          if (L !== 0 && day < 0.98) {
            const nf = (1 - day) * L * (1 / 255);
            if (ltype[i] === 2) { R += 255 * nf; G += 88 * nf; B += 24 * nf; }
            else { R += 268 * nf; G += 204 * nf; B += 124 * nf; }
          }
        }
        if (showClouds) {
          let cu = (x + 0.5) * 0.5 - 0.5 + cShift;
          cu %= CW; if (cu < 0) cu += CW;
          const cx0 = cu | 0, cfx = cu - cx0, cx1 = cx0 + 1 === CW ? 0 : cx0 + 1;
          const cr = (clouds[q0 + cx0] * (1 - cfx) + clouds[q0 + cx1] * cfx) * (1 - cfy) +
            (clouds[q1 + cx0] * (1 - cfx) + clouds[q1 + cx1] * cfx) * cfy;
          if (cr > 0) {
            const cd = cr >= 1 ? 0.8 : cr * cr * (3 - 2 * cr) * 0.8;
            const c = 0.1 + day * (0.5 + 0.5 * diff);
            R += (248 * c - R) * cd; G += (250 * c - G) * cd; B += (255 * c - B) * cd;
          }
        }
        const o = i * 4;
        data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = 255;
      }
    }
    mapCanvas.getContext('2d').putImageData(mapImg, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  function drawHalo(g, cx, cy, R, atm, sun, alpha) {
    const [r, gg, b] = atm;
    const halo = g.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.32);
    halo.addColorStop(0, 'rgba(' + r + ',' + gg + ',' + b + ',' + (0.34 * alpha) + ')');
    halo.addColorStop(0.35, 'rgba(' + r + ',' + gg + ',' + b + ',' + (0.12 * alpha) + ')');
    halo.addColorStop(1, 'rgba(' + r + ',' + gg + ',' + b + ',0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(cx, cy, R * 1.32, 0, Math.PI * 2); g.fill();
    // Brighter scattering on the sunlit limb.
    const ox = cx + sun[0] * R * 0.35, oy = cy - sun[1] * R * 0.35;
    const lit = g.createRadialGradient(ox, oy, R * 0.8, ox, oy, R * 1.45);
    lit.addColorStop(0, 'rgba(' + r + ',' + gg + ',' + b + ',' + (0.18 * alpha) + ')');
    lit.addColorStop(1, 'rgba(' + r + ',' + gg + ',' + b + ',0)');
    g.fillStyle = lit;
    g.beginPath(); g.arc(cx, cy, R * 1.45, 0, Math.PI * 2); g.fill();
  }

  function drawRings(g, cx, cy, R, front, alpha) {
    const t = planet && planet.traits;
    if (!t || !t.rings) return;
    const k = Math.sin(view.pitch);
    const ak = Math.max(Math.abs(k), 0.012);
    const inner = R * t.ringInner, outer = R * t.ringOuter;
    const nearIsLower = k >= 0;
    g.save();
    g.translate(cx, cy);
    g.beginPath();
    if (front === nearIsLower) g.rect(-outer - 6, 0, outer * 2 + 12, outer + 6);
    else g.rect(-outer - 6, -outer - 6, outer * 2 + 12, outer + 6);
    g.clip();
    g.scale(1, ak);
    const bands = t.ringBands, n = bands.length, bw = (outer - inner) / n;
    const c = t.ringColor;
    const light = front ? 0.95 : 0.7;
    for (let i = 0; i < n; i++) {
      g.beginPath();
      g.arc(0, 0, inner + bw * (i + 0.5), 0, Math.PI * 2);
      g.lineWidth = bw * 1.04;
      g.strokeStyle = 'rgba(' + Math.round(c[0] * light) + ',' + Math.round(c[1] * light) + ',' + Math.round(c[2] * light) + ',' + (bands[i] * 0.7 * alpha) + ')';
      g.stroke();
    }
    g.restore();
  }

  let fadeCanvas = null;
  function snapshotForFade() {
    if (!planet || reduceMotion) return;
    if (!fadeCanvas) fadeCanvas = document.createElement('canvas');
    fadeCanvas.width = dom.canvas.width; fadeCanvas.height = dom.canvas.height;
    fadeCanvas.getContext('2d').drawImage(dom.canvas, 0, 0);
    fade = { start: performance.now(), dur: 750 };
  }

  function draw(now) {
    const w = dom.canvas.width, h = dom.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!planet || !climate) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let introK = 1;
    if (introStart >= 0) {
      const t = clamp((now - introStart) / 1300, 0, 1);
      introK = easeOut(t);
      if (t >= 1) introStart = -1;
    }
    let pulse = 1;
    if (fade) {
      const t = clamp((now - fade.start) / fade.dur, 0, 1);
      pulse = 0.94 + 0.06 * easeOut(t);
    }

    const shake = (doom ? doom.shake : 0) + (game ? game.shake : 0);
    if (shake > 0.3 && !reduceMotion) ctx.translate((Math.random() * 2 - 1) * shake, (Math.random() * 2 - 1) * shake);
    if (doom) doom.shake *= 0.86;
    if (game) game.shake *= 0.86;
    if (state.view === 'globe') drawGlobe(introK, pulse);
    else drawMap(introK);
    if (game) drawGameLayer(now);

    if (fade) {
      const t = clamp((now - fade.start) / fade.dur, 0, 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1 - easeInOut(t);
      if (fadeCanvas && fadeCanvas.width === w && fadeCanvas.height === h) ctx.drawImage(fadeCanvas, 0, 0);
      ctx.globalAlpha = 1;
      if (t >= 1) fade = null;
    }
  }

  /** Planet radius in CSS pixels; ringed planets shrink a little so the rings fit. */
  function globeRadius() {
    const t = planet && planet.traits;
    // Ringed planets shrink so the rings stay inside the stage, clear of the panels.
    const r = t && t.rings ? Math.min(layout.baseR * 0.84, (layout.stageW * 0.5 - 8) / (t.ringOuter * 1.02)) : layout.baseR;
    return Math.max(40, r) * view.zoom;
  }

  function drawGlobe(introK, pulse) {
    const R = globeRadius() * (0.6 + 0.4 * introK) * pulse;
    const { cx, cy } = layout;
    const nowMs = performance.now();
    if (doom && doom.exploded) { drawAftermath(cx, cy, R, nowMs); return; }
    const N = clamp(Math.round((2 * R * dpr) / 16) * 16, 64, Math.round(qualityCap / 16) * 16);
    const buf = globeBuffer(N);
    const P = frameParams();
    const t0 = performance.now();
    shadeGlobe(buf.img.data, buf.size, N, P);
    buf.ctx.putImageData(buf.img, 0, 0, 0, 0, N, N);
    const dt = performance.now() - t0;
    shadeEma = shadeEma * 0.9 + dt * 0.1;

    ctx.globalAlpha = introK;
    drawHalo(ctx, cx, cy, R, P.atm, P.sun, 1);
    drawRings(ctx, cx, cy, R, false, 1);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(buf.canvas, 0, 0, N, N, cx - R, cy - R, R * 2, R * 2);
    if (doom) drawScars(ctx, cx, cy, R, nowMs - doom.start);
    if (game) drawCraters(ctx, cx, cy, R);
    drawRings(ctx, cx, cy, R, true, 1);
    ctx.globalAlpha = 1;
    if (doom) {
      drawMeteors(ctx, cx, cy, R, nowMs - doom.start);
      if (nowMs - doom.start >= T_EXPLODE) explode(R, buf, N, nowMs - doom.start);
    }
  }


  // ---------------------------------------------------------------------------
  // Meteor strike: meteors hit, the crust cracks, the planet shatters and its
  // molten core is exposed. Purely visual; "Rebuild" re-forms the same planet.
  // Coordinates below are in planet radii, x right and y down from the centre.
  // ---------------------------------------------------------------------------
  const T_EXPLODE = 2900;
  let doom = null, shardCanvas = null;
  const rnd = (a, b) => a + Math.random() * (b - a);

  function makeCracks(ix, iy) {
    const out = [];
    const n = 3 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) {
      let a = rnd(0, Math.PI * 2), x = ix, y = iy;
      const pts = [[x, y]];
      const segs = 6 + Math.floor(Math.random() * 7);
      for (let q = 0; q < segs; q++) {
        a += rnd(-0.55, 0.55);
        const len = rnd(0.05, 0.11), nx = x + Math.cos(a) * len, ny = y + Math.sin(a) * len;
        if (nx * nx + ny * ny > 0.95) break;
        x = nx; y = ny; pts.push([x, y]);
      }
      if (pts.length > 1) out.push(pts);
    }
    return out;
  }

  function startDoom() {
    if (!planet || !climate || builder) return;
    if (doom) { rebuildPlanet(); return; }
    if (state.view !== 'globe') setView('globe');
    setLapse(false);
    hideTip();
    const impacts = [];
    for (let i = 0; i < 5; i++) {
      const a = rnd(0, Math.PI * 2), r = Math.sqrt(rnd(0.01, 0.5));
      const x = Math.cos(a) * r, y = Math.sin(a) * r, from = rnd(-2.7, -0.45);
      impacts.push({ x, y, sx: x + Math.cos(from) * 2.6, sy: y + Math.sin(from) * 2.6, at: 700 + i * 280, size: rnd(0.8, 1.3), hit: false, cracks: makeCracks(x, y) });
    }
    const swirls = [];
    for (let i = 0; i < 26; i++) swirls.push({ r: rnd(0.6, 0.9), a: rnd(0, Math.PI * 2), len: rnd(0.3, 1.1), w: rnd(0.006, 0.02), light: Math.random() < 0.5 });
    doom = { start: performance.now(), impacts, swirls, exploded: false, explodeAt: 0, cracked: false, coreShown: false,
      shards: null, debris: null, shake: 0, model: null, coreGeom: null };
    view.vyaw = 0; view.vpitch = 0;
    setDoomUi(true);
    // On phones the button sits below the planet: bring the planet into view.
    if (window.innerWidth <= 980) {
      try { dom.stage.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); } catch (e) { dom.stage.scrollIntoView(); }
    }
    sfx('meteor');
    markInteracted();
  }

  function rebuildPlanet(silent) {
    if (!doom) return;
    doom = null; shardCanvas = null;
    document.body.classList.remove('doomed');
    setDoomUi(false);
    if (!silent) { introStart = reduceMotion ? -1 : performance.now(); sfx('rebuild'); }
    dirty = true;
  }

  function setDoomUi(on) {
    const el = $('tg-meteor');
    el.classList.toggle('on', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    $('tg-meteor-label').textContent = on ? 'Rebuild planet' : 'Meteor strike';
  }

  function stepDoom(now) {
    if (!doom) return;
    const t = now - doom.start;
    doom.impacts.forEach((m) => {
      if (!m.hit && t >= m.at) { m.hit = true; doom.shake = Math.max(doom.shake, 7 * m.size); sfx('impact'); }
    });
    if (!doom.cracked && t >= doom.impacts[doom.impacts.length - 1].at + 200) { doom.cracked = true; sfx('crack'); }
    if (doom.exploded && !doom.coreShown && now - doom.explodeAt > 1100) {
      doom.coreShown = true;
      document.body.classList.add('doomed');
      sfx('core');
      const m = coreModel();
      if (!doom.fromGame) toast('Planet destroyed. Its ' + m.comp + ' core burns at ' + m.innerTemp.toLocaleString('en-US') + ' °C. Hover the layers, move the sliders, or rebuild (K).', 5200);
    }
  }

  /** Craters, shockwaves, flashes and glowing cracks, clipped to the disc. */
  function drawScars(g, cx, cy, R, t) {
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    // The crust heats up as the cracks spread.
    const heat = clamp((t - 1500) / (T_EXPLODE - 1500), 0, 1);
    if (heat > 0) {
      const hg = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
      hg.addColorStop(0, 'rgba(255,120,40,' + (0.32 * heat) + ')');
      hg.addColorStop(1, 'rgba(160,30,10,' + (0.45 * heat) + ')');
      g.fillStyle = hg; g.fillRect(cx - R, cy - R, R * 2, R * 2);
    }
    const lw = Math.max(1, R / 240);
    doom.impacts.forEach((m) => {
      const dt = t - m.at;
      if (dt < 0) return;
      const px = cx + m.x * R, py = cy + m.y * R;
      // Cracks grow outward from the crater.
      const grow = clamp((dt - 80) / 1500, 0, 1);
      if (grow > 0) {
        m.cracks.forEach((pts) => {
          const upto = grow * (pts.length - 1);
          g.beginPath();
          g.moveTo(cx + pts[0][0] * R, cy + pts[0][1] * R);
          for (let i = 1; i <= Math.ceil(upto); i++) {
            const f = Math.min(1, upto - (i - 1));
            const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, y = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f;
            g.lineTo(cx + x * R, cy + y * R);
          }
          g.lineCap = 'round'; g.lineJoin = 'round';
          g.strokeStyle = 'rgba(255,90,25,0.55)'; g.lineWidth = lw * 5; g.stroke();
          g.strokeStyle = 'rgba(255,214,140,0.95)'; g.lineWidth = lw * 1.7; g.stroke();
        });
      }
      // Crater
      const rc = R * 0.075 * m.size;
      const cg = g.createRadialGradient(px, py, 0, px, py, rc * 1.6);
      cg.addColorStop(0, 'rgba(255,245,200,0.95)');
      cg.addColorStop(0.22, 'rgba(255,150,50,0.9)');
      cg.addColorStop(0.55, 'rgba(120,30,12,0.75)');
      cg.addColorStop(1, 'rgba(20,8,5,0)');
      g.fillStyle = cg; g.beginPath(); g.arc(px, py, rc * 1.6, 0, Math.PI * 2); g.fill();
      // Shockwave
      if (dt < 800) {
        const k = dt / 800;
        g.strokeStyle = 'rgba(255,225,180,' + ((1 - k) * 0.8) + ')';
        g.lineWidth = lw * 3 * (1 - k) + 0.5;
        g.beginPath(); g.arc(px, py, R * (0.05 + k * 0.5) * m.size, 0, Math.PI * 2); g.stroke();
      }
      // Flash
      if (dt < 320) {
        const k = dt / 320, fr = R * 0.4 * m.size;
        const fg = g.createRadialGradient(px, py, 0, px, py, fr);
        fg.addColorStop(0, 'rgba(255,255,240,' + (1 - k) + ')');
        fg.addColorStop(1, 'rgba(255,200,120,0)');
        g.fillStyle = fg; g.beginPath(); g.arc(px, py, fr, 0, Math.PI * 2); g.fill();
      }
    });
    g.restore();
  }

  function drawMeteors(g, cx, cy, R, t) {
    doom.impacts.forEach((m) => {
      const k0 = (t - (m.at - 750)) / 750;
      if (k0 < 0 || k0 >= 1) return;
      const k = k0 * k0;
      const x = cx + (m.sx + (m.x - m.sx) * k) * R, y = cy + (m.sy + (m.y - m.sy) * k) * R;
      const dx = m.x - m.sx, dy = m.y - m.sy, dl = Math.hypot(dx, dy) || 1;
      const tail = R * (0.35 + 0.35 * k), hr = R * 0.03 * m.size;
      const tx = x - (dx / dl) * tail, ty = y - (dy / dl) * tail;
      const tg = g.createLinearGradient(x, y, tx, ty);
      tg.addColorStop(0, 'rgba(255,240,205,0.95)');
      tg.addColorStop(0.35, 'rgba(255,140,60,0.55)');
      tg.addColorStop(1, 'rgba(200,60,30,0)');
      g.strokeStyle = tg; g.lineWidth = hr * 1.7; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x, y); g.lineTo(tx, ty); g.stroke();
      const hg = g.createRadialGradient(x, y, 0, x, y, hr * 3);
      hg.addColorStop(0, 'rgba(255,255,240,1)');
      hg.addColorStop(0.3, 'rgba(255,200,120,0.8)');
      hg.addColorStop(1, 'rgba(255,120,40,0)');
      g.fillStyle = hg; g.beginPath(); g.arc(x, y, hr * 3, 0, Math.PI * 2); g.fill();
    });
  }

  function explode(R, buf, N, t) {
    const S = Math.max(64, Math.round(2 * R * dpr));
    shardCanvas = document.createElement('canvas');
    shardCanvas.width = shardCanvas.height = S;
    const g = shardCanvas.getContext('2d');
    g.drawImage(buf.canvas, 0, 0, N, N, 0, 0, S, S);
    g.setTransform(S / (2 * R), 0, 0, S / (2 * R), 0, 0);
    drawScars(g, R, R, R, t);
    // Shards: wedges sharing jagged edges, so the planet splits cleanly.
    const K = 12, angles = [];
    for (let k = 0; k < K; k++) angles.push((k + rnd(-0.3, 0.3)) / K * Math.PI * 2);
    const edges = angles.map((a) => [0.32, 0.62, 0.86].map((r) => {
      const j = rnd(-0.07, 0.07);
      return [Math.cos(a + j) * r, Math.sin(a + j) * r];
    }));
    const shards = [];
    for (let k = 0; k < K; k++) {
      const a0 = angles[k], a1 = k + 1 < K ? angles[k + 1] : angles[0] + Math.PI * 2;
      const poly = [[0, 0]].concat(edges[k]);
      for (let i = 0; i <= 6; i++) { const a = a0 + (a1 - a0) * i / 6; poly.push([Math.cos(a) * 1.01, Math.sin(a) * 1.01]); }
      poly.push(...edges[(k + 1) % K].slice().reverse());
      const mid = (a0 + a1) / 2;
      let gx = 0, gy = 0; poly.forEach((p) => { gx += p[0]; gy += p[1]; }); gx /= poly.length; gy /= poly.length;
      shards.push({ poly, gx, gy, dx: Math.cos(mid), dy: Math.sin(mid), speed: rnd(0.9, 1.7), spin: rnd(-1.3, 1.3) });
    }
    const debris = [];
    for (let i = 0; i < 110; i++) {
      const a = rnd(0, Math.PI * 2), ember = Math.random() < 0.45;
      debris.push({ x: Math.cos(a) * rnd(0.1, 0.9), y: Math.sin(a) * rnd(0.1, 0.9), vx: Math.cos(a) * rnd(0.3, 2.1), vy: Math.sin(a) * rnd(0.3, 2.1),
        size: rnd(0.005, 0.02), ember, life: rnd(1.2, 2.6),
        color: ember ? (Math.random() < 0.5 ? '255,170,70' : '255,100,40') : (Math.random() < 0.5 ? '120,104,90' : '84,72,64') });
    }
    doom.shards = shards; doom.debris = debris;
    doom.exploded = true; doom.explodeAt = performance.now();
    doom.shake = 20;
    sfx('explode');
  }

  /**
   * The core is a function of the world: its proportions and composition come
   * from the seed, and it reacts live to the climate. Temperature heats it,
   * terrain thickens and roughens the crust, water and ice add surface layers,
   * exotic flora means an exotic core, and a ringed planet keeps a debris ring.
   */
  const COMPOSITIONS = ['iron-nickel', 'iron-sulfur', 'iron-silicate', 'nickel-cobalt'];
  function coreModel() {
    const r = Terra.mulberry32((planet.hash ^ 0xc0ffee) >>> 0);
    const st = climate.stats, t = planet.traits;
    const radiusKm = Math.round(3200 + r() * 4600);
    const inner = 0.17 + r() * 0.13;
    const outer = inner + 0.17 + r() * 0.12;
    const crust = 0.022 + (state.terrain / 100) * 0.05;                    // rugged worlds, thick crust
    const exotic = t.flora !== 'Green';
    const comp = exotic ? 'crystalline ' + t.flora.replace('Exotic ', '') : COMPOSITIONS[Math.floor(r() * COMPOSITIONS.length)];
    const seedHeat = 4300 + r() * 1500;
    const innerTemp = Math.round(seedHeat + state.temp * 22 + st.avgTemp * 4);
    const mantleTemp = Math.round(innerTemp * 0.52 + state.temp * 9);
    const heat = clamp((innerTemp - 3600) / 3400, 0, 1);                   // 0 = cold core, 1 = blazing
    const hueShift = exotic ? t.floraShift * 0.25 : 0;
    return {
      radiusKm, inner, outer, crust, comp, exotic, innerTemp, mantleTemp, heat, hueShift,
      ocean: st.waterFrac > 0.005 ? 0.006 + st.waterFrac * 0.022 : 0,       // ocean shell thickness
      ice: st.iceFrac > 0.05 ? 0.004 + st.iceFrac * 0.016 : 0,
      jag: 0.004 + (state.terrain / 100) * 0.018,                           // crust roughness
      rings: !!t.rings, ringColor: t.ringColor,
      crustKm: Math.round(radiusKm * crust * 2.4),
      mantleKm: Math.round(radiusKm * (1 - crust - outer)),
      outerKm: Math.round(radiusKm * (outer - inner)),
      innerKm: Math.round(radiusKm * inner),
    };
  }

  function mixRgb(a, b, k) { return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * k) + ',' + Math.round(a[1] + (b[1] - a[1]) * k) + ',' + Math.round(a[2] + (b[2] - a[2]) * k) + ')'; }
  function tint(c, deg) {
    if (!deg) return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
    const hsl = (function (r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s2 = 0; const l = (mx + mn) / 2; if (mx !== mn) { const d = mx - mn; s2 = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; } return [h, s2, l]; })(c[0], c[1], c[2]);
    return 'hsl(' + ((hsl[0] + deg) % 360 + 360) % 360 + ',' + Math.round(hsl[1] * 100) + '%,' + Math.round(hsl[2] * 100) + '%)';
  }

  /** Layer bands (fractions of the planet radius), outermost first. */
  function coreLayers(m) {
    const fmt = (n) => n.toLocaleString('en-US');
    const layers = [];
    if (m.ice) layers.push({ name: 'Ice shell', detail: 'frozen seas', r0: 1, r1: 1 - m.ice, depth: '0–' + fmt(Math.round(m.radiusKm * m.ice * 3)) + ' km', temp: '−20 °C', comp: 'water ice' });
    if (m.ocean) layers.push({ name: 'Ocean', detail: 'boiled away', r0: 1 - m.ice, r1: 1 - m.ice - m.ocean, depth: '0–' + fmt(Math.round(m.radiusKm * m.ocean * 2)) + ' km', temp: '—', comp: 'salt water' });
    const top = 1 - m.ice - m.ocean;
    layers.push({ name: 'Crust', detail: fmt(m.crustKm) + ' km thick', r0: top, r1: top - m.crust, depth: '0–' + fmt(m.crustKm) + ' km', temp: '200–900 °C', comp: 'basalt and granite' });
    layers.push({ name: 'Mantle', detail: 'molten · ' + fmt(m.mantleTemp) + ' °C', r0: top - m.crust, r1: m.outer, depth: fmt(m.crustKm) + '–' + fmt(m.crustKm + m.mantleKm) + ' km', temp: fmt(m.mantleTemp) + ' °C', comp: 'molten silicate rock' });
    layers.push({ name: 'Outer core', detail: 'liquid metal', r0: m.outer, r1: m.inner, depth: fmt(m.outerKm) + ' km thick', temp: fmt(Math.round(m.innerTemp * 0.82)) + ' °C', comp: 'liquid ' + m.comp });
    layers.push({ name: 'Inner core', detail: 'solid · ' + fmt(m.innerTemp) + ' °C', r0: m.inner, r1: 0, depth: fmt(m.innerKm) + ' km radius', temp: fmt(m.innerTemp) + ' °C', comp: 'solid ' + m.comp });
    return layers;
  }

  function drawCore(g, cx, cy, R, te, now) {
    const m = coreModel();
    doom.model = m;
    const layers = coreLayers(m);
    const font = getComputedStyle(document.body).fontFamily;
    // Labels sit beside the core when there is room inside the stage, otherwise inside it.
    g.save(); let lw = 0;
    layers.forEach((L) => { g.font = '600 14px ' + font; lw = Math.max(lw, g.measureText(L.name).width); g.font = '400 12px ' + font; lw = Math.max(lw, g.measureText(L.detail).width); });
    g.restore();
    const half = layout.stageW / 2 - 8;
    const fit = (half - lw - 30) / 1.15;
    const side = fit >= R * 0.55;
    const target = side ? Math.min(R, fit) : R * 0.9;
    const grow = easeOut(clamp(te / 1.4, 0, 1));
    const pulse = 1 + 0.035 * Math.sin(now * (0.0025 + m.heat * 0.004));   // hotter cores throb faster
    const rr = (R + (target - R) * grow) * (0.8 + 0.2 * grow);
    doom.coreGeom = { cx, cy, rr };

    // Heat halo grows with the core temperature.
    const halo = g.createRadialGradient(cx, cy, rr * 0.8, cx, cy, rr * (1.4 + m.heat * 0.5));
    halo.addColorStop(0, 'rgba(255,' + Math.round(90 + m.heat * 60) + ',40,' + (0.25 + m.heat * 0.2) + ')');
    halo.addColorStop(1, 'rgba(255,90,30,0)');
    g.fillStyle = halo; g.beginPath(); g.arc(cx, cy, rr * 1.9, 0, Math.PI * 2); g.fill();

    // Debris ring for ringed worlds.
    if (m.rings) {
      g.save(); g.translate(cx, cy); g.scale(1, 0.28); g.rotate(now * 0.00004);
      const rc = m.ringColor;
      for (let i = 0; i < 70; i++) {
        const a = i * 2.39996, d = rr * (1.35 + ((i * 37) % 29) / 29 * 0.45);
        g.fillStyle = 'rgba(' + rc[0] + ',' + rc[1] + ',' + rc[2] + ',0.55)';
        g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, 1.2 + (i % 3), 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }

    // Surface shells (ice, ocean) as thin rims.
    let r0 = 1;
    if (m.ice) { g.fillStyle = 'rgba(214,232,246,0.9)'; g.beginPath(); g.arc(cx, cy, rr * r0, 0, Math.PI * 2); g.fill(); r0 -= m.ice; }
    if (m.ocean) { g.fillStyle = 'rgba(40,96,160,0.95)'; g.beginPath(); g.arc(cx, cy, rr * r0, 0, Math.PI * 2); g.fill(); r0 -= m.ocean; }
    // Crust: jagged edge, rougher with more terrain variation.
    g.fillStyle = '#2d211b';
    g.beginPath();
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const j = Math.sin(a * 7 + planet.hash % 13) * 0.5 + Math.sin(a * 17 + (planet.hash >>> 4) % 11) * 0.5;
      const rad = rr * (r0 - m.jag * (0.5 + 0.5 * j));
      if (i) g.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); else g.moveTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
    }
    g.closePath(); g.fill();
    // Mantle: deep red when cool, orange-gold when hot; exotic worlds shift hue.
    const mantleR = rr * (r0 - m.crust);
    const mg = g.createRadialGradient(cx, cy, rr * m.outer, cx, cy, mantleR);
    mg.addColorStop(0, tint([255, Math.round(110 + m.heat * 60), 40], m.hueShift));
    mg.addColorStop(0.6, tint([Math.round(190 + m.heat * 40), Math.round(50 + m.heat * 40), 22], m.hueShift));
    mg.addColorStop(1, tint([Math.round(100 + m.heat * 30), 22, 14], m.hueShift));
    g.fillStyle = mg; g.beginPath(); g.arc(cx, cy, mantleR, 0, Math.PI * 2); g.fill();
    // Convection currents speed up with heat.
    g.save(); g.lineCap = 'round';
    doom.swirls.forEach((w) => {
      const rad = rr * (m.outer + (r0 - m.crust - m.outer) * ((w.r - 0.6) / 0.3));
      const a = w.a + te * (0.1 + m.heat * 0.25) * (w.light ? 1 : -1);
      g.strokeStyle = w.light ? 'rgba(255,200,120,0.33)' : 'rgba(90,15,8,0.35)';
      g.lineWidth = Math.max(1, rr * w.w);
      g.beginPath(); g.arc(cx, cy, Math.max(2, rad), a, a + w.len); g.stroke();
    });
    g.restore();
    // Outer core
    const og = g.createRadialGradient(cx, cy, rr * m.inner * 0.8, cx, cy, rr * m.outer);
    og.addColorStop(0, tint([255, 228, Math.round(120 + m.heat * 60)], m.hueShift));
    og.addColorStop(1, tint([255, Math.round(130 + m.heat * 40), 30], m.hueShift));
    g.fillStyle = og; g.beginPath(); g.arc(cx, cy, rr * m.outer, 0, Math.PI * 2); g.fill();
    // Inner core: whiter and brighter the hotter it is.
    const ir = rr * m.inner * 1.55 * pulse;
    const ig = g.createRadialGradient(cx, cy, 0, cx, cy, ir);
    ig.addColorStop(0, 'rgba(255,255,255,1)');
    ig.addColorStop(0.4, mixRgb([255, 214, 150], [255, 250, 232], m.heat));
    ig.addColorStop(0.65, 'rgba(255,200,110,' + (0.45 + m.heat * 0.3) + ')');
    ig.addColorStop(1, 'rgba(255,160,60,0)');
    g.fillStyle = ig; g.beginPath(); g.arc(cx, cy, ir, 0, Math.PI * 2); g.fill();

    const la = clamp((te - 1.2) / 0.6, 0, 1);
    if (la <= 0) return;
    g.save();
    g.globalAlpha = la;
    if (side) {
      // Leader lines to a label column on the right.
      const lx = cx + rr * 1.15, n = layers.length, spacing = Math.min(46, (rr * 1.9) / n);
      layers.forEach((L, i) => {
        const mid = (L.r0 + L.r1) / 2;
        const ang = -0.95 + (i / Math.max(1, n - 1)) * 1.6;
        const ex = cx + Math.cos(ang) * rr * Math.max(0.05, mid), ey = cy + Math.sin(ang) * rr * Math.max(0.05, mid);
        const ly = cy - ((n - 1) / 2) * spacing + i * spacing;
        g.strokeStyle = 'rgba(236,233,224,0.5)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(ex, ey); g.lineTo(lx - 12, ly); g.lineTo(lx, ly); g.stroke();
        g.fillStyle = '#ecebe4'; g.beginPath(); g.arc(ex, ey, 2.5, 0, Math.PI * 2); g.fill();
        g.textAlign = 'left';
        g.font = '600 14px ' + font; g.fillText(L.name, lx + 8, ly - 2);
        g.fillStyle = '#a3a197'; g.font = '400 12px ' + font; g.fillText(L.detail, lx + 8, ly + 14);
      });
    } else {
      // Small screens: names written inside their own band, along the top.
      g.textAlign = 'center';
      g.font = '600 ' + Math.max(10, Math.round(rr / 14)) + 'px ' + font;
      layers.forEach((L) => {
        const band = (L.r0 - L.r1) * rr;
        if (band < 11 && L.r1 > 0) return;
        const yy = L.r1 > 0 ? cy - rr * (L.r0 + L.r1) / 2 + 4 : cy + 4;
        g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(L.name, cx + 1, yy + 1);
        g.fillStyle = L.r1 === 0 ? '#5a2a08' : '#fff6e6'; g.fillText(L.name, cx, yy);
      });
    }
    g.restore();
  }

  /** Which core layer is under the pointer (null if none). */
  function coreLayerAt(clientX, clientY) {
    if (!doom || !doom.coreShown || !doom.coreGeom || !doom.model) return null;
    const rect = dom.canvas.getBoundingClientRect();
    const { cx, cy, rr } = doom.coreGeom;
    const d = Math.hypot(clientX - rect.left - cx, clientY - rect.top - cy) / rr;
    if (d > 1) return null;
    const layers = coreLayers(doom.model);
    for (let i = layers.length - 1; i >= 0; i--) if (d <= layers[i].r0) return layers[i];
    return null;
  }

  function drawAftermath(cx, cy, R, now) {
    const te = (now - doom.explodeAt) / 1000;
    if (te < 0.9) {
      ctx.globalAlpha = 1 - te / 0.9;
      drawRings(ctx, cx, cy, R, false, 1);
      drawRings(ctx, cx, cy, R, true, 1);
      ctx.globalAlpha = 1;
    }
    drawCore(ctx, cx, cy, R, te, now);
    // Shards fly apart, tumble and fade.
    const dist = R * 1.7 * (1 - Math.exp(-te * 1.4));
    doom.shards.forEach((sh) => {
      const alpha = clamp(1 - (te - 0.8) / 1.4, 0, 1);
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const ox = cx + sh.dx * dist * sh.speed, oy = cy + sh.dy * dist * sh.speed;
      ctx.translate(ox + sh.gx * R, oy + sh.gy * R);
      ctx.rotate(sh.spin * te);
      ctx.translate(-sh.gx * R, -sh.gy * R);
      ctx.beginPath();
      sh.poly.forEach((p, i) => { if (i) ctx.lineTo(p[0] * R, p[1] * R); else ctx.moveTo(p[0] * R, p[1] * R); });
      ctx.closePath();
      ctx.save(); ctx.clip();
      ctx.drawImage(shardCanvas, -R, -R, R * 2, R * 2);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,120,45,0.9)'; ctx.lineWidth = Math.max(1, R / 200); ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    });
    // Debris and embers
    doom.debris.forEach((d) => {
      if (te > d.life) return;
      const a = 1 - te / d.life;
      const x = cx + (d.x + d.vx * te) * R, y = cy + (d.y + d.vy * te) * R;
      ctx.fillStyle = 'rgba(' + d.color + ',' + a + ')';
      ctx.beginPath(); ctx.arc(x, y, Math.max(0.8, d.size * R), 0, Math.PI * 2); ctx.fill();
    });
    // Blast flash
    if (te < 0.7) {
      const k = te / 0.7;
      const fg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (1 + k * 1.5));
      fg.addColorStop(0, 'rgba(255,250,230,' + (0.9 * (1 - k)) + ')');
      fg.addColorStop(0.5, 'rgba(255,170,80,' + (0.5 * (1 - k)) + ')');
      fg.addColorStop(1, 'rgba(255,100,40,0)');
      ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(cx, cy, R * (1 + k * 1.5), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,220,170,' + (0.7 * (1 - k)) + ')';
      ctx.lineWidth = 3 * (1 - k) + 0.5;
      ctx.beginPath(); ctx.arc(cx, cy, R * (1.05 + k * 1.8), 0, Math.PI * 2); ctx.stroke();
    }
  }

  // One reusable offscreen buffer for the globe; cleared when its size changes.
  const gbuf = { size: 0, n: 0, canvas: null, ctx: null, img: null };
  function globeBuffer(N) {
    if (gbuf.size < N) {
      gbuf.size = Math.max(N, 800);
      gbuf.canvas = document.createElement('canvas');
      gbuf.canvas.width = gbuf.canvas.height = gbuf.size;
      gbuf.ctx = gbuf.canvas.getContext('2d');
      gbuf.img = gbuf.ctx.createImageData(gbuf.size, gbuf.size);
      gbuf.n = 0;
    }
    if (gbuf.n !== N) {
      const d = gbuf.img.data, rowBytes = gbuf.size * 4, used = Math.max(N, gbuf.n);
      for (let y = 0; y < used; y++) d.fill(0, y * rowBytes, y * rowBytes + used * 4);
      gbuf.n = N;
    }
    return gbuf;
  }

  function drawMap(introK) {
    shadeMap();
    const m = layout.map;
    ctx.save();
    ctx.globalAlpha = introK;
    roundRect(ctx, m.x, m.y, m.w, m.h, 16);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const off = ((view.mapPan % 1) + 1) % 1 * m.w;
    ctx.drawImage(mapCanvas, m.x + off - m.w, m.y, m.w, m.h);
    ctx.drawImage(mapCanvas, m.x + off, m.y, m.w, m.h);

    if (state.grid) {
      ctx.strokeStyle = 'rgba(110,231,255,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let lat = -60; lat <= 60; lat += 30) {
        const y = m.y + (0.5 - lat / 180) * m.h;
        ctx.moveTo(m.x, y); ctx.lineTo(m.x + m.w, y);
      }
      for (let lon = -180; lon < 180; lon += 30) {
        let x = m.x + ((((lon + 180) / 360 + view.mapPan) % 1) + 1) % 1 * m.w;
        ctx.moveTo(x, m.y); ctx.lineTo(x, m.y + m.h);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(110,231,255,0.5)';
      ctx.beginPath(); ctx.moveTo(m.x, m.y + m.h / 2); ctx.lineTo(m.x + m.w, m.y + m.h / 2); ctx.stroke();
    }

    // Subsolar point.
    const s = sunPlanet();
    const slon = Math.atan2(s[0], s[2]), slat = Math.asin(clamp(s[1], -1, 1));
    const sxp = m.x + ((((slon * INV_2PI + 0.5) + view.mapPan) % 1) + 1) % 1 * m.w;
    const syp = m.y + (0.5 - slat * INV_PI) * m.h;
    const glow = ctx.createRadialGradient(sxp, syp, 0, sxp, syp, 26);
    glow.addColorStop(0, 'rgba(255,236,170,0.95)');
    glow.addColorStop(0.25, 'rgba(255,210,120,0.45)');
    glow.addColorStop(1, 'rgba(255,200,100,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(sxp, syp, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff8dc';
    ctx.beginPath(); ctx.arc(sxp, syp, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, m.x + 0.5, m.y + 0.5, m.w - 1, m.h - 1, 16);
    ctx.strokeStyle = 'rgba(150,175,255,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // ---------------------------------------------------------------------------
  // Planet lifecycle
  // ---------------------------------------------------------------------------
  function requestSeed(raw) {
    const seed = Terra.normalizeSeed(raw);
    if (!seed) return false;
    state.seed = seed;
    scheduleHash();
    if (builder && builder.seed === seed) return true;
    if (!builder && planet && planet.seed === seed) return true;
    builder = Terra.planetBuilder(seed, { width: TEX_W });
    dom.forming.classList.add('show');
    dom.formingText.textContent = 'Forming planet…';
    setFormingProgress(0);
    return true;
  }

  function setFormingProgress(p) {
    dom.formingBar.style.strokeDashoffset = String(94.25 * (1 - clamp(p, 0, 1)));
  }

  function stepBuilder() {
    if (!builder) return;
    const done = builder.step(BUILD_BUDGET_MS);
    setFormingProgress(builder.progress);
    if (!done) return;
    const p = builder.result;
    builder = null;
    dom.forming.classList.remove('show');
    adoptPlanet(p);
  }

  function adoptPlanet(p) {
    if (doom) rebuildPlanet(true);
    const first = !planet;
    if (!first) snapshotForFade();
    planet = p;
    climate = Terra.applyClimate(planet, state, climate);
    climateDirty = false;
    if (first) introStart = reduceMotion ? -1 : performance.now();
    updateIdentity();
    pickMission();
    updateCard(true);
    if (audio) audio.planet(planet.hash, state.temp, state.water);
    if (!first) sfx('planet');
    document.title = planet.name + ' · Tiny Terra';
    dirty = true;
  }

  function recomputeClimate() {
    if (!planet) return;
    climate = Terra.applyClimate(planet, state, climate);
    climateDirty = false;
    statsDirty = true;
    dirty = true;
    if (audio) audio.climate(state.temp, state.water);
  }

  // ---------------------------------------------------------------------------
  // ID card
  // ---------------------------------------------------------------------------
  const numState = new Map(); // element → {from, to, start, dur, decimals}
  function setNumber(el, value, decimals, animate) {
    const v = Number.isFinite(value) ? value : 0;
    const prev = numState.get(el);
    const cur = prev ? prev.cur : 0;
    if (!animate || reduceMotion || cur === v) {
      numState.set(el, { cur: v, from: v, to: v, start: 0, dur: 0, decimals });
      el.textContent = formatNum(v, decimals);
      return;
    }
    numState.set(el, { cur, from: cur, to: v, start: performance.now(), dur: 700, decimals });
  }
  function formatNum(v, decimals) {
    if (decimals === 'peak') return Math.round(v).toLocaleString('en-US');
    if (decimals === 'signed') { const r = Math.round(v); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r); }
    return String(Math.round(v));
  }
  function stepNumbers(now) {
    numState.forEach((s, el) => {
      if (s.dur === 0 || s.cur === s.to) return;
      const t = clamp((now - s.start) / s.dur, 0, 1);
      s.cur = t >= 1 ? s.to : s.from + (s.to - s.from) * easeOut(t);
      el.textContent = formatNum(s.cur, s.decimals);
    });
  }

  const SCRAMBLE = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let scrambleJob = null;
  function scrambleTo(el, text) {
    if (reduceMotion) { el.textContent = text; return; }
    scrambleJob = { el, text, start: performance.now(), dur: 650 };
  }
  function stepScramble(now) {
    if (!scrambleJob) return;
    const { el, text, start, dur } = scrambleJob;
    const t = clamp((now - start) / dur, 0, 1);
    const shown = Math.floor(text.length * t);
    let out = text.slice(0, shown);
    for (let i = shown; i < text.length; i++) out += SCRAMBLE.charAt(Math.floor(Math.random() * SCRAMBLE.length));
    el.textContent = t >= 1 ? text : out;
    if (t >= 1) scrambleJob = null;
  }

  function updateIdentity() {
    scrambleTo(dom.pName, planet.name);
    dom.pDesignation.textContent = planet.designation;
  }

  function biomeCss(id) {
    const c = planet ? planet.palette[id] : Terra.BIOMES[id].color;
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  function updateCard(animate) {
    if (!climate) return;
    const st = climate.stats;
    dom.pClass.textContent = st.className;
    dom.habValue.style.strokeDashoffset = String(314.16 * (1 - st.habitability / 100));
    setNumber(dom.habNum, st.habitability, 0, animate);
    dom.habVerdict.textContent = st.habLabel;
    const lava = st.frac[Terra.BIOME.SCORCHED] > 0.05;
    dom.habLife.classList.toggle('yes', st.civilization || lava);
    dom.lifeText.textContent = st.civilization ? 'Civilization detected' : lava ? 'Volcanic activity' : 'No signs of life';

    dom.habTraits.textContent = '';
    const traits = [];
    if (planet.traits.rings) traits.push('Ringed');
    if (planet.traits.flora !== 'Green') traits.push(planet.traits.flora.replace('Exotic ', '') + ' flora');
    if (st.iceFrac > 0.4) traits.push('Glaciated');
    if (st.waterFrac > 0.85) traits.push('Waterworld');
    traits.slice(0, 3).forEach((t) => {
      const s = document.createElement('span');
      s.className = 'trait'; s.textContent = t;
      dom.habTraits.appendChild(s);
    });

    setNumber(dom.stWater, st.waterFrac * 100, 0, animate);
    setNumber(dom.stLand, st.landFrac * 100, 0, animate);
    setNumber(dom.stIce, st.iceFrac * 100, 0, animate);
    setNumber(dom.stTemp, st.avgTemp, 'signed', animate);
    if (st.hasLand) {
      setNumber(dom.stPeak, st.peak, 'peak', animate);
      dom.stPeakUnit.textContent = 'm';
    } else {
      numState.delete(dom.stPeak);
      dom.stPeak.textContent = 'No land';
      dom.stPeakUnit.textContent = '';
    }

    // Surface bar + legend
    const top = st.topBiomes;
    dom.biomeBar.textContent = '';
    top.forEach((b) => {
      const s = document.createElement('span');
      s.style.width = (b.f * 100).toFixed(2) + '%';
      s.style.backgroundColor = biomeCss(b.id);
      s.title = Terra.BIOMES[b.id].name + ' ' + (b.f * 100).toFixed(1) + '%';
      dom.biomeBar.appendChild(s);
    });
    dom.biomeBar.setAttribute('aria-label', 'Surface: ' + top.slice(0, 5).map((b) => Terra.BIOMES[b.id].name + ' ' + Math.round(b.f * 100) + '%').join(', '));
    dom.biomeLegend.textContent = '';
    top.slice(0, 8).forEach((b) => {
      const li = document.createElement('li');
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.backgroundColor = biomeCss(b.id);
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = Terra.BIOMES[b.id].name;
      const pc = document.createElement('span'); pc.className = 'pc';
      pc.textContent = b.f < 0.01 ? '<1%' : Math.round(b.f * 100) + '%';
      li.append(sw, nm, pc);
      dom.biomeLegend.appendChild(li);
    });

    dom.pNote.textContent = st.note;
    dom.canvas.setAttribute('aria-label', planet.name + ', ' + st.className + '. ' +
      Math.round(st.waterFrac * 100) + '% ocean, average ' + Math.round(st.avgTemp) + ' °C, habitability ' +
      st.habitability + ' of 100.');
    lastStatsAt = performance.now();
    statsDirty = false;
    updateMission();
  }

  // ---------------------------------------------------------------------------
  // Missions: each planet gets one challenge, picked from its seed.
  // ---------------------------------------------------------------------------
  const B = Terra.BIOME;
  const MISSIONS = [
    { text: 'Make it a Paradise: habitability 85+', p: (s) => s.habitability / 85 },
    { text: 'Freeze a third of the surface', p: (s) => s.iceFrac / 0.33 },
    { text: 'Turn 40% of it into desert', p: (s) => (s.frac[B.DESERT] + s.frac[B.SCORCHED]) / 0.4 },
    { text: 'Drown it: 90% ocean', p: (s) => s.waterFrac / 0.9 },
    { text: 'Grow rainforest over 5% of the planet', p: (s) => s.frac[B.RAINFOREST] / 0.05 },
    { text: 'Heat it to a +40 °C surface average', p: (s) => (s.avgTemp + 30) / 70 },
    { text: 'Raise mountains over 5% of the planet', p: (s) => s.frac[B.MOUNTAIN] / 0.05 },
    { text: 'Light up the night: grow a civilization', p: (s) => (s.civilization ? 1 : Math.min(0.95, s.habitability / 35)) },
  ];
  let mission = null;

  // Stars: one per completed mission, three missions per planet (remembered on this device).
  const CHAIN = 3;
  const RANKS = [[0, 'Cadet'], [1, 'Explorer'], [4, 'Pioneer'], [9, 'Terraformer'], [15, 'World-shaper'], [25, 'Star-forger']];
  let earned = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem('tinyterra-stars') || '[]');
    earned = new Set((Array.isArray(raw) ? raw : [])
      .map((x) => (typeof x === 'number' ? x + ':0' : x))           // older saves: one star per planet
      .filter((x) => typeof x === 'string' && /^\d{1,10}:[0-2]$/.test(x)).slice(0, 15000));
  } catch (e) { earned = new Set(); }
  function rankFor(n) { let r = RANKS[0][1]; RANKS.forEach(([min, name]) => { if (n >= min) r = name; }); return r; }
  function renderStars(pop) {
    $('stars-count').textContent = String(earned.size);
    $('stars-rank').textContent = rankFor(earned.size);
    const el = $('stars');
    el.title = earned.size + ' star' + (earned.size === 1 ? '' : 's') + ' earned · rank ' + rankFor(earned.size);
    if (pop) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  }
  function awardStar(stage) {
    const key = planet.hash + ':' + stage;
    if (earned.has(key)) return false;
    const before = rankFor(earned.size);
    earned.add(key);
    try { localStorage.setItem('tinyterra-stars', JSON.stringify(Array.from(earned))); } catch (e) { /* private mode */ }
    renderStars(true);
    return rankFor(earned.size) !== before;
  }

  function confetti() {
    if (reduceMotion) return;
    const box = $('confetti'), r = missionEl.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const colors = ['#6ee7ff', '#34d399', '#facc15', '#fb7185', '#a78bfa', '#ffb86b'];
    for (let i = 0; i < 46; i++) {
      const p = document.createElement('i');
      const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * 220;
      p.style.left = cx + 'px'; p.style.top = cy + 'px';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--dx', (Math.cos(a) * d).toFixed(0) + 'px');
      p.style.setProperty('--dy', (Math.sin(a) * d * 0.7 + 160).toFixed(0) + 'px');
      p.style.setProperty('--rot', (Math.random() * 720 - 360).toFixed(0) + 'deg');
      p.style.animationDelay = (Math.random() * 0.12).toFixed(2) + 's';
      box.appendChild(p);
    }
    setTimeout(() => { box.textContent = ''; }, 1900);
  }
  const missionEl = $('mission'), missionText = $('mission-text'), missionPct = $('mission-pct'),
    missionFill = $('mission-fill'), missionLabel = $('mission-label');

  /**
   * Each planet has a fixed chain of 3 missions, chosen from its seed and
   * skipping any that its default climate already satisfies. Completing one
   * earns a star and unlocks the next; all three = world mastered.
   */
  let missionToken = 0;
  function pickMission() {
    const base = Terra.applyClimate(planet, Terra.DEFAULTS).stats;
    const n = MISSIONS.length, start = (planet.hash >>> 3) % n, stride = [1, 3, 5, 7][(planet.hash >>> 7) % 4];
    const chain = [];
    for (let k = 0; k < n && chain.length < CHAIN; k++) {
      const i = (start + k * stride) % n;
      if (MISSIONS[i].p(base) < 0.9) chain.push(i);
    }
    for (let k = 0; chain.length < CHAIN && k < n; k++) { const i = (start + k * stride) % n; if (!chain.includes(i)) chain.push(i); }
    let stage = 0;
    while (stage < CHAIN && earned.has(planet.hash + ':' + stage)) stage++; // resume where you left off
    mission = { chain, stage, done: false, lockUntil: performance.now() + 900, token: ++missionToken };
    missionEl.classList.remove('done', 'celebrate');
    showMissionStage();
  }

  function pips() {
    let out = '';
    for (let i = 0; i < CHAIN; i++) out += i < mission.stage || (i === mission.stage && mission.done) ? '★' : '☆';
    return out;
  }

  function showMissionStage() {
    if (mission.stage >= CHAIN) {
      missionEl.classList.add('done');
      missionLabel.textContent = 'World mastered';
      missionText.textContent = 'All 3 missions done. Roll a new planet (R)';
      missionEl.title = 'You completed every mission on this planet.';
      missionFill.style.width = '100%';
      missionPct.textContent = '★★★';
      return;
    }
    const m = MISSIONS[mission.chain[mission.stage]];
    missionEl.classList.remove('done');
    missionLabel.textContent = 'Mission ' + (mission.stage + 1) + '/' + CHAIN;
    missionText.textContent = m.text;
    missionEl.title = m.text;
  }

  function updateMission() {
    if (!mission || !climate || mission.stage >= CHAIN) return;
    const tok = mission.token;
    const raw = MISSIONS[mission.chain[mission.stage]].p(climate.stats);
    const p = clamp(Number.isFinite(raw) ? raw : 0, 0, 1);
    const shown = mission.done ? 1 : p;
    missionFill.style.width = (shown * 100).toFixed(1) + '%';
    missionPct.textContent = pips() + ' ' + Math.floor(shown * 100) + '%';
    if (mission.done || p < 1 || performance.now() < mission.lockUntil) {
      if (!mission.done && p >= 1) setTimeout(() => { if (mission && mission.token === tok) updateMission(); }, mission.lockUntil - performance.now() + 20);
      return;
    }
    mission.done = true;
    missionEl.classList.add('done');
    missionLabel.textContent = 'Complete ★';
    missionPct.textContent = pips() + ' 100%';
    missionEl.classList.remove('celebrate');
    void missionEl.offsetWidth;
    missionEl.classList.add('celebrate');
    sfx('chime');
    confetti();
    const promoted = awardStar(mission.stage);
    const last = mission.stage === CHAIN - 1;
    toast(promoted ? 'Mission complete! New rank: ' + rankFor(earned.size) + ' ★'
      : last ? 'World mastered! ★★★ Roll a new planet (R) for new missions.'
        : 'Mission complete! +1 star. Next mission unlocked…', 3000);
    setTimeout(() => {
      if (!mission || mission.token !== tok) return; // planet changed meanwhile
      mission.stage++;
      mission.done = false;
      mission.lockUntil = performance.now() + 900;
      showMissionStage();
      updateMission();
    }, 1700);
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  function syncSliders() {
    ['temp', 'water', 'terrain', 'speed'].forEach((k) => {
      const el = dom.sl[k];
      if (String(el.value) !== String(state[k])) el.value = state[k];
      const lim = Terra.LIMITS[k];
      el.style.setProperty('--p', ((state[k] - lim.min) / (lim.max - lim.min) * 100) + '%');
    });
    dom.out.temp.textContent = (state.temp > 0 ? '+' : state.temp < 0 ? '−' : '') + Math.abs(state.temp) + ' °C';
    dom.out.water.textContent = state.water + ' %';
    dom.out.terrain.textContent = String(state.terrain);
    dom.out.speed.textContent = state.speed === 0 ? 'Still' : state.speed + '×';
    updatePresetActive();
  }

  function onSlider(key) {
    const el = dom.sl[key];
    const lim = Terra.LIMITS[key];
    let v = Math.round(Number(el.value));
    if (!Number.isFinite(v)) v = lim.def;
    v = clamp(v, lim.min, lim.max);
    tween = null;
    if (key === 'temp') setLapse(false);
    if (state[key] === v) { syncSliders(); return; }
    state[key] = v;
    if (key !== 'speed') { climateDirty = true; scheduleHash(); }
    else updatePlayButton();
    sfx('tick');
    syncSliders();
    markInteracted();
  }

  function buildPresets() {
    Terra.PRESETS.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.dataset.id = p.id;
      b.title = p.name + ' (' + (i + 1) + '): ' + (p.temp > 0 ? '+' : '') + p.temp + ' °C, ' + p.water + '% water, terrain ' + p.terrain;
      const o = document.createElement('span');
      o.className = 'orb';
      const c = PRESET_ORBS[p.id] || ['#fff', '#888', '#222'];
      o.style.background = 'radial-gradient(circle at 32% 30%, ' + c[0] + ', ' + c[1] + ' 55%, ' + c[2] + ')';
      o.style.setProperty('--glow', c[1] + '66');
      const t = document.createElement('span');
      t.textContent = p.name;
      b.append(o, t);
      b.addEventListener('click', () => applyPreset(p));
      dom.presets.appendChild(b);
    });
  }

  /** X: put temperature, water, terrain and day speed back to their defaults. */
  function resetSliders() {
    const L = Terra.LIMITS;
    applyPreset({ temp: L.temp.def, water: L.water.def, terrain: L.terrain.def });
    if (state.speed !== L.speed.def) { state.speed = L.speed.def; syncSliders(); updatePlayButton(); scheduleHash(); }
    toast('Sliders reset to defaults');
  }

  function applyPreset(p) {
    markInteracted();
    setLapse(false);
    sfx('preset');
    if (reduceMotion) {
      state.temp = p.temp; state.water = p.water; state.terrain = p.terrain;
      climateDirty = true; syncSliders(); scheduleHash();
      return;
    }
    tween = {
      from: { temp: state.temp, water: state.water, terrain: state.terrain },
      to: { temp: p.temp, water: p.water, terrain: p.terrain },
      start: performance.now(), dur: 900,
    };
  }

  // Climate time-lapse: the temperature sweeps ice age -> hothouse -> ice age
  // (a triangle wave starting from the current value), so ice caps visibly
  // advance and retreat. Any manual temperature change stops it.
  const LAPSE_LO = -25, LAPSE_HI = 40, LAPSE_PERIOD = 16000;
  let lapse = null;
  function setLapse(on) {
    const was = !!lapse;
    if (on && !lapse) {
      tween = null;
      lapse = { start: performance.now(), from: state.temp };
      sfx('lapse');
      toast('Climate time-lapse: watch the ice caps grow and melt');
    } else if (!on && lapse) {
      lapse = null;
      scheduleHash();
      statsDirty = true;
    }
    const el = dom.tg.lapse;
    if (el) { el.classList.toggle('on', !!lapse); el.setAttribute('aria-pressed', lapse ? 'true' : 'false'); }
    if (was !== !!lapse) dirty = true;
  }
  function stepLapse(now) {
    if (!lapse) return;
    const span = LAPSE_HI - LAPSE_LO;
    const x0 = clamp((lapse.from - LAPSE_LO) / span, 0, 1);
    const p = ((1 - x0) / 2 + (now - lapse.start) / LAPSE_PERIOD) % 1;
    const x = p < 0.5 ? 1 - 2 * p : 2 * p - 1;
    const v = Math.round(LAPSE_LO + span * x);
    if (v !== state.temp) { state.temp = v; climateDirty = true; syncSliders(); }
  }

  function stepTween(now) {
    if (!tween) return;
    const t = clamp((now - tween.start) / tween.dur, 0, 1);
    const k = easeInOut(t);
    let changed = false;
    ['temp', 'water', 'terrain'].forEach((key) => {
      const v = Math.round(tween.from[key] + (tween.to[key] - tween.from[key]) * k);
      if (state[key] !== v) { state[key] = v; changed = true; }
    });
    if (changed) { climateDirty = true; syncSliders(); }
    if (t >= 1) { tween = null; scheduleHash(); statsDirty = true; }
  }

  function updatePresetActive() {
    dom.presets.querySelectorAll('.preset').forEach((b) => {
      const p = Terra.PRESETS.find((x) => x.id === b.dataset.id);
      const on = !!p && p.temp === state.temp && p.water === state.water && p.terrain === state.terrain;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function setToggle(key, on) {
    state[key] = !!on;
    const el = dom.tg[key];
    el.classList.toggle('on', state[key]);
    el.setAttribute('aria-pressed', state[key] ? 'true' : 'false');
    dirty = true;
    sfx(state[key] ? 'toggle' : 'off');
  }

  function setView(v) {
    if (doom && v === 'map') rebuildPlanet(true);
    if ((v === 'map' ? 'map' : 'globe') !== state.view) sfx('view');
    state.view = v === 'map' ? 'map' : 'globe';
    const isMap = state.view === 'map';
    dom.viewGlobe.classList.toggle('on', !isMap);
    dom.viewMap.classList.toggle('on', isMap);
    dom.viewGlobe.setAttribute('aria-checked', String(!isMap));
    dom.viewMap.setAttribute('aria-checked', String(isMap));
    positionGlider();
    dom.zoomIn.disabled = isMap;
    dom.zoomOut.disabled = isMap;
    hideTip();
    scheduleHash();
    dirty = true;
  }
  function positionGlider() {
    const g = dom.viewGlobe.parentElement.querySelector('.switch-glider');
    const on = state.view === 'map' ? dom.viewMap : dom.viewGlobe;
    g.style.width = on.offsetWidth + 'px';
    g.style.transform = 'translateX(' + (on.offsetLeft - 4) + 'px)';
  }

  function updatePlayButton() {
    const running = !state.paused && state.speed > 0;
    dom.play.classList.toggle('paused', !running);
    dom.play.setAttribute('aria-label', running ? 'Pause the day-night cycle' : 'Play the day-night cycle');
    dom.play.title = (running ? 'Pause' : 'Play') + ' the day-night cycle (Space)';
  }
  function togglePlay() {
    if (state.paused || state.speed === 0) {
      state.paused = false;
      if (state.speed === 0) { state.speed = 3; syncSliders(); }
    } else state.paused = true;
    updatePlayButton();
    markInteracted();
    sfx('click');
  }

  function setZoom(z) { view.targetZoom = clamp(z, ZOOM_MIN, ZOOM_MAX); }
  function resetView() {
    view.targetZoom = 1; view.vyaw = 0; view.vpitch = 0; view.vpan = 0;
    resetAnim = { start: performance.now(), fromYaw: view.yaw, fromPitch: view.pitch, fromPan: view.mapPan };
  }
  let resetAnim = null;
  function stepReset(now) {
    if (!resetAnim) return;
    const t = clamp((now - resetAnim.start) / 650, 0, 1), k = easeInOut(t);
    // Rotate the short way round.
    const two = Math.PI * 2;
    let dy = (-0.35 - resetAnim.fromYaw) % two;
    if (dy > Math.PI) dy -= two; if (dy < -Math.PI) dy += two;
    view.yaw = resetAnim.fromYaw + dy * k;
    view.pitch = resetAnim.fromPitch + (0.32 - resetAnim.fromPitch) * k;
    let dp = (0 - resetAnim.fromPan) % 1;
    if (dp > 0.5) dp -= 1; if (dp < -0.5) dp += 1;
    view.mapPan = resetAnim.fromPan + dp * k;
    if (t >= 1) resetAnim = null;
  }

  // ---------------------------------------------------------------------------
  // Picking & inspector tooltip
  // ---------------------------------------------------------------------------
  function pick(clientX, clientY) {
    if (!planet || !climate) return null;
    const rect = dom.canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    let tx, ty, ndl;
    if (state.view === 'globe') {
      const R = globeRadius();
      const dx = (x - layout.cx) / R, dy = (y - layout.cy) / R;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) return null;
      const vx = dx, vy = -dy, vz = Math.sqrt(1 - d2);
      const m = planetMatrix();
      const px = m[0] * vx + m[1] * vy + m[2] * vz;
      const py = clamp(m[3] * vx + m[4] * vy + m[5] * vz, -1, 1);
      const pz = m[6] * vx + m[7] * vy + m[8] * vz;
      const lon = Math.atan2(px, pz), lat = Math.asin(py);
      tx = (lon * INV_2PI + 0.5) * planet.W;
      ty = (0.5 - lat * INV_PI) * planet.H;
      const s = sunView();
      ndl = vx * s[0] + vy * s[1] + vz * s[2];
    } else {
      const m = layout.map;
      if (x < m.x || x > m.x + m.w || y < m.y || y > m.y + m.h) return null;
      let u = (x - m.x) / m.w - view.mapPan;
      u = ((u % 1) + 1) % 1;
      tx = u * planet.W;
      ty = ((y - m.y) / m.h) * planet.H;
      const lon = (u - 0.5) * 2 * Math.PI, lat = (0.5 - (y - m.y) / m.h) * Math.PI;
      const s = sunPlanet();
      ndl = Math.cos(lat) * Math.sin(lon) * s[0] + Math.sin(lat) * s[1] + Math.cos(lat) * Math.cos(lon) * s[2];
    }
    const info = Terra.sampleAt(planet, climate, tx, ty);
    if (!info) return null;
    const s = sunPlanet();
    const subLon = Math.atan2(s[0], s[2]) * DEG;
    let hours = 12 + (info.lon - subLon) / 15;
    hours = ((hours % 24) + 24) % 24;
    info.localTime = hours;
    info.ndl = ndl;
    return info;
  }

  function showTipAt(clientX, clientY) {
    if (game) { hideTip(); return; }
    if (doom) {
      const L = coreLayerAt(clientX, clientY);
      if (!L) { hideTip(); return; }
      dom.tipSwatch.style.backgroundColor = L.name === 'Inner core' ? '#fff3d0' : L.name === 'Outer core' ? '#ffb347' : L.name === 'Mantle' ? '#d9481c' : L.name === 'Ocean' ? '#28609f' : L.name === 'Ice shell' ? '#d6e8f6' : '#2d211b';
      dom.tipBiome.textContent = L.name;
      $('tip-l1').textContent = 'Depth'; $('tip-l3').textContent = 'Material';
      dom.tipElev.textContent = L.depth;
      dom.tipTemp.textContent = L.temp;
      dom.tipSun.textContent = L.comp;
      dom.tipCoord.textContent = planet.name + ' · ' + doom.model.radiusKm.toLocaleString('en-US') + ' km radius';
      const tip = dom.tip;
      tip.classList.add('show');
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = clientX + 18, top = clientY + 18;
      if (left + tw > window.innerWidth - 8) left = clientX - tw - 18;
      if (top + th > window.innerHeight - 8) top = clientY - th - 18;
      tip.style.transform = 'translate(' + Math.max(8, left) + 'px,' + Math.max(8, top) + 'px)';
      return;
    }
    const info = pick(clientX, clientY);
    if (!info) { hideTip(); return; }
    $('tip-l1').textContent = 'Elevation'; $('tip-l3').textContent = 'Local time';
    const b = info.biome;
    dom.tipSwatch.style.backgroundColor = biomeCss(b.id);
    dom.tipBiome.textContent = info.river ? (info.river === 2 ? 'Lake' : 'River') + ' · ' + b.name : b.name;
    const e = Math.round(info.elev);
    dom.tipElev.textContent = info.biome.water
      ? Math.abs(e).toLocaleString('en-US') + ' m deep'
      : (e < 0 ? '−' : '') + Math.abs(e).toLocaleString('en-US') + ' m';
    const t = Math.round(info.temp);
    dom.tipTemp.textContent = (t > 0 ? '+' : t < 0 ? '−' : '') + Math.abs(t) + ' °C';
    const hh = Math.floor(info.localTime), mm = Math.floor((info.localTime - hh) * 60);
    const phase = info.ndl > 0.1 ? 'day' : info.ndl > -0.12 ? 'twilight' : 'night';
    dom.tipSun.textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ' · ' + phase;
    const lat = info.lat, lon = info.lon;
    dom.tipCoord.textContent = Math.abs(lat).toFixed(1) + '° ' + (lat >= 0 ? 'N' : 'S') + ' · ' +
      Math.abs(lon).toFixed(1) + '° ' + (lon >= 0 ? 'E' : 'W');
    const tip = dom.tip;
    tip.classList.add('show');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = clientX + 18, top = clientY + 18;
    if (left + tw > window.innerWidth - 8) left = clientX - tw - 18;
    if (top + th > window.innerHeight - 8) top = clientY - th - 18;
    tip.style.transform = 'translate(' + Math.max(8, left) + 'px,' + Math.max(8, top) + 'px)';
  }
  function hideTip() { dom.tip.classList.remove('show'); }

  // ---------------------------------------------------------------------------
  // Pointer, wheel and keyboard input
  // ---------------------------------------------------------------------------
  const pointers = new Map();
  let drag = null, pinch = null;

  function markInteracted() {
    if (interacted) return;
    interacted = true;
    dom.hint.classList.add('gone');
  }

  dom.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (game) { if (game.state === 'playing') { e.preventDefault(); shoot(e.clientX, e.clientY); } return; }
    if (doom) { if (doom.coreShown && e.pointerType !== 'mouse') showTipAt(e.clientX, e.clientY); return; } // the strike plays out in screen space
    try { dom.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    resetAnim = null;
    if (pointers.size === 1) {
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), t0: performance.now(), moved: false };
      view.vyaw = 0; view.vpitch = 0; view.vpan = 0;
      dom.canvas.classList.add('dragging');
    } else if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: view.targetZoom };
      drag = null;
    }
    markInteracted();
  });

  dom.canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = Array.from(pointers.values());
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        setZoom(pinch.zoom * (d / pinch.dist));
        return;
      }
      if (drag && drag.id === e.pointerId) {
        const now = performance.now();
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        const dt = Math.max(1, now - drag.t) / 1000;
        if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
        if (state.view === 'globe') {
          const R = Math.max(40, globeRadius());
          const ry = dx / R, rp = dy / R;
          view.yaw += ry;
          view.pitch = clamp(view.pitch + rp, -PITCH_LIMIT, PITCH_LIMIT);
          view.vyaw = view.vyaw * 0.5 + (ry / dt) * 0.5;
          view.vpitch = view.vpitch * 0.5 + (rp / dt) * 0.5;
        } else {
          const p = dx / layout.map.w;
          view.mapPan += p;
          view.vpan = view.vpan * 0.5 + (p / dt) * 0.5;
        }
        drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
        hideTip();
        dirty = true;
      }
      return;
    }
    if (e.pointerType === 'mouse') { hover = { x: e.clientX, y: e.clientY }; dirty = true; }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    try { dom.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (drag && drag.id === e.pointerId) {
      const quick = performance.now() - drag.t > 80;
      if (quick) { view.vyaw = 0; view.vpitch = 0; view.vpan = 0; } // held still before release: no fling
      if (!drag.moved && e.type === 'pointerup') {
        if (landing.pickMode) {
          const info = pick(e.clientX, e.clientY);
          if (info) openLanding(info.lat, info.lon);
          else toast('Click on the planet itself to land');
        } else if (e.pointerType !== 'mouse') showTipAt(e.clientX, e.clientY);
      }
      drag = null;
    }
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) dom.canvas.classList.remove('dragging');
  }
  dom.canvas.addEventListener('pointerup', endPointer);
  dom.canvas.addEventListener('pointercancel', endPointer);
  dom.canvas.addEventListener('lostpointercapture', endPointer);
  dom.canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hover = null; hideTip(); } });

  dom.canvas.addEventListener('wheel', (e) => {
    if (game) { e.preventDefault(); return; }
    if (state.view !== 'globe') return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const delta = clamp(e.deltaY * unit, -400, 400);
    setZoom(view.targetZoom * Math.exp(-delta * 0.0016));
    markInteracted();
    hideTip();
  }, { passive: false });

  dom.canvas.addEventListener('dblclick', (e) => { e.preventDefault(); resetView(); });

  function isTyping(t) {
    if (!t || t === document.body) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  // ---------------------------------------------------------------------------
  // Landing: pick any point on the planet, land a ship there and play in a
  // sandbox of that area. The local map is built from the planet's own height,
  // temperature and moisture fields plus seeded fine detail, so the same site
  // on the same planet always looks the same.
  // ---------------------------------------------------------------------------
  const LG = 160;          // local grid: LG x LG cells
  const LAND_SPAN = 7;     // degrees of latitude covered by the local map
  const LD_TOOLS = [
    { id: 'raise', label: 'Raise land' },
    { id: 'lower', label: 'Dig' },
    { id: 'flood', label: 'Flood' },
    { id: 'plant', label: 'Plant forest' },
    { id: 'base', label: 'Build base' },
  ];
  const landing = {
    open: false, pickMode: false, root: null, cvs: null, ctx: null, off: null, octx: null, img: null,
    h: new Float32Array(LG * LG), base: new Float32Array(LG * LG), temp: new Float32Array(LG * LG),
    wet: new Float32Array(LG * LG), em: new Float32Array(LG * LG), tNow: new Float32Array(LG * LG),
    biome: new Uint8Array(LG * LG), flora: new Uint8Array(LG * LG),
    sl: 0, datum: 0, amp: 1, range: 1, hasSea: true, tool: 'raise', painting: false, bases: [],
    ship: { x: LG / 2, y: LG / 2 }, keys: new Set(), t0: 0, last: 0, raf: 0, size: 300, pointer: null,
    noise: null, noiseFor: null, lat: 0, lon: 0,
    lit: new Float32Array(LG * LG), ltype: new Uint8Array(LG * LG),
    sun: null, overcast: 0, weather: { cover: 0.3, precip: null, dusty: false, mist: 0, label: 'clear' }, infoAt: 0,
  };
  const mix = (a, b, t) => a + (b - a) * t;

  function landNoise() {
    if (landing.noiseFor !== planet) {
      landing.noise = Terra.makeNoise3(Terra.mulberry32((planet.hash ^ 0x2545f491) >>> 0));
      landing.noiseFor = planet;
    }
    return landing.noise;
  }
  function fbm4(n, x, y, z) {
    let s = 0, a = 0.5, f = 1;
    for (let o = 0; o < 4; o++) { s += a * n(x * f, y * f, z * f); a *= 0.5; f *= 2.03; }
    return s / 0.9375;
  }
  /** Bilinear sample of a planet texture field (wraps in longitude). */
  function texSample(arr, tx, ty) {
    const W = planet.W, H = planet.H;
    let x0 = Math.floor(tx); const fx = tx - x0;
    let y0 = Math.floor(ty); let fy = ty - y0;
    x0 = ((x0 % W) + W) % W;
    const x1 = x0 + 1 === W ? 0 : x0 + 1;
    if (y0 < 0) { y0 = 0; fy = 0; } else if (y0 >= H - 1) { y0 = H - 1; fy = 0; }
    const y1 = y0 + 1 < H ? y0 + 1 : y0;
    const a = arr[y0 * W + x0], b = arr[y0 * W + x1], c = arr[y1 * W + x0], d = arr[y1 * W + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  function buildLanding(lat, lon) {
    const c = climate, n = landNoise();
    landing.sl = c.seaLevel;
    landing.datum = Math.max(c.seaLevel, Number.isFinite(c.median) ? c.median : c.seaLevel);
    landing.range = Math.max(1e-6, c.hmax - c.hmin);
    landing.amp = landing.range * (0.03 + 0.05 * state.terrain / 100);
    landing.hasSea = state.water > 0;
    const cosL = Math.max(0.12, Math.cos(lat * Math.PI / 180));
    const lonSpan = Math.min(120, LAND_SPAN / cosL);
    const wet = c.wet || null;
    for (let j = 0; j < LG; j++) {
      const la = clamp(lat + (0.5 - (j + 0.5) / LG) * LAND_SPAN, -89.9, 89.9);
      const lr = la * Math.PI / 180, cl = Math.cos(lr), sn = Math.sin(lr);
      const ty = (0.5 - la / 180) * planet.H - 0.5;
      for (let i = 0; i < LG; i++) {
        const lo = lon + ((i + 0.5) / LG - 0.5) * lonSpan;
        const lor = lo * Math.PI / 180;
        const X = cl * Math.sin(lor), Y = sn, Z = cl * Math.cos(lor);
        const tx = (lo / 360 + 0.5) * planet.W - 0.5;
        const k = j * LG + i;
        landing.h[k] = texSample(c.height, tx, ty) + landing.amp * fbm4(n, X * 60, Y * 60, Z * 60);
        landing.temp[k] = texSample(c.temp, tx, ty);
        const w = wet ? texSample(wet, tx, ty) : 0.5;
        landing.wet[k] = clamp(w + 0.12 * fbm4(n, X * 25 + 7.1, Y * 25 - 3.3, Z * 25 + 1.7), 0, 1);
        landing.lit[k] = c.lights ? texSample(c.lights, tx, ty) / 255 : 0;
        landing.ltype[k] = c.lightType ? c.lightType[clamp(Math.round(ty), 0, planet.H - 1) * planet.W + (((Math.round(tx) % planet.W) + planet.W) % planet.W)] : 0;
      }
    }
    landing.base.set(landing.h);
    landing.flora.fill(0);
    landing.bases = [];
  }

  function landBiome(k) {
    const B = Terra.BIOME, e = landing.h[k], sl = landing.sl;
    if (e < sl) {
      const depth = (sl - e) * 8000;
      landing.em[k] = -depth; landing.tNow[k] = landing.temp[k];
      if (landing.temp[k] < -9) return B.SEA_ICE;
      return depth < 220 ? B.SHALLOW : depth < 2600 ? B.OCEAN : B.DEEP;
    }
    const dr = Math.max(0, e - landing.datum), em = 11000 * dr * Math.sqrt(dr);
    const d0 = Math.max(0, landing.base[k] - landing.datum), em0 = 11000 * d0 * Math.sqrt(d0);
    const T = landing.temp[k] - 6.5 * (em - em0) / 1000; // raised land gets colder
    landing.em[k] = em; landing.tNow[k] = T;
    const ds = e - sl, above = 11000 * ds * Math.sqrt(ds), me = landing.wet[k];
    if (T > 52) return B.SCORCHED;
    if (T < -18) return B.ICE;
    if (T < -5) return B.SNOW;
    if (em > 4300 && T < 30) return B.MOUNTAIN;
    if (landing.flora[k]) return T >= 22 ? B.RAINFOREST : T >= 9 ? B.FOREST : B.TAIGA;
    if (above < 30 && landing.hasSea && T > 1) return B.BEACH;
    if (T < 3) return B.TUNDRA;
    if (T < 9) return me > 0.45 ? B.TAIGA : B.TUNDRA;
    if (T < 22) return me < 0.25 ? B.DESERT : me < 0.5 ? B.GRASSLAND : B.FOREST;
    return me < 0.3 ? B.DESERT : me < 0.5 ? B.SAVANNA : B.RAINFOREST;
  }

  function recolorLanding() {
    const B = Terra.BIOME, pal = planet.palette, sl = landing.sl, data = landing.img.data, h = landing.h;
    const K = 2.4 / Math.max(1e-6, landing.amp);
    for (let j = 0; j < LG; j++) {
      for (let i = 0; i < LG; i++) {
        const k = j * LG + i;
        const b = landBiome(k);
        landing.biome[k] = b;
        let r, g, bl;
        if (h[k] < sl && b !== B.SEA_ICE) {
          const t = Math.sqrt(clamp((sl - h[k]) * 8000 / 5200, 0, 1));
          const cs = pal[B.SHALLOW], cd = pal[B.DEEP];
          r = mix(cs[0], cd[0], t); g = mix(cs[1], cd[1], t); bl = mix(cs[2], cd[2], t);
        } else {
          const c = pal[b];
          r = c[0]; g = c[1]; bl = c[2];
          if (b !== B.SNOW && b !== B.ICE && b !== B.SCORCHED && b !== B.SEA_ICE) {
            const kk = Terra.smoothstep(1800, 4600, landing.em[k]) * 0.85;
            r = mix(r, 118, kk); g = mix(g, 108, kk); bl = mix(bl, 98, kk);
          }
          const l = i > 0 ? k - 1 : k, rt = i < LG - 1 ? k + 1 : k, u = j > 0 ? k - LG : k, dn = j < LG - 1 ? k + LG : k;
          const sh = 1 + clamp(((h[l] - h[rt]) + (h[u] - h[dn])) * K, -0.45, 0.45);
          r *= sh; g *= sh; bl *= sh;
        }
        const o = k * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = bl; data[o + 3] = 255;
      }
    }
    landing.octx.putImageData(landing.img, 0, 0);
    if (landing.v3) build3D();
  }

  function ensureLandingDom() {
    if (landing.root) return;
    const root = document.createElement('div');
    root.className = 'landing';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Landing site sandbox');
    // Static markup only; every dynamic value is set with textContent below.
    root.innerHTML =
      '<div class="landing-top">' +
        '<div><div class="eyebrow">Landing site</div><h2 class="ld-name"></h2><div class="ld-coord"></div></div>' +
        '<div class="ld-actions"><button type="button" class="pill-btn ld-view">Walk around (M)</button>' +
        '<button type="button" class="pill-btn ld-leave">Lift off (Esc)</button></div>' +
      '</div>' +
      '<div class="landing-stage"><canvas class="ld-canvas"></canvas></div>' +
      '<div class="landing-bar">' +
        '<div class="ld-tools" role="group" aria-label="Sandbox tools"></div>' +
        '<div class="ld-read" aria-live="polite"></div>' +
        '<div class="ld-hint">WASD or arrow keys fly the ship · click or drag to use a tool · 1–5 pick a tool</div>' +
      '</div>';
    document.body.appendChild(root);
    landing.root = root;
    landing.nameEl = root.querySelector('.ld-name');
    landing.coordEl = root.querySelector('.ld-coord');
    landing.readEl = root.querySelector('.ld-read');
    landing.stage = root.querySelector('.landing-stage');
    landing.cvs = root.querySelector('.ld-canvas');
    landing.ctx = landing.cvs.getContext('2d');
    landing.off = document.createElement('canvas');
    landing.off.width = landing.off.height = LG;
    landing.octx = landing.off.getContext('2d');
    landing.img = landing.octx.createImageData(LG, LG);
    const tools = root.querySelector('.ld-tools');
    LD_TOOLS.forEach((t, idx) => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.tool = t.id;
      b.textContent = (idx + 1) + ' · ' + t.label;
      b.addEventListener('click', () => setLandTool(t.id));
      tools.appendChild(b);
    });
    const reset = document.createElement('button');
    reset.type = 'button'; reset.textContent = 'Reset area';
    reset.addEventListener('click', () => {
      landing.h.set(landing.base); landing.flora.fill(0); landing.bases = []; landing.sl = landing.sl0;
      recolorLanding(); toast('Area restored');
    });
    tools.appendChild(reset);
    root.querySelector('.ld-leave').addEventListener('click', closeLanding);
    landing.viewBtn = root.querySelector('.ld-view');
    landing.hintEl = root.querySelector('.ld-hint');
    landing.viewBtn.addEventListener('click', () => { if (landing.view === '3d') setLandView('map'); else enterWalk(); });

    const cellAt = (e) => {
      const r = landing.cvs.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * LG, y: ((e.clientY - r.top) / r.height) * LG };
    };
    landing.cvs.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { landing.cvs.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (landing.view === '3d') { landing.look = { x: e.clientX, y: e.clientY }; return; }
      landing.painting = true;
      const p = cellAt(e);
      landing.pointer = p;
      applyLandTool(p.x, p.y, true);
    });
    landing.cvs.addEventListener('pointermove', (e) => {
      if (landing.view === '3d') {
        if (landing.look && landing.pl) {
          landing.pl.a += (e.clientX - landing.look.x) * 0.006;
          landing.pl.pitch = clamp(landing.pl.pitch - (e.clientY - landing.look.y) * 0.0022, -0.45, 0.6);
          landing.look = { x: e.clientX, y: e.clientY };
        }
        return;
      }
      const p = cellAt(e);
      landing.pointer = p;
      if (landing.painting) applyLandTool(p.x, p.y, false);
    });
    const stop = () => { landing.painting = false; landing.look = null; };
    landing.cvs.addEventListener('pointerup', stop);
    landing.cvs.addEventListener('pointercancel', stop);
    landing.cvs.addEventListener('pointerleave', () => { landing.pointer = null; });
    window.addEventListener('resize', () => { if (landing.open) sizeLanding(); });
    window.addEventListener('keyup', (e) => { landing.keys.delete(String(e.key).toLowerCase()); });
  }

  function setLandTool(id) {
    landing.tool = id;
    landing.root.querySelectorAll('.ld-tools button[data-tool]').forEach((b) => {
      const on = b.dataset.tool === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function applyLandTool(cx, cy, first) {
    const sl = landing.sl, range = landing.range;
    if (cx < 0 || cy < 0 || cx >= LG || cy >= LG) return;
    if (landing.tool === 'base') {
      if (!first) return;
      const k = (cy | 0) * LG + (cx | 0);
      if (landing.h[k] < sl) { toast('Bases need dry land'); return; }
      if (landing.bases.length >= 24) landing.bases.shift();
      landing.bases.push({ x: cx, y: cy, t: performance.now() });
      try { sfx('click'); } catch (err) { /* sound is optional */ }
      return;
    }
    const R = 6;
    for (let dy = -R; dy <= R; dy++) {
      const y = (cy | 0) + dy;
      if (y < 0 || y >= LG) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = (cx | 0) + dx;
        if (x < 0 || x >= LG) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > R * R) continue;
        const w = 1 - d2 / (R * R), k = y * LG + x;
        if (landing.tool === 'raise') landing.h[k] = Math.min(climate.hmax, landing.h[k] + 0.006 * range * w);
        else if (landing.tool === 'lower') landing.h[k] = Math.max(climate.hmin, landing.h[k] - 0.006 * range * w);
        else if (landing.tool === 'flood') { if (landing.h[k] > sl - 0.004 * range * w) landing.h[k] = sl - 0.004 * range * w - 1e-5; }
        else if (landing.tool === 'plant') { if (landing.h[k] >= sl && w > 0.15) landing.flora[k] = 1; }
      }
    }
    recolorLanding();
  }

  function sizeLanding() {
    const r = landing.stage.getBoundingClientRect();
    const d = Math.min(window.devicePixelRatio || 1, 2);
    let w, h;
    if (landing.view === '3d') { w = Math.max(200, Math.floor(r.width)); h = Math.max(150, Math.floor(r.height)); }
    else { w = h = Math.max(200, Math.floor(Math.min(r.width, r.height))); }
    landing.size = Math.min(w, h);
    landing.cvs.style.width = w + 'px';
    landing.cvs.style.height = h + 'px';
    landing.cvs.width = Math.round(w * d);
    landing.cvs.height = Math.round(h * d);
    landing.dpr = d;
  }

  function fmtCoord(lat, lon) {
    return Math.abs(lat).toFixed(1) + '° ' + (lat >= 0 ? 'N' : 'S') + ' · ' + Math.abs(lon).toFixed(1) + '° ' + (lon >= 0 ? 'E' : 'W');
  }

  function openLanding(lat, lon) {
    if (!planet || !climate) { toast('Wait a moment, the planet is still forming'); return; }
    ensureLandingDom();
    setLandPick(false);
    hideTip();
    landing.lat = lat; landing.lon = lon;
    buildLanding(lat, lon);
    landing.sun = pinSun();
    recolorLanding();
    pinWeather();
    if (landing.v3 && landing.v3.ar) light3D(true);
    landing.ship = { x: LG / 2, y: LG / 2 };
    landing.keys.clear();
    landing.t0 = performance.now(); landing.last = 0;
    const center = landing.biome[(LG / 2) * LG + LG / 2];
    landing.nameEl.textContent = planet.name + ' · ' + Terra.BIOMES[center].name;
    updateLandingInfo(true);
    setLandTool(landing.tool);
    landing.root.hidden = false;
    landing.open = true;
    landing.sl0 = landing.sl;
    landing.walked = false;
    landing.pl = null;
    setLandView('map');
    try { sfx('preset'); } catch (err) { /* sound is optional */ }
    cancelAnimationFrame(landing.raf);
    landing.raf = requestAnimationFrame(landFrame);
  }

  function closeLanding() {
    if (!landing.open) return;
    landing.open = false;
    landing.painting = false;
    landing.keys.clear();
    cancelAnimationFrame(landing.raf);
    landing.root.hidden = true;
    toast('Lifted off from ' + planet.name);
    dirty = true;
  }

  function setLandPick(on) {
    landing.pickMode = !!on;
    dom.canvas.classList.toggle('landing-pick', landing.pickMode);
    const b = document.getElementById('btn-land');
    if (b) { b.classList.toggle('on', landing.pickMode); b.setAttribute('aria-pressed', landing.pickMode ? 'true' : 'false'); }
  }

  /** E key or the Land button: land under the cursor, or arm click-to-land. */
  function landCommand(fromKey) {
    if (landing.open) return;
    if (fromKey && hover) {
      const info = pick(hover.x, hover.y);
      if (info) { openLanding(info.lat, info.lon); return; }
    }
    setLandPick(!landing.pickMode);
    if (landing.pickMode) toast('Click anywhere on the planet to land');
  }

  // ---------------------------------------------------------------------------
  // On foot: a simple 3D free-roam view of the landing site. A "voxel space"
  // height-map renderer (one vertical strip per screen column, drawn front to
  // back) turns the local map into rolling 3D terrain with water, trees, the
  // landed ship and any bases. The map is mirrored at its edges so you can
  // keep walking. Demo-grade on purpose: fast and good-looking, not exact.
  // ---------------------------------------------------------------------------
  // Render width adapts to the machine: sharper on fast laptops, smooth on slow ones.
  let W3 = 720;
  const FAR3 = 150, TANH3 = 0.62, EYE3 = 1.15;
  const HEIGHT_UNITS = 40; // world height of the planet's full elevation range

  function ensure3D(rh) {
    let v = landing.v3;
    if (!v) {
      v = landing.v3 = {
        hw: new Float32Array(LG * LG), cr: new Float32Array(LG * LG), cg: new Float32Array(LG * LG),
        cb: new Float32Array(LG * LG), wet: new Float32Array(LG * LG), off: document.createElement('canvas'),
        rh: 0, rw: 0, img: null, px: null, octx: null, ybuf: null, ema: 12, frames: 0,
      };
    }
    if (v.rh !== rh || v.rw !== W3) {
      v.rh = rh; v.rw = W3;
      v.ybuf = new Int32Array(W3);
      v.off.width = W3; v.off.height = rh;
      v.octx = v.off.getContext('2d');
      v.img = v.octx.createImageData(W3, rh);
      v.px = new Uint32Array(v.img.data.buffer);
    }
    return v;
  }

  const hash01 = (x, y) => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  // Natural ground colours per biome (the globe palette is tuned for space, not eye level).
  const REAL3 = (() => {
    const B = Terra.BIOME, r = [];
    r[B.BEACH] = [218, 200, 156]; r[B.DESERT] = [208, 174, 118]; r[B.SAVANNA] = [172, 156, 92];
    r[B.GRASSLAND] = [96, 134, 58]; r[B.FOREST] = [48, 88, 42]; r[B.RAINFOREST] = [30, 74, 38];
    r[B.TAIGA] = [44, 74, 56]; r[B.TUNDRA] = [130, 126, 102]; r[B.SNOW] = [238, 242, 248];
    r[B.ICE] = [204, 226, 242]; r[B.MOUNTAIN] = [120, 112, 104]; r[B.SCORCHED] = [86, 48, 36];
    r[B.SEA_ICE] = [224, 236, 246];
    return r;
  })();
  const ROCK3 = [112, 106, 100], SAND3 = [214, 198, 154], SEABED3 = [176, 162, 124];

  /** Rebuilds the 3D height and colour maps from the local sandbox. */
  function build3D() {
    const v = ensure3D(landing.v3 ? landing.v3.rh : 236);
    const B = Terra.BIOME, sl = landing.sl, K = HEIGHT_UNITS / landing.range, n = landNoise();
    const N = LG * LG, hw = v.hw, wet = v.wet;
    if (!v.depth || v.depth.length !== N) { v.depth = new Float32Array(N); v.ao = new Float32Array(N); v.tmp = new Float32Array(N); }
    const depth = v.depth;
    const exotic = planet.traits && planet.traits.flora !== 'Green';
    const isFlora = (b) => b === B.FOREST || b === B.RAINFOREST || b === B.TAIGA || b === B.GRASSLAND || b === B.SAVANNA;

    // 1. Heights, water depth and a lumpy tree canopy.
    for (let k = 0; k < N; k++) {
      const b = landing.biome[k];
      const g = (landing.h[k] - sl) * K;
      if (g < 0 && b !== B.SEA_ICE) { wet[k] = 1; depth[k] = -g; hw[k] = 0; }
      else { wet[k] = 0; depth[k] = 0; hw[k] = g < 0 ? 0 : g; }
    }
    // Ground for walking (trees are scenery you can walk through).
    if (!v.hg || v.hg.length !== N) v.hg = new Float32Array(N);
    v.hg.set(hw);

    // 2. Ground colour: biome base + large patches + rock on steep slopes + sand at the shore.
    for (let y = 0; y < LG; y++) {
      for (let x = 0; x < LG; x++) {
        const k = y * LG + x, b = landing.biome[k];
        const pn = fbm4(n, x * 0.07 + 11.3, y * 0.07 - 4.1, 2.9);
        let c;
        if (wet[k]) c = SEABED3;
        else if (exotic && isFlora(b)) c = planet.palette[b].map((q) => q * 0.85);
        else c = REAL3[b] || planet.palette[b];
        let r = c[0], g = c[1], bl = c[2];
        if (!wet[k]) {
          if (b === B.GRASSLAND || b === B.SAVANNA) {
            const dry = clamp(0.5 + pn, 0, 1) * 0.35;
            r = mix(r, 150, dry); g = mix(g, 146, dry); bl = mix(bl, 78, dry);
          }
          const cold = b === B.SNOW || b === B.ICE || b === B.SEA_ICE;
          if (!cold && hw[k] < 0.35 && landing.tNow[k] > 2) {
            const s = (1 - hw[k] / 0.35) * 0.7;
            r = mix(r, SAND3[0], s); g = mix(g, SAND3[1], s); bl = mix(bl, SAND3[2], s);
          }
          const gx = hw[y * LG + Math.min(LG - 1, x + 1)] - hw[y * LG + Math.max(0, x - 1)];
          const gy = hw[Math.min(LG - 1, y + 1) * LG + x] - hw[Math.max(0, y - 1) * LG + x];
          const slope = Math.hypot(gx, gy) * 0.5;
          const rk = Terra.smoothstep(0.5, 1.1, slope) * (cold ? 0.45 : 0.85);
          const rv = 0.9 + 0.2 * pn;
          r = mix(r, ROCK3[0] * rv, rk); g = mix(g, ROCK3[1] * rv, rk); bl = mix(bl, ROCK3[2] * rv, rk);
        }
        const vary = 1 + 0.12 * pn + 0.05 * (hash01(x, y) - 0.5);
        v.cr[k] = r * vary; v.cg[k] = g * vary; v.cb[k] = bl * vary;
      }
    }

    // 2b. Trees: individual crowns with their own colour, dense in forests and
    // scattered on grassland and savanna. They also cast shadows at low sun.
    const TREE = []; TREE[B.RAINFOREST] = 0.5; TREE[B.FOREST] = 0.38; TREE[B.TAIGA] = 0.34; TREE[B.SAVANNA] = 0.035; TREE[B.GRASSLAND] = 0.025;
    for (let y = 1; y < LG - 1; y++) {
      for (let x = 1; x < LG - 1; x++) {
        const k = y * LG + x, b = landing.biome[k], dens = TREE[b] || 0;
        if (!dens || wet[k] || hash01(x * 3 + 17, y * 5 + 29) > dens) continue;
        if (Math.hypot(x - landing.ship.x, y - landing.ship.y) < 15) continue; // the landing clearing
        const taiga = b === B.TAIGA, ht = (taiga ? 1.05 : 0.85) * (0.75 + 0.5 * hash01(x + 51, y + 7));
        const crown = exotic ? planet.palette[b].map((q) => q * 0.7) : taiga ? [34, 58, 44] : b === B.RAINFOREST ? [26, 66, 30] : b === B.SAVANNA ? [86, 96, 46] : [42, 80, 36];
        const tone = 0.8 + 0.4 * hash01(x + 9, y + 3), base = hw[k];
        const put = (kk, hh, shade) => {
          if (wet[kk] || base + hh <= hw[kk]) return;
          hw[kk] = base + hh; v.cr[kk] = crown[0] * tone * shade; v.cg[kk] = crown[1] * tone * shade; v.cb[kk] = crown[2] * tone * shade;
        };
        put(k, ht, 1.1);
        put(k - 1, ht * 0.62, 0.9); put(k + 1, ht * 0.62, 0.9); put(k - LG, ht * 0.62, 0.9); put(k + LG, ht * 0.62, 0.9);
      }
    }

    // 3. Landed ship and bases.
    const bump = (cx, cy, R, H, col, ring, cone) => {
      const k0 = clamp(cy | 0, 0, LG - 1) * LG + clamp(cx | 0, 0, LG - 1);
      const base = hw[k0];
      for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
        if (y < 0 || y >= LG) continue;
        for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
          if (x < 0 || x >= LG) continue;
          const d = Math.hypot(x - cx, y - cy) / R;
          if (d >= 1) continue;
          const k = y * LG + x;
          const add = cone ? H * (1 - d) : H * Math.sqrt(1 - d * d);
          if (base + add <= hw[k]) continue;
          hw[k] = base + add; wet[k] = 0; depth[k] = 0;
          const c = ring && d > 0.55 && d < 0.72 ? ring : col;
          v.cr[k] = c[0]; v.cg[k] = c[1]; v.cb[k] = c[2];
        }
      }
    };
    landing.bases.forEach((b) => bump(b.x, b.y, 2.2, 1.6, [236, 240, 250], [110, 231, 255], false));
    bump(landing.ship.x, landing.ship.y, 1.1, 2.4, [206, 212, 226], null, true);

    // 4. Ambient occlusion: valleys and hollows are a little darker (box blur of height).
    const tmp = v.tmp, ao = v.ao, R = 3, span = 2 * R + 1;
    for (let y = 0; y < LG; y++) {
      for (let x = 0; x < LG; x++) {
        let s = 0;
        for (let d = -R; d <= R; d++) s += hw[y * LG + clamp(x + d, 0, LG - 1)];
        tmp[y * LG + x] = s / span;
      }
    }
    for (let y = 0; y < LG; y++) {
      for (let x = 0; x < LG; x++) {
        let s = 0;
        for (let d = -R; d <= R; d++) s += tmp[clamp(y + d, 0, LG - 1) * LG + x];
        ao[y * LG + x] = clamp(1 - (s / span - hw[y * LG + x]) * 0.22, 0.62, 1.06);
      }
    }

    // 5. Keep the unlit colours and slopes; light3D() lights them with the sun of the moment.
    if (!v.ar || v.ar.length !== N) {
      v.ar = new Float32Array(N); v.ag = new Float32Array(N); v.ab = new Float32Array(N);
      v.gx = new Float32Array(N); v.gy = new Float32Array(N);
      v.er = new Float32Array(N); v.eg = new Float32Array(N); v.eb = new Float32Array(N);
    }
    v.ar.set(v.cr); v.ag.set(v.cg); v.ab.set(v.cb);
    let maxH = 0;
    for (let y = 0; y < LG; y++) {
      for (let x = 0; x < LG; x++) {
        const k = y * LG + x;
        v.gx[k] = hw[y * LG + Math.min(LG - 1, x + 1)] - hw[y * LG + Math.max(0, x - 1)];
        v.gy[k] = hw[Math.min(LG - 1, y + 1) * LG + x] - hw[Math.max(0, y - 1) * LG + x];
        if (hw[k] > maxH) maxH = hw[k];
      }
    }
    v.maxH = maxH;
    // 6. Night lights: settlements where the globe shows city lights, glowing lava on scorched ground.
    v.er.fill(0); v.eg.fill(0); v.eb.fill(0);
    for (let k = 0; k < N; k++) {
      const L = landing.lit[k];
      if (wet[k] || L < 0.08) continue;
      const x = k % LG, y = (k / LG) | 0, hsh = hash01(x * 7 + 3, y * 13 + 5);
      if (landing.ltype[k] === 2) { const q = L * (0.5 + 0.9 * hsh); v.er[k] = 255 * q; v.eg[k] = 84 * q; v.eb[k] = 22 * q; }
      else if (hsh < L * 0.3) { const q = 0.9 + 0.7 * hash01(x, y + 99); v.er[k] = 255 * q; v.eg[k] = 200 * q; v.eb[k] = 124 * q; }
    }
    v.litKey = null;
    light3D(true);
  }

  // ---------------------------------------------------------------------------
  // The real sky over the pin: sun position from the planet's actual rotation,
  // weather from the globe's own cloud layer, day, twilight and night.
  // ---------------------------------------------------------------------------
  /** Sun direction at the landing site, in map axes (+x east, +y south, +z up). */
  function pinSun() {
    const s = sunPlanet();
    const la = landing.lat * Math.PI / 180, lo = landing.lon * Math.PI / 180;
    const cla = Math.cos(la), sla = Math.sin(la), clo = Math.cos(lo), slo = Math.sin(lo);
    const se = s[0] * clo - s[2] * slo;                                   // east
    const sn = -s[0] * sla * slo + s[1] * cla - s[2] * sla * clo;          // north
    const su = s[0] * cla * slo + s[1] * sla + s[2] * cla * clo;           // up
    return { x: se, y: -sn, z: su, el: Math.asin(clamp(su, -1, 1)), az: Math.atan2(-sn, se) };
  }

  function localHours() {
    const s = sunPlanet();
    const subLon = Math.atan2(s[0], s[2]) * 180 / Math.PI;
    const h = 12 + (landing.lon - subLon) / 15;
    return ((h % 24) + 24) % 24;
  }
  function localTimeLabel() {
    const h = localHours(), hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    const el = landing.sun ? landing.sun.el : 0.5;
    const phase = el > 0.12 ? 'day' : el > -0.12 ? (h < 12 ? 'sunrise' : 'sunset') : 'night';
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ' ' + phase;
  }

  /** Bilinear sample of a W x H grid that wraps in x. */
  function sampleGrid(arr, Wd, Hd, tx, ty) {
    let x0 = Math.floor(tx); const fx = tx - x0;
    let y0 = Math.floor(ty); let fy = ty - y0;
    x0 = ((x0 % Wd) + Wd) % Wd;
    const x1 = x0 + 1 === Wd ? 0 : x0 + 1;
    if (y0 < 0) { y0 = 0; fy = 0; } else if (y0 >= Hd - 1) { y0 = Hd - 1; fy = 0; }
    const y1 = y0 + 1 < Hd ? y0 + 1 : y0;
    return (arr[y0 * Wd + x0] * (1 - fx) + arr[y0 * Wd + x1] * fx) * (1 - fy) + (arr[y1 * Wd + x0] * (1 - fx) + arr[y1 * Wd + x1] * fx) * fy;
  }

  /** Weather at the pin, read from the same cloud layer the globe shows. */
  function pinWeather() {
    let cover = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const la = clamp(landing.lat + dy * 1.5, -89, 89);
        const lo = landing.lon + (dx * 1.5) / Math.max(0.2, Math.cos(la * Math.PI / 180));
        const val = sampleGrid(climate.clouds, planet.CW, planet.CH, (lo / 360 + 0.5) * planet.CW - 0.5 + view.cloudShift, (0.5 - la / 180) * planet.CH - 0.5);
        cover += val <= 0 ? 0 : val >= 1 ? 1 : val * val * (3 - 2 * val);
        n++;
      }
    }
    cover /= n;
    const c = (LG / 2) * LG + LG / 2, T = landing.temp[c], wetC = landing.wet[c], b = landing.biome[c], B = Terra.BIOME;
    let precip = null;
    if (cover > 0.5 && wetC > 0.35 && T > -35 && T < 45) precip = { kind: T < 0.5 ? 'snow' : 'rain', k: Terra.smoothstep(0.5, 0.95, cover) };
    const dusty = (b === B.DESERT || b === B.SCORCHED) && cover < 0.35;
    const mist = clamp((wetC - 0.5) * 1.4 + (cover - 0.4) + (T < 8 && T > -5 ? 0.2 : 0), 0, 1);
    const label = precip ? (precip.k > 0.6 ? 'heavy ' : precip.k < 0.25 ? 'light ' : '') + precip.kind
      : cover > 0.7 ? 'overcast' : cover > 0.35 ? 'cloudy' : cover > 0.12 ? 'partly cloudy' : dusty ? 'clear, dusty' : 'clear sky';
    landing.weather = { cover, precip, dusty, mist, label };
    landing.overcast = Terra.smoothstep(0.45, 0.9, cover);
  }

  /** Sky colours for the moment: the planet's own blue by day, warm at twilight, dark at night, grey when overcast. */
  function skyNow() {
    const base = skyColors(), sun = landing.sun || { el: 0.6 }, sinEl = Math.sin(sun.el);
    const day = Terra.smoothstep(-0.14, 0.14, sinEl);
    const tw = Math.exp(-Math.pow(sinEl / 0.13, 2));
    const oc = landing.overcast || 0;
    const L = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
    let zenith = L([6, 9, 24], base.zenith, day), md = L([14, 20, 44], base.mid, day), horizon = L([30, 38, 66], base.horizon, day);
    horizon = L(horizon, [255, 140, 80], tw * 0.6);
    md = L(md, [196, 116, 122], tw * 0.3);
    zenith = L(zenith, [36, 34, 84], tw * 0.25);
    const grey = (cc, k) => { const l = (cc[0] + cc[1] + cc[2]) / 3; return L(cc, [l + 8, l + 10, l + 16], k); };
    zenith = grey(zenith, oc * 0.85); md = grey(md, oc * 0.85); horizon = grey(horizon, oc * 0.7);
    if (landing.weather && landing.weather.dusty) horizon = L(horizon, [222, 196, 150], 0.35 * day);
    const r = (cc) => cc.map((q) => clamp(Math.round(q), 0, 255));
    return { zenith: r(zenith), mid: r(md), horizon: r(horizon), day, tw, oc };
  }

  /** Lights the 3D site with the real sun: direct light, cast shadows, sky light, moonlight and night lights. */
  function light3D(force) {
    const v = landing.v3;
    if (!v || !v.ar) return;
    const sun = landing.sun || pinSun();
    const key = Math.round(sun.az * 120) + ':' + Math.round(sun.el * 120) + ':' + Math.round((landing.overcast || 0) * 20);
    if (!force && key === v.litKey) return;
    v.litKey = key;
    const N = LG * LG, hw = v.hw, ao = v.ao, wet = v.wet;
    const sinEl = Math.sin(sun.el), oc = landing.overcast || 0;
    const day = Terra.smoothstep(-0.14, 0.14, sinEl);
    const sunUp = Terra.smoothstep(-0.03, 0.08, sinEl) * (1 - 0.72 * oc);
    const warm = Terra.smoothstep(0.02, 0.5, sinEl);
    const sr = 1.05, sg = mix(0.62, 0.97, warm), sb = mix(0.38, 0.9, warm);
    const sky = skyNow(), m = sky.mid;
    const amb = 0.3 + 0.18 * oc;
    const twl = Math.exp(-Math.pow(sinEl / 0.13, 2));
    const ar = mix(0.1, amb * (0.7 + 0.3 * m[0] / 255), day) + 0.1 * twl, ag = mix(0.12, amb * (0.72 + 0.3 * m[1] / 255), day) + 0.05 * twl, ab = mix(0.2, amb * (0.78 + 0.32 * m[2] / 255), day) + 0.03 * twl;
    const night = 1 - day, moonK = night * 0.5 * (1 - 0.6 * oc);
    const hl = Math.hypot(sun.x, sun.y) || 1e-6, dx = sun.x / hl, dy = sun.y / hl, rise = sun.z / hl;
    const sl = Math.hypot(sun.x, sun.y, Math.max(0.05, sun.z));
    const lx = sun.x / sl, ly = sun.y / sl, lz = Math.max(0.05, sun.z) / sl;
    for (let y = 0; y < LG; y++) {
      for (let x = 0; x < LG; x++) {
        const k = y * LG + x;
        let nx = -v.gx[k], ny = -v.gy[k], nz = 2;
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
        let sh = 1;
        if (!wet[k] && sunUp > 0.01 && diff > 0 && rise > 0 && rise < 4) {
          const h0 = hw[k] + 0.08;
          let px = x + 0.5, py = y + 0.5;
          for (let st = 1; st < 64; st++) {
            px += dx; py += dy;
            if (px < 0 || py < 0 || px >= LG || py >= LG) break;
            const rh = h0 + rise * st;
            if (rh > v.maxH) break;
            if (hw[(py | 0) * LG + (px | 0)] > rh) { sh = 0.18; break; }
          }
        }
        const moon = Math.max(0, -nx * lx * 0.6 - ny * ly * 0.6 + nz * 0.8) * moonK;
        const o = ao[k];
        const direct = diff * sh * sunUp;
        let r = v.ar[k] * ((ar + 0.2 * moon) * o + sr * direct);
        let gg = v.ag[k] * ((ag + 0.24 * moon) * o + sg * direct);
        let b = v.ab[k] * ((ab + 0.36 * moon) * o + sb * direct);
        if (night > 0.02 && v.er[k] > 0) { r += v.er[k] * night; gg += v.eg[k] * night; b += v.eb[k] * night; }
        v.cr[k] = r; v.cg[k] = gg; v.cb[k] = b;
      }
    }
  }

  /** The planet's rings arch across the sky from ringed worlds. */
  function drawSkyRings(g, proj, sys, alpha) {
    if (alpha < 0.02) return;
    const la = landing.lat * Math.PI / 180, sl = Math.sin(la), cl = Math.cos(la);
    const c = planet.traits.ringColor;
    g.save();
    g.lineCap = 'round';
    [[0, 7, 0.8], [0.06, 4, 0.45], [-0.05, 3, 0.4]].forEach(([off, wdt, a]) => {
      g.beginPath();
      let started = false;
      for (let i = 0; i <= 96; i++) {
        const b = (i / 96) * Math.PI;
        const e = Math.cos(b), nn = -Math.sin(b) * sl, u = Math.sin(b) * cl + off;
        const az = Math.atan2(-nn, e), el = Math.asin(clamp(u, -1, 1));
        const q = el > -0.02 ? proj(az, el) : null;
        if (!q) { started = false; continue; }
        if (started) g.lineTo(q.x, q.y); else { g.moveTo(q.x, q.y); started = true; }
      }
      g.strokeStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (alpha * a) + ')';
      g.lineWidth = wdt * sys * (0.45 + Math.abs(sl));
      g.stroke();
    });
    g.restore();
  }

  /** Rain or snow over the view. */
  function drawPrecip(g, CW, CH, sys, dt, pr, dayK) {
    const v = landing.v3, snow = pr.kind === 'snow';
    const want = Math.round((snow ? 220 : 320) * (0.3 + 0.7 * pr.k));
    if (!v.drops || v.dropsKind !== pr.kind) { v.drops = []; v.dropsKind = pr.kind; }
    while (v.drops.length < want) v.drops.push({ x: Math.random() * CW, y: Math.random() * CH, s: 0.5 + Math.random() * 0.8 });
    if (v.drops.length > want) v.drops.length = want;
    const light = 0.35 + 0.65 * dayK;
    if (snow) {
      g.fillStyle = 'rgba(255,255,255,' + (0.85 * light) + ')';
      for (const d of v.drops) {
        d.y += (40 + 50 * d.s) * sys * dt;
        d.x += Math.sin((d.y + d.s * 300) * 0.02) * 20 * sys * dt;
        if (d.y > CH) { d.y = -5; d.x = Math.random() * CW; }
        const r = (1 + 1.6 * d.s) * sys;
        g.fillRect(d.x, d.y, r, r);
      }
    } else {
      g.strokeStyle = 'rgba(200,214,235,' + (0.36 * light) + ')';
      g.lineWidth = Math.max(1, sys);
      g.beginPath();
      for (const d of v.drops) {
        d.y += (700 + 500 * d.s) * sys * dt;
        d.x -= 90 * sys * dt;
        if (d.y > CH) { d.y = -20; d.x = Math.random() * (CW + 100); }
        g.moveTo(d.x, d.y); g.lineTo(d.x - 4 * sys, d.y + 16 * d.s * sys);
      }
      g.stroke();
    }
  }

  /** Header line: coordinates, local time, weather and temperature at the pin. */
  function updateLandingInfo(force) {
    const now = performance.now();
    if (!force && now - landing.infoAt < 500) return;
    landing.infoAt = now;
    const c = (LG / 2) * LG + LG / 2, T = Math.round(landing.tNow[c]);
    const text = fmtCoord(landing.lat, landing.lon) + ' · ' + localTimeLabel() + ' · ' + landing.weather.label + ' · ' +
      (T > 0 ? '+' : T < 0 ? '−' : '') + Math.abs(T) + ' °C';
    if (landing.coordEl.textContent !== text) landing.coordEl.textContent = text;
  }

  function mirror3(t) {
    const L = LG - 1, p = 2 * L;
    t = ((t % p) + p) % p;
    return t > L ? p - t : t;
  }
  /** Bilinear height under a world position (mirrored map). */
  function ground3(x, y) {
    const v = landing.v3, mx = mirror3(x), my = mirror3(y);
    const x0 = mx | 0, y0 = my | 0, fx = mx - x0, fy = my - y0;
    const x1 = x0 < LG - 1 ? x0 + 1 : x0, y1 = y0 < LG - 1 ? y0 + 1 : y0;
    const a = y0 * LG + x0, b = y0 * LG + x1, c = y1 * LG + x0, d = y1 * LG + x1;
    const H = v.hg || v.hw;
    return (H[a] * (1 - fx) + H[b] * fx) * (1 - fy) + (H[c] * (1 - fx) + H[d] * fx) * fy;
  }

  /** Top of whatever is under a position, tree crowns included (keeps the eye above foliage). */
  function canopy3(x, y) {
    const v = landing.v3, mx = mirror3(x), my = mirror3(y);
    return v.hw[(my | 0) * LG + (mx | 0)];
  }

  function skyColors() {
    const atm = (climate && climate.stats && climate.stats.atmosphere) || [96, 166, 255];
    const horizon = [mix(atm[0], 236, 0.62), mix(atm[1], 240, 0.62), mix(atm[2], 246, 0.62)].map((c) => c | 0);
    const mid = [mix(atm[0], 150, 0.35), mix(atm[1], 190, 0.35), mix(atm[2], 235, 0.35)].map((c) => c | 0);
    const zenith = [atm[0] * 0.28 + 12, atm[1] * 0.36 + 22, atm[2] * 0.6 + 40].map((c) => Math.min(255, c) | 0);
    return { horizon, mid, zenith };
  }

  /** Soft cloud band, generated once per planet and scrolled as you turn. */
  function cloudStrip() {
    const v = landing.v3;
    const cover = clamp(landing.weather ? landing.weather.cover : 0.3, 0.06, 0.95);
    const ckey = planet.hash + ':' + Math.round(cover * 10);
    if (v.clouds && v.cloudsKey === ckey) return v.clouds;
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 256;
    const g = c.getContext('2d');
    const rnd = Terra.mulberry32((planet.hash ^ 0x51ed270b) >>> 0);
    const clusters = Math.round(6 + cover * 46);
    for (let i = 0; i < clusters; i++) {
      const cx = rnd() * 1024, cy = 70 + rnd() * 140, w = 60 + rnd() * 140;
      for (let j = 0; j < 9; j++) {
        const px = cx + (rnd() - 0.5) * w, py = cy + (rnd() - 0.5) * w * 0.22;
        const r = (18 + rnd() * 34) * (0.6 + 0.4 * (cy / 210));
        for (let wrap = -1; wrap <= 1; wrap++) {
          const gx = px + wrap * 1024;
          const gr = g.createRadialGradient(gx, py, 0, gx, py, r);
          gr.addColorStop(0, 'rgba(255,255,255,0.55)');
          gr.addColorStop(0.6, 'rgba(250,252,255,0.25)');
          gr.addColorStop(1, 'rgba(250,252,255,0)');
          g.fillStyle = gr;
          g.fillRect(gx - r, py - r, r * 2, r * 2);
        }
      }
    }
    v.clouds = c; v.cloudsKey = ckey;
    return c;
  }

  function enterWalk() {
    const firstTime = !landing.pl;
    build3D();
    if (firstTime) {
      // Step out beside the ship, with the ship just left of centre.
      const x = clamp(landing.ship.x + 4, 2, LG - 3), y = clamp(landing.ship.y + 9, 2, LG - 3);
      const gz = ground3(x, y);
      const a = Math.atan2(landing.ship.y - y, landing.ship.x - x) + 0.35;
      landing.pl = { x, y, a, pitch: 0.04, z: gz, vz: 0, cam: gz + EYE3, onGround: true };
    }
    setLandView('3d');
    if (firstTime) toast('On foot. Arrows to walk, F to flood, M for the map');
  }

  function render3D(now, dt) {
    const P = landing.pl, ks = landing.keys;
    // --- movement -----------------------------------------------------------
    const run = ks.has('shift') ? 2.3 : 1;
    P.a += ((ks.has('arrowright') ? 1 : 0) - (ks.has('arrowleft') ? 1 : 0)) * 1.9 * dt;
    const fwd = (ks.has('arrowup') || ks.has('w') ? 1 : 0) - (ks.has('arrowdown') || ks.has('s') ? 1 : 0);
    const str = (ks.has('d') ? 1 : 0) - (ks.has('a') ? 1 : 0);
    const ca = Math.cos(P.a), sa = Math.sin(P.a);
    const sp = 8 * run * dt;
    P.x += (ca * fwd - sa * str) * sp;
    P.y += (sa * fwd + ca * str) * sp;
    const gz = ground3(P.x, P.y);
    if (ks.has(' ') && P.onGround) { P.vz = 7; P.onGround = false; }
    P.vz -= 20 * dt;
    P.z += P.vz * dt;
    if (P.z <= gz) { P.z = gz; P.vz = 0; P.onGround = true; }
    const bob = P.onGround && (fwd || str) ? Math.sin(now / (run > 1 ? 90 : 130)) * 0.05 : 0;
    P.cam = mix(P.cam, Math.max(P.z + EYE3 + bob, canopy3(P.x, P.y) + 0.35), 1 - Math.exp(-14 * dt));

    // --- sky: the real one over the pin ----------------------------------------
    const cv = landing.cvs, g = landing.ctx, CW = cv.width, CH = cv.height;
    const RH = clamp(Math.round(W3 * CH / Math.max(1, CW)), 150, 1000);
    const v = ensure3D(RH);
    landing.sun = pinSun();
    if (now - (v.litAt || 0) > 250) { v.litAt = now; light3D(false); }
    const sky = skyNow(), hz = sky.horizon, zn = sky.zenith, md = sky.mid;
    const sun = landing.sun, sinEl = Math.sin(sun.el), dayK = sky.day, oc = sky.oc;
    const hor = RH * (0.5 + P.pitch);
    const sxs = CW / W3, sys = CH / RH;
    const focal = (W3 / 2) / TANH3;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    const skyTop = (hor - 1.2 * focal) * sys, skyHor = hor * sys;
    const grad = g.createLinearGradient(0, skyTop, 0, skyHor);
    grad.addColorStop(0, 'rgb(' + zn + ')');
    grad.addColorStop(0.55, 'rgb(' + md + ')');
    grad.addColorStop(1, 'rgb(' + hz + ')');
    g.fillStyle = grad;
    g.fillRect(0, 0, CW, CH);
    const proj = (az, el) => {
      let d = az - P.a;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const ce = Math.cos(el), f = ce * Math.cos(d);
      if (f < 0.06) return null;
      return { x: (W3 / 2 + (ce * Math.sin(d) / f) * focal) * sxs, y: (hor - (Math.sin(el) / f) * focal) * sys };
    };
    // Stars, and the planet's rings, come out as the sky darkens.
    const starK = (1 - Terra.smoothstep(0.05, 0.55, dayK)) * (1 - oc * 0.9);
    if (starK > 0.02) {
      if (!v.stars) {
        const r = Terra.mulberry32(7331);
        v.stars = [];
        for (let i = 0; i < 420; i++) v.stars.push({ az: r() * Math.PI * 2, el: Math.asin(r()), m: 0.3 + r() * 0.7 });
      }
      g.fillStyle = '#fff';
      for (const st of v.stars) {
        const q = proj(st.az, st.el);
        if (!q) continue;
        g.globalAlpha = starK * st.m * (0.75 + 0.25 * Math.sin(now * 0.002 + st.az * 40));
        const sz = (st.m > 0.85 ? 2 : 1.2) * sys;
        g.fillRect(q.x, q.y, sz, sz);
      }
      g.globalAlpha = 1;
    }
    if (planet.traits.rings) drawSkyRings(g, proj, sys, Math.max(starK, 0.28 * (1 - oc)));
    // Twilight glow on the horizon around the sun.
    const sunPos = proj(sun.az, Math.max(sun.el, -0.02));
    if (sky.tw > 0.05 && sunPos) {
      const R0 = 0.9 * focal * sxs;
      const tg = g.createRadialGradient(sunPos.x, skyHor, 0, sunPos.x, skyHor, R0);
      tg.addColorStop(0, 'rgba(255,150,80,' + (0.55 * sky.tw * (1 - oc)) + ')');
      tg.addColorStop(1, 'rgba(255,120,60,0)');
      g.fillStyle = tg;
      g.fillRect(sunPos.x - R0, skyHor - R0, R0 * 2, R0 * 2);
    }
    // The sun where it really is: warmer and larger near the horizon, dimmed by cloud.
    const sunVisible = !!sunPos && sun.el > -0.06;
    const sunX = sunPos ? sunPos.x : 0, sunY = sunPos ? sunPos.y : 0;
    if (sunVisible) {
      const warm = Terra.smoothstep(0, 0.4, sinEl), dim = 1 - 0.85 * oc;
      const R1 = 260 * sys;
      const bloom = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, R1);
      bloom.addColorStop(0, 'rgba(255,' + Math.round(mix(190, 244, warm)) + ',' + Math.round(mix(140, 214, warm)) + ',' + (0.55 * dim) + ')');
      bloom.addColorStop(0.25, 'rgba(255,236,200,' + (0.18 * dim) + ')');
      bloom.addColorStop(1, 'rgba(255,230,190,0)');
      g.fillStyle = bloom;
      g.fillRect(sunX - R1, sunY - R1, R1 * 2, R1 * 2);
      const R2 = (16 + 9 * (1 - warm)) * sys;
      const core = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, R2);
      core.addColorStop(0, 'rgba(255,255,248,' + dim + ')');
      core.addColorStop(0.7, 'rgba(255,' + Math.round(mix(206, 252, warm)) + ',' + Math.round(mix(150, 236, warm)) + ',' + (0.95 * dim) + ')');
      core.addColorStop(1, 'rgba(255,248,230,0)');
      g.fillStyle = core;
      g.fillRect(sunX - R2, sunY - R2, R2 * 2, R2 * 2);
    }
    // The moon rides opposite the sun at night.
    if (dayK < 0.5) {
      const mp = proj(sun.az + Math.PI, clamp(-sun.el, 0.15, 1.1));
      if (mp) {
        const mk = (1 - dayK * 2) * (1 - 0.8 * oc), Rm = 9 * sys;
        const mg = g.createRadialGradient(mp.x, mp.y, 0, mp.x, mp.y, Rm * 6);
        mg.addColorStop(0, 'rgba(220,230,255,' + 0.25 * mk + ')');
        mg.addColorStop(1, 'rgba(220,230,255,0)');
        g.fillStyle = mg;
        g.fillRect(mp.x - Rm * 6, mp.y - Rm * 6, Rm * 12, Rm * 12);
        g.fillStyle = 'rgba(236,240,255,' + 0.95 * mk + ')';
        g.beginPath(); g.arc(mp.x, mp.y, Rm, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(176,186,212,' + 0.5 * mk + ')';
        g.beginPath(); g.arc(mp.x - Rm * 0.3, mp.y - Rm * 0.2, Rm * 0.28, 0, Math.PI * 2); g.arc(mp.x + Rm * 0.35, mp.y + Rm * 0.3, Rm * 0.2, 0, Math.PI * 2); g.fill();
      }
    }
    // Clouds from the globe's own cloud layer over this spot; a grey lid when overcast.
    const strip = cloudStrip();
    const stripH = 0.55 * focal * sys, stripY = (hor - 0.62 * focal) * sys, stripW = stripH * 4;
    let off = -(((P.a / (Math.PI * 2)) * stripW * 2 + now * 0.004 * sys) % stripW);
    if (off > 0) off -= stripW;
    g.globalAlpha = clamp((0.3 + 0.65 * landing.weather.cover) * (0.18 + 0.82 * dayK), 0, 1);
    for (let x = off; x < CW; x += stripW) g.drawImage(strip, x, stripY, stripW, stripH);
    g.globalAlpha = 1;
    if (oc > 0.05) { g.fillStyle = 'rgba(' + md + ',' + (oc * 0.45) + ')'; g.fillRect(0, 0, CW, skyHor); }

    // --- terrain (voxel space, front to back) --------------------------------
    const tRender = performance.now();
    const px = v.px, ybuf = v.ybuf, hw = v.hw, cr = v.cr, cgc = v.cg, cbc = v.cb, wet = v.wet, dep = v.depth;
    px.fill(0);
    ybuf.fill(RH);
    const cam = P.cam, rx = -sa, ry = ca, tt = now / 1000;
    if (!v.glint || v.glint.length !== W3) v.glint = new Float32Array(W3);
    const glintK = Terra.smoothstep(-0.02, 0.1, sinEl) * (1 - oc);
    for (let i = 0; i < W3; i++) {
      let d = sun.az - (P.a + Math.atan((i - W3 / 2) / focal));
      d = Math.atan2(Math.sin(d), Math.cos(d));
      v.glint[i] = Math.exp(-(d * d) / 0.018) * glintK;
    }
    const wl = mix(0.22, 1, dayK) * (1 - 0.3 * oc);
    const glint = v.glint;
    const wx = landing.weather;
    const FOGK = 0.011 * (1 + 1.3 * wx.mist + (wx.precip ? 0.8 * wx.precip.k : 0) + (wx.dusty ? 0.5 : 0));
    const fogNorm = 1 / (1 - Math.exp(-FAR3 * FOGK));
    let z = 0.3, dz = 0.02;
    while (z < FAR3) {
      const lx = P.x + (ca - rx * TANH3) * z, ly = P.y + (sa - ry * TANH3) * z;
      const ddx = (rx * TANH3 * 2 * z) / W3, ddy = (ry * TANH3 * 2 * z) / W3;
      const inv = focal / z;
      const fog = Math.min(1, (1 - Math.exp(-z * FOGK)) * fogNorm);
      const refl = 0.16 + 0.58 * (1 - 1 / (1 + z * 0.05));
      const near = z < 14;
      let sx = lx, sy = ly;
      for (let i = 0; i < W3; i++, sx += ddx, sy += ddy) {
        const yb = ybuf[i];
        if (yb <= 0) continue;
        const mx = mirror3(sx), my = mirror3(sy);
        const x0 = mx | 0, y0 = my | 0, fx = mx - x0, fy = my - y0;
        const x1 = x0 < LG - 1 ? x0 + 1 : x0, y1 = y0 < LG - 1 ? y0 + 1 : y0;
        const a = y0 * LG + x0, b = y0 * LG + x1, c = y1 * LG + x0, d = y1 * LG + x1;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const h = hw[a] * w00 + hw[b] * w10 + hw[c] * w01 + hw[d] * w11;
        let top = (hor + (cam - h) * inv) | 0;
        if (top >= yb) continue;
        if (top < 0) top = 0;
        let R = cr[a] * w00 + cr[b] * w10 + cr[c] * w01 + cr[d] * w11;
        let G = cgc[a] * w00 + cgc[b] * w10 + cgc[c] * w01 + cgc[d] * w11;
        let Bc = cbc[a] * w00 + cbc[b] * w10 + cbc[c] * w01 + cbc[d] * w11;
        const wt = wet[a] * w00 + wet[b] * w10 + wet[c] * w01 + wet[d] * w11;
        if (wt > 0.02) {
          // Water: clear and turquoise in the shallows, deep blue offshore,
          // reflecting the sky more at a distance, with ripples, a sun glint and shore foam.
          const dp = dep[a] * w00 + dep[b] * w10 + dep[c] * w01 + dep[d] * w11;
          const deepK = 1 - Math.exp(-dp * 0.9);
          let wr = mix(62, 10, deepK) * wl, wg = mix(170, 52, deepK) * wl, wb = mix(178, 90, deepK) * wl;
          const clear = Math.exp(-dp * 2.4) * 0.7;
          wr = mix(wr, R, clear); wg = mix(wg, G, clear); wb = mix(wb, Bc, clear);
          const rip = Math.sin(sx * 2.3 + tt * 1.8) * Math.sin(sy * 1.9 - tt * 1.4) +
            0.5 * Math.sin(sx * 5.1 - tt * 2.6 + sy * 3.7);
          wr = mix(wr, hz[0], refl); wg = mix(wg, hz[1], refl); wb = mix(wb, hz[2], refl);
          const lum = 1 + 0.06 * rip;
          wr *= lum; wg *= lum; wb *= lum;
          if (z > 2) {
            const sp2 = glint[i] * Math.max(0, rip) * (0.35 + refl);
            wr += 255 * sp2; wg += 245 * sp2; wb += 220 * sp2;
          }
          if (dp < 0.07) {
            const foam = (1 - dp / 0.07) * (0.45 + 0.25 * Math.sin(tt * 2.2 + sx * 3 + sy * 2));
            wr = mix(wr, 245, foam); wg = mix(wg, 248, foam); wb = mix(wb, 250, foam);
          }
          const k = wt >= 0.5 ? 1 : wt * 2;
          R = mix(R, wr, k); G = mix(G, wg, k); Bc = mix(Bc, wb, k);
        } else if (near) {
          const n = 0.97 + 0.06 * hash01(sx * 3, sy * 3);
          R *= n; G *= n; Bc *= n;
        }
        if (fog > 0) { R = mix(R, hz[0], fog); G = mix(G, hz[1], fog); Bc = mix(Bc, hz[2], fog); }
        const col = 0xff000000 | ((Bc > 255 ? 255 : Bc) << 16) | ((G > 255 ? 255 : G) << 8) | (R > 255 ? 255 : R);
        for (let y = top, o = top * W3 + i; y < yb; y++, o += W3) px[o] = col;
        ybuf[i] = top;
      }
      z += dz;
      dz = 0.02 + z * 0.011;
    }
    v.octx.putImageData(v.img, 0, 0);
    v.ema = v.ema * 0.85 + (performance.now() - tRender) * 0.15;
    if (++v.frames % 20 === 0) {
      const maxW = Math.min(1280, CW);
      if (v.ema > 20 && W3 > 360) W3 = Math.round(W3 * 0.85 / 2) * 2;
      else if (v.ema < 10 && W3 < maxW) W3 = Math.min(maxW, Math.round(W3 * 1.1 / 2) * 2);
    }
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(v.off, 0, 0, W3, RH, 0, 0, CW, CH);

    // Light haze over the horizon line and a soft sun glow over the land.
    const haze = g.createLinearGradient(0, skyHor - 40 * sys, 0, skyHor + 24 * sys);
    haze.addColorStop(0, 'rgba(' + hz + ',0)');
    haze.addColorStop(0.6, 'rgba(' + hz + ',0.35)');
    haze.addColorStop(1, 'rgba(' + hz + ',0)');
    g.fillStyle = haze;
    g.fillRect(0, skyHor - 40 * sys, CW, 64 * sys);
    if (sunVisible) {
      g.globalCompositeOperation = 'lighter';
      const R3 = 180 * sys;
      const glow = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, R3);
      glow.addColorStop(0, 'rgba(255,236,200,0.22)');
      glow.addColorStop(1, 'rgba(255,236,200,0)');
      g.fillStyle = glow;
      g.fillRect(sunX - R3, sunY - R3, R3 * 2, R3 * 2);
      g.globalCompositeOperation = 'source-over';
    }
    // Vignette.
    const vg = g.createRadialGradient(CW / 2, CH / 2, Math.min(CW, CH) * 0.35, CW / 2, CH / 2, Math.hypot(CW, CH) * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,10,0.38)');
    g.fillStyle = vg;
    g.fillRect(0, 0, CW, CH);

    if (wx.precip) drawPrecip(g, CW, CH, sys, dt, wx.precip, dayK);

    // Crosshair marks where tools 1-5 will act.
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.lineWidth = Math.max(1, sys);
    const cx = CW / 2, cyy = CH / 2;
    g.beginPath(); g.moveTo(cx - 7 * sys, cyy); g.lineTo(cx + 7 * sys, cyy); g.moveTo(cx, cyy - 7 * sys); g.lineTo(cx, cyy + 7 * sys); g.stroke();

    // Read-out: ground under your feet.
    const ci = clamp(mirror3(P.y) | 0, 0, LG - 1) * LG + clamp(mirror3(P.x) | 0, 0, LG - 1);
    const bio = Terra.BIOMES[landing.biome[ci]];
    const em = Math.round(heightAboveSea(ci)), T = Math.round(landing.tNow[ci]);
    const dSea = Math.round((landing.sl - landing.sl0) * 8000);
    updateLandingInfo(false);
    const label = 'On foot: ' + localTimeLabel() + ' · ' + wx.label + ' · ' + (v.wet[ci] > 0.5 ? 'wading in ' : '') + bio.name + ' · ' +
      (em < 0 ? Math.abs(em).toLocaleString('en-US') + ' m deep' : em.toLocaleString('en-US') + ' m') + ' · ' +
      (T > 0 ? '+' : T < 0 ? '−' : '') + Math.abs(T) + ' °C' + (dSea ? ' · sea ' + (dSea > 0 ? '+' : '−') + Math.abs(dSea).toLocaleString('en-US') + ' m' : '');
    if (landing.readEl.textContent !== label) landing.readEl.textContent = label;
  }

  /** Point a few steps ahead of the walker, in local map cells. */
  function aheadCell() {
    const P = landing.pl;
    return { x: mirror3(P.x + Math.cos(P.a) * 6), y: mirror3(P.y + Math.sin(P.a) * 6) };
  }

  function shiftSea(dir) {
    const r = landing.range;
    landing.sl = clamp(landing.sl + dir * 0.0025 * r, climate.hmin, climate.hmax);
    recolorLanding();
  }

  function setLandView(view) {
    landing.view = view;
    const is3d = view === '3d';
    landing.root.classList.toggle('walking', is3d);
    if (landing.viewBtn) landing.viewBtn.textContent = is3d ? 'Map and tools (M)' : 'Walk around (M)';
    if (landing.hintEl) {
      landing.hintEl.textContent = is3d
        ? 'Arrows walk and turn · A/D strafe · Shift run · Space jump · drag to look · , and . move the clock an hour · F/G sea level · 1–5 tools'
        : 'WASD or arrow keys fly the ship · click or drag to use a tool · 1–5 pick a tool · , and . move the clock · F/G raise or lower the sea';
    }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    landing.look = null;
    sizeLanding();
  }

  /** Height in metres above the current local sea level (negative = depth). */
  function heightAboveSea(k) {
    const d = landing.h[k] - landing.sl;
    return d >= 0 ? 11000 * d * Math.sqrt(d) : d * 8000;
  }

  function landKey(e) {
    const k = String(e.key).toLowerCase();
    if (k === 'escape') { e.preventDefault(); closeLanding(); return; }
    if (k === 'm') { e.preventDefault(); if (landing.view === '3d') setLandView('map'); else enterWalk(); return; }
    if (k === 'f' || k === 'g') { e.preventDefault(); shiftSea(k === 'f' ? 1 : -1); return; }
    if (k === ',' || k === '.') {
      e.preventDefault();
      view.spin += (k === '.' ? 1 : -1) * (Math.PI * 2) / 24;   // one hour on this planet
      landing.sun = pinSun();
      if (landing.v3) light3D(true);
      updateLandingInfo(true);
      return;
    }
    if (k >= '1' && k <= '5') {
      e.preventDefault();
      setLandTool(LD_TOOLS[Number(k) - 1].id);
      if (landing.view === '3d' && landing.pl) { const c = aheadCell(); applyLandTool(c.x, c.y, !e.repeat); }
      return;
    }
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', ' '].indexOf(k) >= 0) {
      e.preventDefault();
      landing.keys.add(k);
    }
  }

  function drawShip(g, x, y, s, flame, t) {
    g.save();
    g.translate(x, y);
    g.scale(s, s);
    if (flame > 0.02) {
      const len = 22 * flame * (0.85 + 0.15 * Math.sin(t * 40));
      const fl = g.createLinearGradient(0, 4, 0, 4 + len);
      fl.addColorStop(0, 'rgba(255,240,180,0.95)');
      fl.addColorStop(1, 'rgba(255,120,40,0)');
      g.fillStyle = fl;
      g.beginPath(); g.moveTo(-4, 4); g.lineTo(0, 4 + len); g.lineTo(4, 4); g.closePath(); g.fill();
    }
    g.strokeStyle = '#cfd8f5'; g.lineWidth = 1.6; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-6, 2); g.lineTo(-11, 10); g.moveTo(6, 2); g.lineTo(11, 10);
    g.moveTo(-13.5, 10); g.lineTo(-8.5, 10); g.moveTo(8.5, 10); g.lineTo(13.5, 10);
    g.stroke();
    const body = g.createLinearGradient(0, -14, 0, 6);
    body.addColorStop(0, '#f4f7ff'); body.addColorStop(1, '#8792b8');
    g.fillStyle = body;
    g.beginPath(); g.moveTo(0, -14); g.quadraticCurveTo(10, -7, 9, 4); g.lineTo(-9, 4); g.quadraticCurveTo(-10, -7, 0, -14); g.closePath(); g.fill();
    g.fillStyle = '#6ee7ff';
    g.beginPath(); g.arc(0, -5, 3, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  function landFrame(now) {
    if (!landing.open) return;
    const dt = landing.last ? Math.min(0.05, (now - landing.last) / 1000) : 0;
    landing.last = now;
    if (landing.view === '3d' && landing.pl) {
      render3D(now, dt);
      landing.raf = requestAnimationFrame(landFrame);
      return;
    }
    const t = (now - landing.t0) / 1000;
    const descent = 1.8;
    const landed = t >= descent;
    if (!landing.walked && t > descent + 0.9) {
      landing.walked = true;
      enterWalk();
      landing.raf = requestAnimationFrame(landFrame);
      return;
    }
    const ks = landing.keys;
    const ax = (ks.has('d') || ks.has('arrowright') ? 1 : 0) - (ks.has('a') || ks.has('arrowleft') ? 1 : 0);
    const ay = (ks.has('s') || ks.has('arrowdown') ? 1 : 0) - (ks.has('w') || ks.has('arrowup') ? 1 : 0);
    const moving = landed && (ax || ay);
    if (moving) {
      const sp = 26 / Math.hypot(ax, ay);
      landing.ship.x = clamp(landing.ship.x + ax * sp * dt, 2, LG - 2);
      landing.ship.y = clamp(landing.ship.y + ay * sp * dt, 2, LG - 2);
    }

    const g = landing.ctx, d = landing.dpr || 1, S = landing.size, cell = S / LG;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(landing.off, 0, 0, S, S);
    landing.sun = pinSun();
    const skm = skyNow();
    if (skm.day < 0.98) { g.fillStyle = 'rgba(6,10,26,' + (1 - skm.day) * 0.55 + ')'; g.fillRect(0, 0, S, S); }
    updateLandingInfo(false);

    // Bases: little domes with a blinking beacon.
    landing.bases.forEach((b) => {
      const bx = b.x * cell, by = b.y * cell, r = Math.max(5, cell * 2.4);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath(); g.ellipse(bx, by + r * 0.15, r * 1.1, r * 0.35, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#e8eefc';
      g.beginPath(); g.arc(bx, by, r, Math.PI, 0); g.closePath(); g.fill();
      g.fillStyle = 'rgba(110,231,255,0.9)';
      g.fillRect(bx - r * 0.45, by - r * 0.35, r * 0.9, r * 0.18);
      const blink = 0.5 + 0.5 * Math.sin((now - b.t) / 260);
      g.fillStyle = 'rgba(255,120,90,' + (0.4 + 0.6 * blink) + ')';
      g.beginPath(); g.arc(bx, by - r - 2, 1.8, 0, Math.PI * 2); g.fill();
    });

    // Ship: descends with a burning engine, kicks up dust, then hovers.
    const shipX = landing.ship.x * cell, shipY = landing.ship.y * cell;
    const k = landed ? 1 : clamp(t / descent, 0, 1);
    const alt = landed ? (moving ? 0.06 : 0.02 + 0.01 * Math.sin(t * 3)) : 1 - (1 - Math.pow(1 - k, 3));
    const s = Math.max(0.8, S / 480) * (1 + alt * 1.6);
    g.fillStyle = 'rgba(0,0,0,' + (0.35 * (1 - alt * 0.6)) + ')';
    g.beginPath(); g.ellipse(shipX, shipY + 10, 12 * (1 - alt * 0.4) * Math.max(0.8, S / 480), 4 * Math.max(0.8, S / 480), 0, 0, Math.PI * 2); g.fill();
    if (t > descent - 0.2 && t < descent + 0.9) {
      const q = clamp((t - (descent - 0.2)) / 1.1, 0, 1);
      g.strokeStyle = 'rgba(230,220,200,' + (0.55 * (1 - q)) + ')';
      g.lineWidth = 3;
      g.beginPath(); g.ellipse(shipX, shipY + 10, 10 + q * 60, 3 + q * 18, 0, 0, Math.PI * 2); g.stroke();
    }
    drawShip(g, shipX, shipY - alt * S * 0.35, s, landed ? (moving ? 0.5 : 0) : 1, t);

    // Brush preview under the cursor.
    const p = landing.pointer;
    if (p && landing.tool !== 'base') {
      g.strokeStyle = 'rgba(255,255,255,0.65)';
      g.lineWidth = 1.2;
      g.beginPath(); g.arc(p.x * cell, p.y * cell, 6 * cell, 0, Math.PI * 2); g.stroke();
    }

    // Read-out: what is under the cursor, or under the ship.
    const fx = p ? p.x : landing.ship.x, fy = p ? p.y : landing.ship.y;
    const ci = clamp(fy | 0, 0, LG - 1) * LG + clamp(fx | 0, 0, LG - 1);
    const b = Terra.BIOMES[landing.biome[ci]];
    const em = Math.round(heightAboveSea(ci)), T = Math.round(landing.tNow[ci]);
    const label = (p ? 'Cursor' : (landed ? 'Ship' : 'Descending')) + ': ' + b.name + ' · ' +
      (em < 0 ? Math.abs(em).toLocaleString('en-US') + ' m deep' : em.toLocaleString('en-US') + ' m') + ' · ' +
      (T > 0 ? '+' : T < 0 ? '−' : '') + Math.abs(T) + ' °C · ' + landing.bases.length + ' base' + (landing.bases.length === 1 ? '' : 's');
    if (landing.readEl.textContent !== label) landing.readEl.textContent = label;

    landing.raf = requestAnimationFrame(landFrame);
  }

  window.addEventListener('keydown', (e) => {
    if (!dom.helpModal.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeHelp(); }
      else if (e.key === 'Tab') trapFocus(e);
      return;
    }
    if (game) {
      const gk = e.key;
      if (game.state === 'upgrade') {
        if (gk >= '1' && gk <= '3' && game.upgradeOptions[Number(gk) - 1]) { e.preventDefault(); pickSkill(game.upgradeOptions[Number(gk) - 1].id); }
        else if (gk === 'a' || gk === 'A') toggleSound();
        return;
      }
      if (gk === 'Escape') { e.preventDefault(); if (game.state === 'playing') togglePause(); else exitGame(); }
      else if (gk === ' ' || gk === 'Spacebar') {
        if (game.state === 'playing' || game.state === 'paused') { e.preventDefault(); togglePause(); }
      } else if ((gk === 'a' || gk === 'A') && !e.ctrlKey && !e.metaKey) toggleSound();
      else if (gk === 'Enter' && (game.state === 'intro' || game.state === 'over') && !(e.target && e.target.tagName === 'BUTTON')) { e.preventDefault(); startGame(); }
      return;
    }
    if (landing.open) { landKey(e); return; }
    if (e.key === 'Escape' && landing.pickMode) { setLandPick(false); return; }
    if (e.key === 'Escape') {
      if (document.body.classList.contains('photo')) setPhoto(false);
      if (document.activeElement === dom.seed) { dom.seed.value = state.seed; dom.seed.blur(); refreshSeedStatus(); }
      hideTip();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target)) return;
    const k = e.key;
    let handled = true;
    if (k === '?') openHelp();
    else if (k === '/') { dom.seed.focus(); dom.seed.select(); }
    else if (k === 'r' || k === 'R') randomPlanet();
    else if (k === ' ' || k === 'Spacebar') {
      if (e.target && e.target.tagName === 'BUTTON') { handled = false; }
      else togglePlay();
    }
    else if (k === 'm' || k === 'M') setView(state.view === 'map' ? 'globe' : 'map');
    else if (k === 'c' || k === 'C') setToggle('clouds', !state.clouds);
    else if (k === 'l' || k === 'L') setToggle('lights', !state.lights);
    else if (k === 'g' || k === 'G') setToggle('grid', !state.grid);
    else if (k === 't' || k === 'T') { setLapse(!lapse); }
    else if (k === 'a' || k === 'A') toggleSound();
    else if (k === 'h' || k === 'H') setPhoto(!document.body.classList.contains('photo'));
    else if (k === 'k' || k === 'K') startDoom();
    else if (k === 'd' || k === 'D') openGame();
    else if (k === 'x' || k === 'X') resetSliders();
    else if (k === 'e' || k === 'E') landCommand(true);
    else if (k === 's' || k === 'S') share();
    else if (k === 'p' || k === 'P') savePostcard();
    else if ((k === '+' || k === '=') && state.view === 'globe') setZoom(view.targetZoom * 1.2);
    else if ((k === '-' || k === '_') && state.view === 'globe') setZoom(view.targetZoom / 1.2);
    else if (k === '0') resetView();
    else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      const step = 0.12;
      if (state.view === 'globe') {
        if (k === 'ArrowLeft') view.yaw -= step;
        if (k === 'ArrowRight') view.yaw += step;
        if (k === 'ArrowUp') view.pitch = clamp(view.pitch - step, -PITCH_LIMIT, PITCH_LIMIT);
        if (k === 'ArrowDown') view.pitch = clamp(view.pitch + step, -PITCH_LIMIT, PITCH_LIMIT);
      } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        view.mapPan += k === 'ArrowLeft' ? -0.03 : 0.03;
      } else handled = false;
      dirty = true;
    } else if (k >= '1' && k <= '9' && Terra.PRESETS[Number(k) - 1]) applyPreset(Terra.PRESETS[Number(k) - 1]);
    else handled = false;
    if (handled) { e.preventDefault(); markInteracted(); }
  });

  // ---------------------------------------------------------------------------
  // Seed input
  // ---------------------------------------------------------------------------
  let seedTimer = 0;
  function refreshSeedStatus() {
    const v = Terra.normalizeSeed(dom.seed.value);
    if (!v) dom.seedStatus.textContent = document.activeElement === dom.seed ? 'type a seed' : '';
    else if (v !== state.seed) dom.seedStatus.textContent = 'enter ↵';
    else dom.seedStatus.textContent = '';
  }
  dom.seed.addEventListener('input', () => {
    clearTimeout(seedTimer);
    refreshSeedStatus();
    seedTimer = setTimeout(() => {
      if (requestSeed(dom.seed.value)) refreshSeedStatus();
    }, 550);
  });
  dom.seed.addEventListener('focus', refreshSeedStatus);
  dom.seed.addEventListener('blur', () => {
    // An empty box falls back to the planet on screen.
    if (!Terra.normalizeSeed(dom.seed.value)) dom.seed.value = state.seed;
    refreshSeedStatus();
  });
  dom.seedForm.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(seedTimer);
    if (!requestSeed(dom.seed.value)) { sfx('error'); toast('Type a word or number to create a planet'); return; }
    refreshSeedStatus();
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) dom.seed.blur();
  });

  function randomPlanet() {
    sfx('dice');
    let s = Terra.randomSeed();
    for (let i = 0; i < 5 && s === state.seed; i++) s = Terra.randomSeed();
    clearTimeout(seedTimer);
    dom.seed.value = s;
    requestSeed(s);
    refreshSeedStatus();
    dom.random.classList.remove('roll');
    void dom.random.offsetWidth; // restart the animation
    dom.random.classList.add('roll');
    markInteracted();
  }

  // ---------------------------------------------------------------------------
  // Share link & URL hash
  // ---------------------------------------------------------------------------
  let hashTimer = 0, lastHash = '';
  function scheduleHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(writeHash, 300);
  }
  function writeHash() {
    const h = Terra.toHash(state);
    if (h === location.hash) { lastHash = h; return; }
    lastHash = h;
    try { history.replaceState(null, '', h); }
    catch (e) { try { location.replace(h); } catch (e2) { /* ignore */ } }
  }
  window.addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    applyExternalState(Terra.parseHash(location.hash));
  });

  function applyExternalState(s) {
    if (game) exitGame();
    tween = null;
    setLapse(false);
    state.temp = s.temp; state.water = s.water; state.terrain = s.terrain; state.speed = s.speed;
    climateDirty = true;
    syncSliders();
    updatePlayButton();
    setView(s.view);
    dom.seed.value = s.seed;
    requestSeed(s.seed);
    refreshSeedStatus();
  }

  function shareUrl() {
    const base = location.href.split('#')[0];
    return base + Terra.toHash(state);
  }

  function share() {
    writeHash();
    const url = shareUrl();
    const done = (ok) => sfx(ok ? 'chime' : 'error') || toast(ok ? 'Link copied. Anyone who opens it sees this exact planet.' : 'Copy this link: ' + url, ok ? 2600 : 6000);
    const legacy = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) { return false; }
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(() => done(true), () => done(legacy()));
    } else done(legacy());
  }

  // ---------------------------------------------------------------------------
  // Postcard export
  // ---------------------------------------------------------------------------
  function savePostcard() {
    if (!planet || !climate) { toast('Wait a moment, the planet is still forming'); return; }
    try {
      const W = 1600, H = 900;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#0a0e26'); bg.addColorStop(1, '#03040b');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      const neb = g.createRadialGradient(1150, 220, 0, 1150, 220, 700);
      neb.addColorStop(0, 'rgba(110,70,200,0.28)'); neb.addColorStop(1, 'rgba(110,70,200,0)');
      g.fillStyle = neb; g.fillRect(0, 0, W, H);
      const r = Terra.mulberry32(planet.hash);
      for (let i = 0; i < 420; i++) {
        g.fillStyle = 'rgba(255,255,255,' + (0.2 + r() * 0.7) + ')';
        g.beginPath(); g.arc(r() * W, r() * H, 0.3 + Math.pow(r(), 3) * 1.6, 0, Math.PI * 2); g.fill();
      }

      const N = 760, cx = 500, cy = 450, R = 300;
      const tmp = document.createElement('canvas');
      tmp.width = tmp.height = N;
      const tctx = tmp.getContext('2d');
      const img = tctx.createImageData(N, N);
      const P = frameParams();
      shadeGlobe(img.data, N, N, P);
      tctx.putImageData(img, 0, 0);
      drawHalo(g, cx, cy, R, P.atm, P.sun, 1);
      drawRings(g, cx, cy, R, false, 1);
      g.imageSmoothingQuality = 'high';
      g.drawImage(tmp, cx - R, cy - R, R * 2, R * 2);
      drawRings(g, cx, cy, R, true, 1);

      const st = climate.stats;
      const font = getComputedStyle(document.body).fontFamily;
      const x = 980;
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#6ee7ff';
      g.font = '700 22px ' + font;
      g.fillText('PLANET ID · ' + planet.designation, x, 210);
      g.fillStyle = '#ffffff';
      g.font = '800 84px ' + font;
      g.fillText(planet.name, x - 4, 300);
      g.fillStyle = '#b8c2e8';
      g.font = '600 30px ' + font;
      g.fillText(st.className, x, 348);

      const rows = [
        ['Ocean', Math.round(st.waterFrac * 100) + '%'],
        ['Average temperature', Math.round(st.avgTemp) + ' °C'],
        ['Highest peak', st.hasLand ? Math.round(st.peak).toLocaleString('en-US') + ' m' : 'No land'],
        ['Habitability', st.habitability + ' / 100 · ' + st.habLabel],
      ];
      g.font = '500 24px ' + font;
      rows.forEach((row, i) => {
        const y = 420 + i * 52;
        g.fillStyle = 'rgba(150,175,255,0.18)';
        g.fillRect(x, y + 16, 520, 1);
        g.fillStyle = '#8f9bc6';
        g.fillText(row[0], x, y);
        g.fillStyle = '#ffffff';
        g.textAlign = 'right';
        g.fillText(row[1], x + 520, y);
        g.textAlign = 'left';
      });
      g.fillStyle = '#d5dcf5';
      g.font = 'italic 400 22px ' + font;
      wrapText(g, '“' + st.note + '”', x, 660, 540, 32, 4);
      g.fillStyle = '#626c95';
      g.font = '500 18px ' + font;
      const seedLabel = planet.seed.length > 40 ? planet.seed.slice(0, 40) + '…' : planet.seed;
      g.fillText('Seed “' + seedLabel + '” · Tiny Terra', x, 830);

      const filename = 'tiny-terra-' + planet.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png';
      const finish = (url, revoke) => {
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        if (revoke) setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast('Postcard saved: ' + filename);
        sfx('shutter');
      };
      if (c.toBlob) c.toBlob((blob) => { if (blob) finish(URL.createObjectURL(blob), true); else finish(c.toDataURL('image/png'), false); }, 'image/png');
      else finish(c.toDataURL('image/png'), false);
    } catch (e) {
      toast('Could not create the postcard on this browser');
    }
  }

  function wrapText(g, text, x, y, maxW, lh, maxLines) {
    const words = text.split(' ');
    let line = '', lines = 0;
    for (let i = 0; i < words.length; i++) {
      const test = line ? line + ' ' + words[i] : words[i];
      if (g.measureText(test).width > maxW && line) {
        if (lines === maxLines - 1) { g.fillText(line + '…', x, y); return; }
        g.fillText(line, x, y);
        line = words[i]; y += lh; lines++;
      } else line = test;
    }
    if (line) g.fillText(line, x, y);
  }

  // ---------------------------------------------------------------------------
  // Toast & help
  // ---------------------------------------------------------------------------
  let toastTimer = 0;
  function toast(msg, ms) {
    dom.toast.textContent = msg;
    dom.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.remove('show'), ms || 2600);
  }

  let helpReturn = null;
  function openHelp() {
    sfx('click');
    helpReturn = document.activeElement;
    dom.helpModal.hidden = false;
    dom.helpClose.focus();
  }
  function closeHelp() {
    dom.helpModal.hidden = true;
    if (helpReturn && helpReturn.focus) helpReturn.focus();
  }
  function trapFocus(e) {
    const f = dom.helpModal.querySelectorAll('button, a[href]');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ---------------------------------------------------------------------------
  // Planet Defense: an arcade mode on top of the planet. Meteors fly in from
  // every side; click or tap them to shoot them down with a beam from the
  // surface. Impacts leave craters and cracks that turn with the planet.
  // Three hits and the planet shatters (the meteor strike is the game over).
  // Waves speed up, combos multiply the score, and the best score is kept.
  // ---------------------------------------------------------------------------
  const G_LIVES = 3;
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const gui = {
    root: $('game-ui'), lives: $('gh-lives'), score: $('gh-score'), wave: $('gh-wave'), combo: $('gh-combo'),
    best: $('gh-best'), banner: $('game-banner'), bTitle: $('gb-title'), bSub: $('gb-sub'),
    card: $('game-card'), tip: $('game-tip'), vignette: $('game-vignette'),
  };
  let game = null, gameFont = null;
  let bestScore = 0;
  try { bestScore = Math.floor(Number(localStorage.getItem('tinyterra-best')) || 0); } catch (e) { bestScore = 0; }
  if (!Number.isFinite(bestScore) || bestScore < 0 || bestScore > 1e9) bestScore = 0;

  function viewToPlanet(v) {
    const m = planetMatrix();
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  }
  function planetToView(p, m) {
    return [m[0] * p[0] + m[3] * p[1] + m[6] * p[2], m[1] * p[0] + m[4] * p[1] + m[7] * p[2], m[2] * p[0] + m[5] * p[1] + m[8] * p[2]];
  }
  /** A point on the visible disc (x right, y down, in planet radii) as a planet-space unit vector. */
  function discToPlanet(x, y) {
    const d2 = x * x + y * y, s = d2 > 0.97 ? Math.sqrt(0.97 / d2) : 1;
    const vx = x * s, vy = -y * s;
    return viewToPlanet([vx, vy, Math.sqrt(Math.max(0, 1 - vx * vx - vy * vy))]);
  }
  function population() {
    return climate && climate.stats.civilization ? (((planet.hash >>> 5) % 90) + 10) / 10 : 0;
  }
  function comboMult() { return Math.min(8, 1 + Math.floor(game.combo / 4)); }

  function newGameState(st, prevZoom) {
    return {
      state: st, score: 0, lives: G_LIVES, maxLives: G_LIVES, wave: 0, combo: 0, comboT: 0,
      skills: { heavy: 0, wide: 0, chain: 0, turret: 0, slow: 0, shield: 0 }, turretT: 2, pendingUpgrade: false, upgradeOptions: [],
      meteors: [], parts: [], beams: [], texts: [], rings: [], craters: [],
      spawnLeft: 0, spawnT: 0, breakT: 0, beatT: 0.6, beatN: 0, powerT: rnd(12, 20),
      shots: 0, hits: 0, kills: 0, shake: 0, nova: 0, newBest: false, prevZoom: prevZoom || 1,
    };
  }

  function openGame() {
    if (game || landing.open) return;
    if (landing.pickMode) setLandPick(false);
    if (!planet || !climate || builder) { toast('Wait a moment, the planet is still forming'); return; }
    if (doom) rebuildPlanet(true);
    if (!dom.helpModal.hidden) closeHelp();
    setLapse(false);
    tween = null;
    if (document.body.classList.contains('photo')) setPhoto(false);
    if (state.view !== 'globe') setView('globe');
    hideTip();
    hover = null;
    game = newGameState('intro', view.targetZoom);
    document.body.classList.add('gaming');
    resize();
    view.targetZoom = cssW < 700 ? 0.66 : 0.74;
    if (audio) audio.duck(true);
    gui.tip.classList.remove('gone');
    renderGameHud();
    showGameCard('intro');
    markInteracted();
    sfx('click');
  }

  function startGame() {
    if (!game) return;
    if (doom) { rebuildPlanet(true); introStart = reduceMotion ? -1 : performance.now(); }
    game = newGameState('playing', game.prevZoom);
    hideGameCard();
    gui.root.classList.remove('danger');
    renderGameHud();
    nextWave();
    sfx('start');
    clearTimeout(startGame.tipTimer);
    gui.tip.classList.remove('gone');
    startGame.tipTimer = setTimeout(() => gui.tip.classList.add('gone'), 6000);
  }

  function exitGame() {
    if (!game) return;
    const prevZoom = game.prevZoom;
    game = null;
    if (doom) rebuildPlanet(true);
    introStart = reduceMotion ? -1 : performance.now();
    document.body.classList.remove('gaming');
    gui.root.classList.remove('danger');
    gui.banner.classList.remove('show');
    hideGameCard();
    view.targetZoom = prevZoom || 1;
    if (audio) audio.duck(false);
    resize();
    dirty = true;
  }

  function togglePause() {
    if (!game) return;
    if (game.state === 'playing') { game.state = 'paused'; showGameCard('paused'); sfx('click'); }
    else if (game.state === 'paused') { game.state = 'playing'; hideGameCard(); sfx('click'); }
  }

  function nextWave() {
    game.wave++;
    game.spawnLeft = 6 + game.wave * 3;
    game.spawnT = 1.5;
    game.breakT = 0;
    banner('Wave ' + game.wave, game.wave === 1 ? 'Incoming' : game.wave % 3 === 0 ? 'Meteor storm' : 'Faster and bigger');
    sfx('wave');
    renderGameHud();
  }

  function banner(title, sub) {
    gui.bTitle.textContent = title;
    gui.bSub.textContent = sub || '';
    gui.banner.classList.remove('show');
    void gui.banner.offsetWidth;
    gui.banner.classList.add('show');
  }

  function renderGameHud() {
    if (!game) return;
    setNumber(gui.score, game.score, 'peak', true);
    gui.wave.textContent = 'Wave ' + Math.max(1, game.wave);
    gui.combo.textContent = '×' + comboMult();
    gui.best.textContent = Math.max(bestScore, game.score).toLocaleString('en-US');
    gui.lives.querySelectorAll('.life').forEach((el, i) => {
      el.classList.toggle('slot-off', i >= game.maxLives);
      el.classList.toggle('on', i < game.lives);
      el.classList.toggle('lost', i >= game.lives);
    });
    gui.lives.setAttribute('aria-label', game.lives + ' of ' + game.maxLives + ' shields left');
    renderSkillChips(false);
    gui.root.classList.toggle('danger', game.lives === 1 && game.state === 'playing');
  }

  function showGameCard(kind) {
    const c = gui.card;
    c.textContent = '';
    c.className = 'game-card show' + (kind === 'over' ? ' side' : '');
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const btn = (label, primary, fn) => { const b = el('button', 'g-btn' + (primary ? ' primary' : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
    const title = (text) => { const h = el('h2', null, text); h.id = 'gc-title'; return h; };
    const actions = el('div', 'gc-actions');
    if (kind === 'intro') {
      const pop = population();
      c.append(el('div', 'gc-eyebrow', 'Planet Defense'), title('Defend ' + planet.name),
        el('p', null, 'Meteors are inbound. Click or tap them before they hit. Three hits and ' + planet.name +
          ' is lost' + (pop ? ', along with its ' + pop.toFixed(1) + ' billion people.' : '.')));
      const rules = el('ul', 'gc-rules');
      [['#b48a63', 'Rocks: one shot · 100'], ['#6b4a35', 'Boulders: three shots, then they split · 250'],
        ['#ffd27a', 'Golden streaks: fast · 300'], ['#8cdcaa', 'Green orb: repairs a shield'], ['#aad2ff', 'Blue orb: nova, clears the sky']]
        .forEach(([col, text]) => { const li = el('li'); const d = el('span', 'gc-dot'); d.style.background = col; li.append(d, el('span', null, text)); rules.append(li); });
      c.append(rules);
      actions.append(btn('Start', true, startGame), btn('Back to the lab', false, exitGame));
      c.append(actions, el('div', 'gc-foot', 'Best score ' + bestScore.toLocaleString('en-US') + ' · chain hits for up to ×8 · Space pauses'));
    } else if (kind === 'upgrade') {
      c.className = 'game-card show upgrade';
      c.append(el('div', 'gc-eyebrow', 'Wave ' + game.wave + ' cleared'), title('Upgrade your guns'));
      const list = el('div', 'gc-skills');
      game.upgradeOptions.forEach((k, idx) => {
        const lv = game.skills[k.id];
        const b = el('button', 'g-skill');
        b.type = 'button';
        const ico = el('span', 'sk-ico', k.glyph); ico.style.background = k.col;
        const body = el('span');
        const nm = el('span', 'sk-name', k.name);
        const ds = el('span', 'sk-desc', k.desc(lv)); ds.style.display = 'block';
        body.append(nm, ds);
        const lvl = el('span', 'sk-lvl', (lv ? ROMAN[lv] + ' → ' : 'New · ') + ROMAN[lv + 1]);
        if (!coarse) { const kb = el('kbd', null, String(idx + 1)); lvl.appendChild(kb); }
        b.append(ico, body, lvl);
        b.addEventListener('click', () => pickSkill(k.id));
        list.append(b);
      });
      c.append(list, el('div', 'gc-foot', 'Pick one to start wave ' + (game.wave + 1)));
      const firstSkill = c.querySelector('.g-skill');
      if (firstSkill && !coarse) setTimeout(() => { try { firstSkill.focus({ preventScroll: true }); } catch (e) { firstSkill.focus(); } }, 60);
      return;
    } else if (kind === 'paused') {
      c.append(el('div', 'gc-eyebrow', 'Planet Defense'), title('Paused'),
        el('p', null, 'Wave ' + game.wave + ' · score ' + game.score.toLocaleString('en-US') + '. The meteors will wait.'));
      actions.append(btn('Resume', true, togglePause), btn('Quit', false, exitGame));
      c.append(actions);
    } else {
      const m = coreModel();
      c.append(el('div', 'gc-eyebrow', 'Game over'), title(planet.name + ' is lost'),
        el('p', null, 'Its ' + m.comp + ' core lies open at ' + m.innerTemp.toLocaleString('en-US') + ' °C.'));
      const stats = el('div', 'gc-stats');
      const acc = game.shots ? Math.round((game.hits / game.shots) * 100) : 0;
      [['Score', game.score.toLocaleString('en-US'), game.newBest], ['Wave reached', String(game.wave), false],
        ['Meteors destroyed', String(game.kills), false], ['Accuracy', acc + '%', false]].forEach(([label, value, isNew]) => {
        const s = el('div', 'gc-stat');
        s.append(el('span', null, label), el('b', null, value));
        if (isNew) s.append(el('em', 'gc-new', 'NEW BEST'));
        stats.append(s);
      });
      actions.append(btn('Play again', true, startGame), btn('Back to the lab', false, exitGame));
      c.append(stats, actions, el('div', 'gc-foot', 'Best score ' + bestScore.toLocaleString('en-US')));
    }
    const first = c.querySelector('.g-btn.primary');
    if (first && !coarse) setTimeout(() => { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }, 60);
  }
  function hideGameCard() { gui.card.className = 'game-card'; gui.card.textContent = ''; }

  // --- spawning -------------------------------------------------------------
  function farRadius() {
    const R = Math.max(40, globeRadius());
    const { cx, cy } = layout;
    return (Math.hypot(Math.max(cx, cssW - cx), Math.max(cy, cssH - cy)) + 50) / R;
  }
  function rockShape(n) { const pts = []; for (let i = 0; i < n; i++) pts.push(rnd(0.72, 1.12)); return pts; }

  /** Distance (in planet radii) from the planet centre to just beyond the screen edge, along angle a. */
  function edgeRadius(a) {
    const R = Math.max(40, globeRadius()), { cx, cy } = layout;
    const c = Math.cos(a), s2 = Math.sin(a);
    const tx = c > 1e-6 ? (cssW - cx) / c : c < -1e-6 ? -cx / c : Infinity;
    const ty = s2 > 1e-6 ? (cssH - cy) / s2 : s2 < -1e-6 ? -cy / s2 : Infinity;
    return (Math.min(tx, ty) + 36) / R;
  }

  function spawnMeteor(kind, from) {
    const a = rnd(0, Math.PI * 2), edge = edgeRadius(a);
    const ta = rnd(0, Math.PI * 2), tr = Math.sqrt(rnd(0, 0.62));
    const sx = from ? from[0] : Math.cos(a) * edge, sy = from ? from[1] : Math.sin(a) * edge;
    const tx = Math.cos(ta) * tr, ty = Math.sin(ta) * tr;
    // Speed in planet radii per second: faster every wave.
    const speed = Math.min(1.5, 0.55 + 0.09 * (game.wave - 1)) * (kind === 'big' ? 0.72 : kind === 'fast' ? 2.1 : rnd(0.9, 1.12));
    const m = {
      kind, sx, sy, tx, ty, t: 0,
      dur: from ? from[2] : Math.max(1.5, Math.hypot(tx - sx, ty - sy) / speed),
      size: kind === 'big' ? 0.125 : kind === 'fast' ? 0.048 : rnd(0.062, 0.086),
      hp: kind === 'big' ? 3 : 1, rot: rnd(0, 6.28), spin: rnd(-2.5, 2.5), shape: rockShape(kind === 'big' ? 11 : 8), flash: 0,
    };
    m.maxHp = m.hp;
    game.meteors.push(m);
    return m;
  }

  function spawnPower() {
    const far = farRadius();
    const kind = game.lives < game.maxLives && Math.random() < 0.65 ? 'repair' : 'nova';
    const a = rnd(0, Math.PI * 2), b = a + Math.PI + rnd(-0.5, 0.5);
    game.meteors.push({ kind, power: true, sx: Math.cos(a) * far, sy: Math.sin(a) * far, tx: Math.cos(b) * far, ty: Math.sin(b) * far,
      t: 0, dur: 8.5, size: 0.06, hp: 1, maxHp: 1, rot: 0, spin: 1.6, flash: 0 });
  }

  function meteorPos(m) {
    const R = Math.max(40, globeRadius());
    const k = clamp(m.t / m.dur, 0, 1);
    const e = m.power ? k : k * (0.55 + 0.45 * k); // rocks speed up as they fall in
    const nx = m.sx + (m.tx - m.sx) * e, ny = m.sy + (m.ty - m.sy) * e;
    return { x: layout.cx + nx * R, y: layout.cy + ny * R, nx, ny, k, r: Math.max(m.power ? 13 : 8, m.size * R * (m.power ? 1 : 0.8 + 0.35 * k)) };
  }

  // --- player actions --------------------------------------------------------
  function shoot(clientX, clientY) {
    if (!game || game.state !== 'playing') return;
    const rect = dom.canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    game.shots++;
    let best = null, bd = Infinity;
    for (const m of game.meteors) {
      const p = meteorPos(m);
      const reach = Math.max(p.r * 1.5, coarse ? 30 : 20) * (1 + 0.35 * game.skills.wide);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < reach && d < bd) { bd = d; best = { m, p }; }
    }
    fireBeam(best ? best.p.x : x, best ? best.p.y : y);
    if (!best) {
      if (game.combo > 0) { game.combo = 0; renderGameHud(); }
      puff(x, y, '236,233,224', 6);
      sfx('miss');
      return;
    }
    game.hits++;
    const { m, p } = best;
    if (m.power) { collectPower(m, p); return; }
    hitMeteor(m, p, 1 + game.skills.heavy);
  }

  /** Damages a meteor; returns true if it was destroyed. */
  function hitMeteor(m, p, dmg, chained) {
    m.hp -= dmg;
    m.flash = 1;
    if (m.hp > 0) { puff(p.x, p.y, '255,200,120', 9); sfx('clink'); return false; }
    destroyMeteor(m, p, true, chained);
    return true;
  }

  /** Chain lightning: a kill arcs to the nearest meteors. */
  function chainFrom(p, count) {
    const R = Math.max(40, globeRadius());
    const used = new Set();
    let from = p;
    for (let c = 0; c < count; c++) {
      let best = null, bd = R * 2.4;
      for (const m of game.meteors) {
        if (m.power || used.has(m)) continue;
        const q = meteorPos(m), d = Math.hypot(q.x - from.x, q.y - from.y);
        if (d < bd) { bd = d; best = { m, q }; }
      }
      if (!best) break;
      used.add(best.m);
      game.beams.push({ x0: from.x, y0: from.y, x1: best.q.x, y1: best.q.y, age: 0, life: 0.22, arc: true });
      hitMeteor(best.m, best.q, 1, true);
      from = best.q;
    }
  }

  function destroyMeteor(m, p, scored, chained) {
    const i = game.meteors.indexOf(m);
    if (i >= 0) game.meteors.splice(i, 1);
    const big = m.kind === 'big';
    explodeAt(p.x, p.y, p.r, m.kind === 'fast' ? '255,215,120' : '255,150,60', big ? 1.6 : 1);
    if (!scored) return;
    game.kills++;
    game.combo++;
    game.comboT = 2.4;
    const mult = comboMult();
    const pts = (big ? 250 : m.kind === 'fast' ? 300 : 100) * mult;
    game.score += pts;
    floatText(p.x, p.y - p.r - 6, '+' + pts + (mult > 1 ? ' ×' + mult : ''), m.kind === 'fast' ? '#ffd98a' : '#ecebe4');
    sfx('pop', game.combo);
    if (game.combo % 4 === 0) {
      sfx('combo', mult);
      gui.combo.classList.remove('pop'); void gui.combo.offsetWidth; gui.combo.classList.add('pop');
      if (mult >= 3) floatText(layout.cx, layout.cy - globeRadius() - 26, 'Combo ×' + mult + '!', '#d9b26f', 1.2);
    }
    if (game.skills.chain > 0 && !chained) setTimeout(() => { if (game && game.state === 'playing') chainFrom(p, game.skills.chain); }, 70);
    if (big) {
      for (let s = 0; s < 2; s++) {
        const child = spawnMeteor('rock', [p.nx, p.ny, Math.max(1.6, (m.dur - m.t) * 0.9 + rnd(0.2, 0.8))]);
        child.size = 0.058;
      }
    }
    renderGameHud();
  }

  function collectPower(m, p) {
    const i = game.meteors.indexOf(m);
    if (i >= 0) game.meteors.splice(i, 1);
    game.score += 150 * comboMult();
    if (m.kind === 'repair') {
      if (game.lives < game.maxLives) { game.lives++; game.craters.pop(); } // the newest crater heals over
      floatText(p.x, p.y - 22, 'Shield repaired', '#a9e0bd', 1.1);
      explodeAt(p.x, p.y, p.r, '140,220,170', 1.2);
      sfx('power');
    } else {
      floatText(p.x, p.y - 22, 'Nova!', '#cfe8ff', 1.1);
      explodeAt(p.x, p.y, p.r, '170,210,255', 1.6);
      game.nova = 0.7;
      game.meteors.filter((x) => !x.power).forEach((x, k) => {
        setTimeout(() => { if (game && game.state === 'playing' && game.meteors.includes(x)) destroyMeteor(x, meteorPos(x), true); }, k * 70);
      });
      sfx('nova');
    }
    renderGameHud();
  }

  function impact(m, p) {
    const i = game.meteors.indexOf(m);
    if (i >= 0) game.meteors.splice(i, 1);
    const big = m.kind === 'big';
    game.lives = Math.max(0, game.lives - 1);
    game.combo = 0;
    const cracks = makeCracks(m.tx, m.ty).map((poly) => poly.map((q) => discToPlanet(q[0], q[1])));
    game.craters.push({ p: discToPlanet(m.tx, m.ty), cracks, age: 0, size: big ? 1.5 : 1 });
    explodeAt(p.x, p.y, p.r * 1.4, '255,120,50', big ? 2 : 1.4);
    game.shake = reduceMotion ? 0 : 16;
    gui.vignette.classList.remove('hit'); void gui.vignette.offsetWidth; gui.vignette.classList.add('hit');
    gui.lives.classList.remove('hit'); void gui.lives.offsetWidth; gui.lives.classList.add('hit');
    sfx('hurt');
    renderGameHud();
    if (game.lives <= 0) loseGame();
  }

  function loseGame() {
    game.state = 'dying';
    gui.root.classList.remove('danger');
    game.meteors.forEach((m) => { const q = meteorPos(m); explodeAt(q.x, q.y, q.r, '255,150,60', 1); });
    game.meteors = [];
    if (game.score > bestScore) {
      bestScore = game.score;
      game.newBest = true;
      try { localStorage.setItem('tinyterra-best', String(bestScore)); } catch (e) { /* private mode */ }
    }
    // Hand the damage to the meteor-strike sequence: the cracks spread, the planet shatters, the core shows.
    const mtx = planetMatrix();
    const impacts = [];
    game.craters.forEach((c) => {
      const v = planetToView(c.p, mtx);
      if (v[2] <= 0.05) return;
      const cracks = c.cracks.map((poly) => {
        const out = [];
        for (const q of poly) { const w = planetToView(q, mtx); if (w[2] <= 0.02) break; out.push([w[0], -w[1]]); }
        return out;
      }).filter((poly) => poly.length > 1);
      impacts.push({ x: v[0], y: -v[1], sx: v[0], sy: -v[1], at: -5000, size: c.size, hit: true, cracks });
    });
    if (!impacts.length) impacts.push({ x: 0, y: 0, sx: 0, sy: 0, at: -5000, size: 1.2, hit: true, cracks: makeCracks(0, 0) });
    const swirls = [];
    for (let i = 0; i < 26; i++) swirls.push({ r: rnd(0.6, 0.9), a: rnd(0, Math.PI * 2), len: rnd(0.3, 1.1), w: rnd(0.006, 0.02), light: Math.random() < 0.5 });
    doom = { start: performance.now() - (T_EXPLODE - 1600), impacts, swirls, exploded: false, explodeAt: 0, cracked: true, coreShown: false,
      shards: null, debris: null, shake: 12, model: null, coreGeom: null, fromGame: true };
    game.craters = [];
    setDoomUi(true);
    banner(planet.name + ' is breaking up', 'Shields down');
    sfx('over');
    renderGameHud();
  }

  // --- gun upgrades ---------------------------------------------------------------
  const SKILLS = [
    { id: 'heavy', name: 'Heavy beam', col: '#ffb070', glyph: 'H', desc: (l) => 'Each shot hits for ' + (l + 2) + '. Boulders crumble faster.' },
    { id: 'wide', name: 'Wide beam', col: '#d9b26f', glyph: 'W', desc: (l) => 'Shots land ' + 35 * (l + 1) + '% wider. Easier to hit.' },
    { id: 'chain', name: 'Chain lightning', col: '#9fd2ff', glyph: 'C', desc: (l) => 'Every kill arcs to ' + (l + 1) + ' nearby meteor' + (l ? 's' : '') + '.' },
    { id: 'turret', name: 'Auto-turret', col: '#c7a4ff', glyph: 'T', desc: (l) => 'The planet fires on its own every ' + [2.4, 1.6, 1.0][l] + ' s.' },
    { id: 'slow', name: 'Gravity field', col: '#8cdcaa', glyph: 'G', desc: (l) => 'Meteors near the planet slow down by ' + 18 * (l + 1) + '%.' },
    { id: 'shield', name: 'Extra shield', col: '#a9e0bd', glyph: '+', desc: () => '+1 shield, restored now (up to 5).' },
  ];
  const ROMAN = ['', 'I', 'II', 'III'];

  function openUpgrade() {
    const pool = SKILLS.filter((k) => game.skills[k.id] < 3 && !(k.id === 'shield' && game.maxLives >= 5));
    if (!pool.length) return false;
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    game.upgradeOptions = pool.slice(0, 3);
    game.state = 'upgrade';
    showGameCard('upgrade');
    sfx('wave');
    return true;
  }

  function pickSkill(id) {
    if (!game || game.state !== 'upgrade') return;
    const k = SKILLS.find((x) => x.id === id);
    if (!k || !game.upgradeOptions.includes(k)) return;
    game.skills[id] = Math.min(3, game.skills[id] + 1);
    if (id === 'shield') { game.maxLives = Math.min(5, game.maxLives + 1); game.lives = Math.min(game.maxLives, game.lives + 1); }
    if (id === 'turret') game.turretT = 1;
    game.state = 'playing';
    hideGameCard();
    floatText(layout.cx, layout.cy - globeRadius() - 30, k.name + ' ' + ROMAN[game.skills[id]], '#d9b26f', 1.3);
    explodeAt(layout.cx, layout.cy, globeRadius() * 0.5, '217,178,111', 1.4);
    sfx('power');
    renderGameHud();
    renderSkillChips(id);
    game.breakT = 0.9;
  }

  function renderSkillChips(popId) {
    const box = $('gh-skills');
    if (!box || !game) return;
    box.textContent = '';
    SKILLS.forEach((k) => {
      const lv = game.skills[k.id];
      if (!lv) return;
      const chip = document.createElement('span');
      chip.className = 'skill-chip' + (popId === k.id ? ' pop' : '');
      chip.style.borderColor = k.col;
      chip.textContent = k.name;
      const i = document.createElement('i');
      i.textContent = ROMAN[lv];
      chip.appendChild(i);
      box.appendChild(chip);
    });
  }

  function turretFire() {
    const R = Math.max(40, globeRadius());
    let best = null, bd = Infinity;
    for (const m of game.meteors) {
      if (m.power) continue;
      const q = meteorPos(m);
      if (q.x < 0 || q.y < 0 || q.x > cssW || q.y > cssH) continue;
      const d = Math.hypot(q.nx, q.ny);
      if (d < bd) { bd = d; best = { m, q }; }
    }
    if (!best) return;
    const { cx, cy } = layout, dx = best.q.x - cx, dy = best.q.y - cy, d = Math.hypot(dx, dy) || 1;
    const out = d > R * 1.02;
    game.beams.push({ x0: out ? cx + (dx / d) * R * 0.98 : best.q.x, y0: out ? cy + (dy / d) * R * 0.98 : best.q.y, x1: best.q.x, y1: best.q.y, age: 0, life: 0.18, turret: true });
    sfx('zap');
    hitMeteor(best.m, best.q, 1 + game.skills.heavy);
  }

  // --- effects -----------------------------------------------------------------
  function explodeAt(x, y, r, rgb, scale) {
    const n = Math.round(16 * scale);
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(60, 260) * scale;
      game.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: rnd(0.4, 0.95),
        size: rnd(1.4, 3.6) * Math.sqrt(scale), rgb: Math.random() < 0.6 ? rgb : '130,112,96', glow: Math.random() < 0.45 });
    }
    game.rings.push({ x, y, r0: r * 0.6, r1: r * 3.2 * scale, age: 0, life: 0.5, rgb });
    if (game.parts.length > 700) game.parts.splice(0, game.parts.length - 700);
  }
  function puff(x, y, rgb, n) {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(30, 110);
      game.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: rnd(0.2, 0.4), size: rnd(1, 2), rgb, glow: false });
    }
  }
  function floatText(x, y, text, color, scale) { game.texts.push({ x, y, text, color, age: 0, life: 0.95, scale: scale || 1 }); }
  function fireBeam(x, y) {
    const R = Math.max(40, globeRadius()), { cx, cy } = layout;
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
    const x0 = d > R * 1.02 ? cx + (dx / d) * R * 0.98 : x, y0 = d > R * 1.02 ? cy + (dy / d) * R * 0.98 : y;
    game.beams.push({ x0, y0, x1: x, y1: y, age: 0, life: 0.16 });
    sfx('zap');
  }

  // --- loop --------------------------------------------------------------------
  function stepGame(dt) {
    if (!game) return;
    const drag8 = Math.pow(0.12, dt);
    for (const p of game.parts) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= drag8; p.vy *= drag8; }
    game.parts = game.parts.filter((p) => p.age < p.life);
    game.rings.forEach((r) => { r.age += dt; });
    game.rings = game.rings.filter((r) => r.age < r.life);
    game.beams.forEach((b) => { b.age += dt; });
    game.beams = game.beams.filter((b) => b.age < b.life);
    game.texts.forEach((t) => { t.age += dt; });
    game.texts = game.texts.filter((t) => t.age < t.life);
    game.craters.forEach((c) => { c.age += dt; });
    if (game.nova > 0) game.nova = Math.max(0, game.nova - dt);

    if (game.state === 'dying') {
      if (doom && doom.coreShown) { game.state = 'over'; showGameCard('over'); }
      return;
    }
    if (game.state !== 'playing') return;

    if (game.combo > 0) { game.comboT -= dt; if (game.comboT <= 0) { game.combo = 0; renderGameHud(); } }
    // Heartbeat bass line: faster as the shields fall.
    game.beatT -= dt;
    if (game.beatT <= 0) { game.beatT = [0.3, 0.4, 0.55][clamp(game.lives - 1, 0, 2)]; sfx('pulse', game.beatN++); }

    // Waves
    if (game.breakT > 0) {
      game.breakT -= dt;
      if (game.breakT <= 0) {
        if (game.pendingUpgrade) { game.pendingUpgrade = false; if (!openUpgrade()) nextWave(); }
        else nextWave();
      }
    } else if (game.spawnLeft > 0) {
      game.spawnT -= dt;
      if (game.spawnT <= 0) {
        const w = game.wave, r = Math.random();
        spawnMeteor(w >= 2 && r < 0.17 ? 'big' : w >= 3 && r < 0.34 ? 'fast' : 'rock');
        game.spawnLeft--;
        if (w >= 4 && game.spawnLeft > 0 && Math.random() < 0.3) { spawnMeteor('rock'); game.spawnLeft--; }
        game.spawnT = Math.max(0.3, 1.3 - 0.11 * (w - 1)) * rnd(0.65, 1.3);
      }
    } else if (!game.meteors.some((m) => !m.power)) {
      const bonus = 150 * game.wave * game.lives;
      game.score += bonus;
      banner('Wave ' + game.wave + ' cleared', '+' + bonus.toLocaleString('en-US') + ' shield bonus');
      sfx('power');
      game.breakT = 1.3;
      game.pendingUpgrade = true;
      renderGameHud();
    }

    game.powerT -= dt;
    if (game.powerT <= 0) { spawnPower(); game.powerT = rnd(13, 22); }

    if (game.skills.turret > 0 && game.state === 'playing') {
      game.turretT -= dt;
      if (game.turretT <= 0) { game.turretT = [0, 2.4, 1.6, 1.0][game.skills.turret]; turretFire(); }
    }
    const slowR = 2.3, slowK = 1 - 0.18 * game.skills.slow;
    for (const m of game.meteors.slice()) {
      if (game.state !== 'playing') break;
      let step = dt;
      if (game.skills.slow && !m.power) { const q = meteorPos(m); if (Math.hypot(q.nx, q.ny) < slowR) step *= slowK; }
      m.t += step;
      m.rot += m.spin * dt;
      if (m.flash > 0) m.flash = Math.max(0, m.flash - dt * 4);
      if (m.t >= m.dur) {
        if (m.power) { const i = game.meteors.indexOf(m); if (i >= 0) game.meteors.splice(i, 1); }
        else { impact(m, meteorPos(m)); if (game.state !== 'playing') break; }
      }
    }
  }

  // --- drawing -------------------------------------------------------------------
  function glowDot(g, x, y, r, rgb, a) {
    if (a <= 0 || r <= 0) return;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')');
    gr.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }

  /** Craters and glowing cracks, stored on the planet so they turn with it. */
  function drawCraters(g, cx, cy, R) {
    if (!game || !game.craters.length) return;
    const mtx = planetMatrix();
    const damage = 1 - game.lives / game.maxLives;
    const lw = Math.max(1, R / 240);
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    if (game.lives === 1) {
      const k = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
      const hg = g.createRadialGradient(cx, cy, R * 0.3, cx, cy, R);
      hg.addColorStop(0, 'rgba(255,110,40,' + (0.06 + 0.08 * k) + ')');
      hg.addColorStop(1, 'rgba(170,30,12,' + (0.22 + 0.16 * k) + ')');
      g.fillStyle = hg; g.fillRect(cx - R, cy - R, R * 2, R * 2);
    }
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const c of game.craters) {
      for (const poly of c.cracks) {
        g.beginPath();
        let on = false;
        for (const q of poly) {
          const v = planetToView(q, mtx);
          if (v[2] <= 0) { on = false; continue; }
          const x = cx + v[0] * R, y = cy - v[1] * R;
          if (on) g.lineTo(x, y); else { g.moveTo(x, y); on = true; }
        }
        g.strokeStyle = 'rgba(255,90,25,' + (0.35 + damage * 0.3) + ')'; g.lineWidth = lw * (4 + damage * 3); g.stroke();
        g.strokeStyle = 'rgba(255,214,140,0.9)'; g.lineWidth = lw * 1.5; g.stroke();
      }
      const v = planetToView(c.p, mtx);
      if (v[2] <= 0.02) continue;
      const x = cx + v[0] * R, y = cy - v[1] * R, rc = R * 0.07 * c.size;
      const glow = 0.55 + 0.45 * Math.exp(-c.age / 2.5);
      g.save();
      g.translate(x, y); g.rotate(Math.atan2(y - cy, x - cx)); g.scale(Math.max(0.25, v[2]), 1);
      const cg = g.createRadialGradient(0, 0, 0, 0, 0, rc * 1.6);
      cg.addColorStop(0, 'rgba(255,240,190,' + glow + ')');
      cg.addColorStop(0.25, 'rgba(255,140,50,' + (0.9 * glow) + ')');
      cg.addColorStop(0.6, 'rgba(110,28,12,0.8)');
      cg.addColorStop(1, 'rgba(20,8,5,0)');
      g.fillStyle = cg; g.beginPath(); g.arc(0, 0, rc * 1.6, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    g.restore();
  }

  function drawRock(g, m, now) {
    const p = meteorPos(m);
    if (m.power) {
      const col = m.kind === 'repair' ? '140,220,170' : '170,210,255';
      const pr = p.r * (1 + 0.12 * Math.sin(now * 0.008));
      glowDot(g, p.x, p.y, pr * 2.6, col, 0.55);
      g.fillStyle = 'rgba(' + col + ',0.95)';
      g.beginPath(); g.arc(p.x, p.y, pr * 0.62, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 2; g.lineCap = 'round';
      g.beginPath();
      if (m.kind === 'repair') {
        g.moveTo(p.x - pr * 0.3, p.y); g.lineTo(p.x + pr * 0.3, p.y);
        g.moveTo(p.x, p.y - pr * 0.3); g.lineTo(p.x, p.y + pr * 0.3);
      } else {
        for (let i = 0; i < 6; i++) {
          const a = m.rot + (i * Math.PI) / 3;
          g.moveTo(p.x + Math.cos(a) * pr * 0.18, p.y + Math.sin(a) * pr * 0.18);
          g.lineTo(p.x + Math.cos(a) * pr * 0.42, p.y + Math.sin(a) * pr * 0.42);
        }
      }
      g.stroke();
      return;
    }
    const dx = m.tx - m.sx, dy = m.ty - m.sy, dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl;
    const fast = m.kind === 'fast', big = m.kind === 'big';
    const tl = p.r * (fast ? 16 : big ? 6 : 8), tx = p.x - ux * tl, ty = p.y - uy * tl, px = -uy, py = ux;
    const tc = fast ? '255,226,150' : big ? '255,110,50' : '255,160,80';
    const tg = g.createLinearGradient(p.x, p.y, tx, ty);
    tg.addColorStop(0, 'rgba(' + tc + ',0.75)'); tg.addColorStop(0.4, 'rgba(' + tc + ',0.28)'); tg.addColorStop(1, 'rgba(' + tc + ',0)');
    g.fillStyle = tg;
    g.beginPath();
    g.moveTo(p.x + px * p.r * 0.95, p.y + py * p.r * 0.95); g.lineTo(tx, ty); g.lineTo(p.x - px * p.r * 0.95, p.y - py * p.r * 0.95);
    g.closePath(); g.fill();
    glowDot(g, p.x + ux * p.r * 0.35, p.y + uy * p.r * 0.35, p.r * 2.1, fast ? '255,230,170' : '255,140,60', 0.5);
    g.save();
    g.translate(p.x, p.y); g.rotate(m.rot);
    g.beginPath();
    const n = m.shape.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, rr = p.r * m.shape[i];
      if (i) g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
    const bg = g.createRadialGradient(-p.r * 0.3, -p.r * 0.3, 0, 0, 0, p.r * 1.2);
    bg.addColorStop(0, fast ? '#e2c88e' : big ? '#6b5444' : '#8f7866');
    bg.addColorStop(1, fast ? '#6f5a2e' : big ? '#2a1e17' : '#3a2d24');
    g.fillStyle = bg; g.fill();
    g.strokeStyle = m.flash > 0 ? 'rgba(255,255,255,' + m.flash + ')' : 'rgba(255,150,80,0.55)';
    g.lineWidth = m.flash > 0 ? 2.5 : 1.2;
    g.stroke();
    g.restore();
    if (big && m.hp < m.maxHp) {
      for (let i = 0; i < m.maxHp; i++) {
        g.fillStyle = i < m.hp ? 'rgba(255,214,150,0.95)' : 'rgba(255,255,255,0.18)';
        g.beginPath(); g.arc(p.x - 8 + i * 8, p.y - p.r - 10, 2.6, 0, Math.PI * 2); g.fill();
      }
    }
  }

  function drawGameLayer(now) {
    if (!game) return;
    const g = ctx;
    for (const b of game.beams) {
      const a = 1 - b.age / b.life;
      if (b.arc) {
        // Jagged lightning between meteors.
        g.strokeStyle = 'rgba(170,215,255,' + a + ')'; g.lineWidth = 2.2; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(b.x0, b.y0);
        for (let i = 1; i < 7; i++) {
          const t = i / 7, jx = (Math.random() - 0.5) * 18, jy = (Math.random() - 0.5) * 18;
          g.lineTo(b.x0 + (b.x1 - b.x0) * t + jx, b.y0 + (b.y1 - b.y0) * t + jy);
        }
        g.lineTo(b.x1, b.y1); g.stroke();
        glowDot(g, b.x1, b.y1, 16 * a + 3, '170,215,255', a);
        continue;
      }
      if (b.turret) {
        g.strokeStyle = 'rgba(199,164,255,' + a + ')'; g.lineWidth = 2.4 * a + 0.8; g.lineCap = 'round';
        g.beginPath(); g.moveTo(b.x0, b.y0); g.lineTo(b.x1, b.y1); g.stroke();
        glowDot(g, b.x0, b.y0, 9 * a + 2, '199,164,255', a);
        glowDot(g, b.x1, b.y1, 12 * a + 2, '199,164,255', a);
        continue;
      }
      if (b.x0 !== b.x1 || b.y0 !== b.y1) {
        const gr = g.createLinearGradient(b.x0, b.y0, b.x1, b.y1);
        gr.addColorStop(0, 'rgba(255,240,200,' + a + ')'); gr.addColorStop(1, 'rgba(255,190,110,' + a * 0.9 + ')');
        g.strokeStyle = gr; g.lineCap = 'round';
        g.globalAlpha = 0.35; g.lineWidth = 10 * a + 2;
        g.beginPath(); g.moveTo(b.x0, b.y0); g.lineTo(b.x1, b.y1); g.stroke();
        g.globalAlpha = 1; g.lineWidth = 3 * a + 1; g.stroke();
        glowDot(g, b.x0, b.y0, 10 * a + 2, '255,236,190', a);
      }
      glowDot(g, b.x1, b.y1, 14 * a + 2, '255,220,160', a * 0.9);
    }
    g.globalAlpha = 1;
    if (game.skills.slow && (game.state === 'playing' || game.state === 'upgrade' || game.state === 'paused')) {
      const R = Math.max(40, globeRadius());
      g.strokeStyle = 'rgba(140,220,170,' + (0.1 + 0.05 * game.skills.slow + 0.04 * Math.sin(now * 0.003)) + ')';
      g.lineWidth = 1.5; g.setLineDash([4, 8]);
      g.beginPath(); g.arc(layout.cx, layout.cy, R * 2.3, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }
    for (const m of game.meteors) drawRock(g, m, now);
    for (const r of game.rings) {
      const k = r.age / r.life;
      g.strokeStyle = 'rgba(' + r.rgb + ',' + (1 - k) * 0.8 + ')';
      g.lineWidth = 3 * (1 - k) + 0.5;
      g.beginPath(); g.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * easeOut(k), 0, Math.PI * 2); g.stroke();
    }
    for (const p of game.parts) {
      const a = 1 - p.age / p.life;
      if (p.glow) glowDot(g, p.x, p.y, p.size * 2.6, p.rgb, a * 0.8);
      g.fillStyle = 'rgba(' + p.rgb + ',' + a + ')';
      g.beginPath(); g.arc(p.x, p.y, p.size * (0.6 + 0.4 * a), 0, Math.PI * 2); g.fill();
    }
    if (!gameFont) gameFont = getComputedStyle(document.body).fontFamily;
    g.textAlign = 'center';
    for (const t of game.texts) {
      const k = t.age / t.life, yy = t.y - k * 38;
      g.globalAlpha = 1 - k * k;
      g.font = '700 ' + Math.round(15 * t.scale) + 'px ' + gameFont;
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillText(t.text, t.x + 1, yy + 1);
      g.fillStyle = t.color; g.fillText(t.text, t.x, yy);
    }
    g.globalAlpha = 1;
    if (game.nova > 0) { g.fillStyle = 'rgba(200,225,255,' + (game.nova / 0.7) * 0.35 + ')'; g.fillRect(-20, -20, cssW + 40, cssH + 40); }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  ['temp', 'water', 'terrain', 'speed'].forEach((k) => {
    dom.sl[k].addEventListener('input', () => onSlider(k));
    dom.sl[k].addEventListener('change', () => { onSlider(k); statsDirty = true; });
  });
  dom.tg.clouds.addEventListener('click', () => setToggle('clouds', !state.clouds));
  dom.tg.lights.addEventListener('click', () => setToggle('lights', !state.lights));
  dom.tg.grid.addEventListener('click', () => setToggle('grid', !state.grid));
  dom.tg.lapse.addEventListener('click', () => { setLapse(!lapse); markInteracted(); });
  $('tg-meteor').addEventListener('click', startDoom);
  $('btn-game').addEventListener('click', openGame);
  $('gh-pause').addEventListener('click', () => { if (game && (game.state === 'playing' || game.state === 'paused')) togglePause(); });
  $('gh-quit').addEventListener('click', exitGame);
  $('btn-rebuild').addEventListener('click', () => rebuildPlanet());
  dom.viewGlobe.addEventListener('click', () => setView('globe'));
  dom.viewMap.addEventListener('click', () => setView('map'));
  dom.viewGlobe.parentElement.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      setView(state.view === 'map' ? 'globe' : 'map');
      (state.view === 'map' ? dom.viewMap : dom.viewGlobe).focus();
    }
  });
  dom.play.addEventListener('click', togglePlay);
  dom.zoomIn.addEventListener('click', () => { setZoom(view.targetZoom * 1.25); markInteracted(); sfx('click'); });
  dom.zoomOut.addEventListener('click', () => { setZoom(view.targetZoom / 1.25); markInteracted(); sfx('click'); });
  document.getElementById('btn-land').addEventListener('click', () => { landCommand(false); markInteracted(); });
  dom.reset.addEventListener('click', () => { resetView(); markInteracted(); sfx('click'); });

  // Sound: browsers only allow audio after a user gesture, so unlock on the first one.
  function updateSoundButton() {
    const on = !!(audio && audio.enabled);
    dom.sound.classList.toggle('muted', !on);
    dom.sound.setAttribute('aria-pressed', on ? 'true' : 'false');
    dom.sound.setAttribute('aria-label', on ? 'Mute sound' : 'Turn sound on');
  }
  function setPhoto(on) {
    const now = document.body.classList.toggle('photo', !!on);
    const el = $('tg-photo');
    el.classList.toggle('on', now); el.setAttribute('aria-pressed', now ? 'true' : 'false');
    hideTip();
    if (now) toast('Photo mode: press H or Esc to bring the controls back', 2400);
    sfx(now ? 'shutter' : 'off');
  }
  $('tg-photo').addEventListener('click', () => setPhoto(true));
  $('photo-exit').addEventListener('click', () => setPhoto(false));

  function toggleSound() {
    if (!audio || !audio.supported) { toast('Sound is not supported in this browser'); return; }
    const on = audio.setEnabled(!audio.enabled);
    updateSoundButton();
    if (on) setTimeout(() => sfx('toggle'), 60);
    toast(on ? 'Sound on' : 'Sound off', 1200);
  }
  if (audio) {
    const unlock = () => audio.unlock();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }
  dom.sound.addEventListener('click', toggleSound);
  updateSoundButton();
  renderStars(false);
  dom.random.addEventListener('click', randomPlanet);
  dom.share.addEventListener('click', share);
  dom.save.addEventListener('click', savePostcard);
  dom.help.addEventListener('click', openHelp);
  dom.how.addEventListener('click', openHelp);
  dom.helpClose.addEventListener('click', closeHelp);
  dom.helpModal.addEventListener('click', (e) => { if (e.target === dom.helpModal) closeHelp(); });
  dom.brand.addEventListener('click', (e) => {
    e.preventDefault();
    dom.seed.value = Terra.DEFAULT_SEED;
    requestSeed(Terra.DEFAULT_SEED);
    applyPreset(Terra.PRESETS[0]);
    refreshSeedStatus();
  });

  window.addEventListener('resize', resize);
  window.addEventListener('scroll', hideTip, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(dom.stage);
  document.addEventListener('visibilitychange', () => {
    last = performance.now();
    if (audio) { if (document.hidden) audio.pause(); else audio.resume(); }
    if (document.hidden && game && game.state === 'playing') togglePause();
  });

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = clamp((now - last) / 1000, 0, 0.1);
    last = now;

    if (Math.min(window.devicePixelRatio || 1, 2) !== dpr) resize();
    stepBuilder();
    stepTween(now);
    stepLapse(now);
    stepDoom(now);
    if (game) {
      try { stepGame(dt); }
      catch (err) { exitGame(); if (!frame.reported) { frame.reported = true; setTimeout(() => { throw err; }); } }
    }
    stepReset(now);
    if (climateDirty) recomputeClimate();
    if (statsDirty && now - lastStatsAt > 90) updateCard(false);
    stepNumbers(now);
    stepScramble(now);

    let moving = false;
    const running = !state.paused && state.speed > 0 && !doom;
    if (running) {
      view.spin += dt * state.speed * 0.065 * (landing.open ? 0.2 : 1);
      view.cloudShift += dt * (0.5 + state.speed * 0.22);
      moving = true;
    }
    if (!drag && !resetAnim) {
      const decay = Math.pow(0.04, dt); // smooth exponential slow-down
      if (Math.abs(view.vyaw) > 1e-4 || Math.abs(view.vpitch) > 1e-4) {
        view.yaw += view.vyaw * dt;
        view.pitch = clamp(view.pitch + view.vpitch * dt, -PITCH_LIMIT, PITCH_LIMIT);
        view.vyaw *= decay; view.vpitch *= decay;
        moving = true;
      } else { view.vyaw = 0; view.vpitch = 0; }
      if (Math.abs(view.vpan) > 1e-5) { view.mapPan += view.vpan * dt; view.vpan *= decay; moving = true; }
      else view.vpan = 0;
    }
    if (Math.abs(view.targetZoom - view.zoom) > 1e-4) {
      view.zoom += (view.targetZoom - view.zoom) * (1 - Math.pow(0.0005, dt));
      moving = true;
    } else view.zoom = view.targetZoom;
    view.yaw %= Math.PI * 200; // keep numbers small over long sessions
    view.mapPan %= 1000;
    view.spin %= Math.PI * 2e5;

    dom.clock.textContent = 'Day ' + (Math.floor(view.spin / (Math.PI * 2)) + 1);

    const animating = moving || drag || pinch || fade || introStart >= 0 || tween || lapse || resetAnim || builder || doom || game;
    if (animating || dirty) {
      try { draw(now); }
      catch (err) {
        // Never let a drawing error stop the app: drop the effect and keep going.
        if (doom) rebuildPlanet(true);
        fade = null;
        if (!frame.reported) { frame.reported = true; setTimeout(() => { throw err; }); }
      }
      dirty = false;
      updateSky();
      if (hover && !drag) showTipAt(hover.x, hover.y);
    }

    // Adaptive quality: keep the shading under ~11 ms on slower machines.
    if (++frameCount % 30 === 0 && state.view === 'globe') {
      if (shadeEma > 11 && qualityCap > 360) qualityCap = Math.max(360, qualityCap * 0.85);
      else if (shadeEma < 5.5 && qualityCap < 760) qualityCap *= 1.08;
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  buildSky();
  buildPresets();
  syncSliders();
  updatePlayButton();
  dom.seed.value = state.seed;
  setView(state.view);
  resize();
  requestSeed(state.seed);
  lastHash = location.hash;
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    dom.hint.textContent = 'Drag to spin · Pinch to zoom · Tap to inspect';
  }
  if (reduceMotion) dom.hint.classList.add('gone');
  setTimeout(() => dom.hint.classList.add('gone'), 9000);
  window.addEventListener('load', positionGlider);
  requestAnimationFrame(frame);

  // Exposed for the test page and for debugging in the console.
  window.TinyTerra = {
    get state() { return Object.assign({}, state); },
    get stats() { return climate ? climate.stats : null; },
    get planet() { return planet; },
    get ready() { return !!planet && !builder && !climateDirty; },
    setSeed: (s) => { dom.seed.value = Terra.normalizeSeed(s); return requestSeed(s); },
    get quality() { return Math.round(qualityCap); },
    get game() {
      return game ? { state: game.state, score: game.score, lives: game.lives, maxLives: game.maxLives, wave: game.wave, combo: game.combo, meteors: game.meteors.length, craters: game.craters.length, skills: Object.assign({}, game.skills), options: game.upgradeOptions.map((k) => k.id) } : null;
    },
    gameTargets() {
      if (!game) return [];
      const rect = dom.canvas.getBoundingClientRect();
      return game.meteors.map((m) => { const p = meteorPos(m); return { x: rect.left + p.x, y: rect.top + p.y, kind: m.kind, power: !!m.power, k: p.k }; });
    },
  };
})();
