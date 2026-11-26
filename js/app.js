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

    if (doom && doom.shake > 0.3) {
      ctx.translate((Math.random() * 2 - 1) * doom.shake, (Math.random() * 2 - 1) * doom.shake);
      doom.shake *= 0.86;
    }
    if (state.view === 'globe') drawGlobe(introK, pulse);
    else drawMap(introK);

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
      toast('Planet destroyed. Its ' + m.comp + ' core burns at ' + m.innerTemp.toLocaleString('en-US') + ' °C. Hover the layers, move the sliders, or rebuild (K).', 5200);
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
        if (e.pointerType !== 'mouse') showTipAt(e.clientX, e.clientY);
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

  window.addEventListener('keydown', (e) => {
    if (!dom.helpModal.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeHelp(); }
      else if (e.key === 'Tab') trapFocus(e);
      return;
    }
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
    else if (k === 'x' || k === 'X') resetSliders();
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
    stepReset(now);
    if (climateDirty) recomputeClimate();
    if (statsDirty && now - lastStatsAt > 90) updateCard(false);
    stepNumbers(now);
    stepScramble(now);

    let moving = false;
    const running = !state.paused && state.speed > 0 && !doom;
    if (running) {
      view.spin += dt * state.speed * 0.065;
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

    const animating = moving || drag || pinch || fade || introStart >= 0 || tween || lapse || resetAnim || builder || doom;
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
  };
})();
