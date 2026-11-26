/*!
 * Tiny Terra — planet engine.
 *
 * Pure functions, no DOM, no network. Every planet is a deterministic
 * function of (seed text, temperature, water level, terrain variation).
 * Math.random is never used by generation; only randomSeed() (which picks
 * a new seed for the dice button) touches it.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Terra = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const DEFAULT_SEED = 'blue marble';
  const MAX_SEED_LENGTH = 200;
  const ELEV_SCALE = 8000;      // metres of ocean depth per unit of raw elevation
  const LAND_SCALE = 11000;     // land height in metres = LAND_SCALE * d^1.5
  const LAPSE = 6.5;            // °C lost per 1000 m of altitude
  const LAT_SPREAD = 46;        // equator-to-pole temperature spread, °C

  const LIMITS = Object.freeze({
    temp: Object.freeze({ min: -30, max: 50, def: 15 }),
    water: Object.freeze({ min: 0, max: 100, def: 68 }),
    terrain: Object.freeze({ min: 0, max: 100, def: 50 }),
    speed: Object.freeze({ min: 0, max: 10, def: 3 }),
  });

  const BIOME = Object.freeze({
    DEEP: 0, OCEAN: 1, SHALLOW: 2, SEA_ICE: 3, BEACH: 4, DESERT: 5, SAVANNA: 6,
    GRASSLAND: 7, FOREST: 8, RAINFOREST: 9, TAIGA: 10, TUNDRA: 11, SNOW: 12,
    ICE: 13, MOUNTAIN: 14, SCORCHED: 15,
  });

  // livable: how welcoming a biome is to life (0–1), used for habitability.
  const BIOMES = Object.freeze([
    { id: 0, key: 'deep', name: 'Deep ocean', color: [9, 32, 84], water: true, livable: 0 },
    { id: 1, key: 'ocean', name: 'Ocean', color: [22, 84, 160], water: true, livable: 0 },
    { id: 2, key: 'shallow', name: 'Shallow sea', color: [52, 160, 204], water: true, livable: 0 },
    { id: 3, key: 'seaice', name: 'Sea ice', color: [220, 234, 246], water: true, ice: true, livable: 0 },
    { id: 4, key: 'beach', name: 'Beach', color: [226, 210, 158], livable: 0.8 },
    { id: 5, key: 'desert', name: 'Desert', color: [222, 184, 116], livable: 0.1 },
    { id: 6, key: 'savanna', name: 'Savanna', color: [182, 168, 88], flora: true, livable: 0.7 },
    { id: 7, key: 'grassland', name: 'Grassland', color: [116, 166, 76], flora: true, livable: 1 },
    { id: 8, key: 'forest', name: 'Forest', color: [48, 114, 56], flora: true, livable: 1 },
    { id: 9, key: 'rainforest', name: 'Rainforest', color: [26, 94, 48], flora: true, livable: 0.8 },
    { id: 10, key: 'taiga', name: 'Taiga', color: [58, 98, 80], flora: true, livable: 0.5 },
    { id: 11, key: 'tundra', name: 'Tundra', color: [146, 152, 124], livable: 0.15 },
    { id: 12, key: 'snow', name: 'Snowfield', color: [238, 243, 249], ice: true, livable: 0 },
    { id: 13, key: 'ice', name: 'Glacier', color: [202, 226, 246], ice: true, livable: 0 },
    { id: 14, key: 'mountain', name: 'Mountains', color: [122, 112, 102], livable: 0.1 },
    { id: 15, key: 'scorched', name: 'Scorched rock', color: [98, 50, 36], livable: 0 },
  ].map(Object.freeze));

  const PRESETS = Object.freeze([
    { id: 'earth', name: 'Earth-like', temp: 15, water: 68, terrain: 50 },
    { id: 'archipelago', name: 'Archipelago', temp: 26, water: 88, terrain: 80 },
    { id: 'desert', name: 'Desert Dune', temp: 38, water: 14, terrain: 40 },
    { id: 'ice', name: 'Ice Age', temp: -16, water: 60, terrain: 55 },
    { id: 'inferno', name: 'Inferno', temp: 50, water: 6, terrain: 85 },
    { id: 'highlands', name: 'Highlands', temp: 9, water: 40, terrain: 100 },
  ].map(Object.freeze));

  // ---------------------------------------------------------------------------
  // Small math helpers
  // ---------------------------------------------------------------------------

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // ---------------------------------------------------------------------------
  // Seeds, hashing and the PRNG
  // ---------------------------------------------------------------------------

  /** Turns any input into a clean seed string (may return ''). Never throws. */
  function normalizeSeed(input) {
    let s;
    try { s = input == null ? '' : String(input); } catch (e) { s = ''; }
    try { s = s.normalize('NFC'); } catch (e) { /* keep as is */ }
    s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > MAX_SEED_LENGTH) s = chars.slice(0, MAX_SEED_LENGTH).join('').trim();
    return s;
  }

  /** FNV-1a over UTF-16 code units, then a murmur3 finaliser for avalanche. */
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /** mulberry32: tiny, fast, good-enough PRNG seeded by a 32-bit integer. */
  function mulberry32(a) {
    a >>>= 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // 3D simplex noise (Gustavson), permutation seeded by our PRNG.
  // Sampling on the unit sphere in 3D means the globe has no seams or pinching.
  // ---------------------------------------------------------------------------

  const GRAD3 = new Float32Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1,
    1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  ]);
  const F3 = 1 / 3, G3 = 1 / 6;

  function makeNoise3(rand) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    const perm = new Uint8Array(512), pm12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; pm12[i] = (perm[i] % 12) * 3; }

    return function noise(xin, yin, zin) {
      const s = (xin + yin + zin) * F3;
      const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
      const t = (i + j + k) * G3;
      const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
      let i1, j1, k1, i2, j2, k2;
      if (x0 >= y0) {
        if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
        else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
      } else {
        if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      }
      const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
      const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
      const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
      const ii = i & 255, jj = j & 255, kk = k & 255;
      let n = 0, tt, g;
      tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
      if (tt > 0) { g = pm12[ii + perm[jj + perm[kk]]]; tt *= tt; n += tt * tt * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0); }
      tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
      if (tt > 0) { g = pm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]]; tt *= tt; n += tt * tt * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1); }
      tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
      if (tt > 0) { g = pm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]]; tt *= tt; n += tt * tt * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2); }
      tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
      if (tt > 0) { g = pm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]]; tt *= tt; n += tt * tt * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3); }
      return 32 * n;
    };
  }

  function fbm(noise, x, y, z, octaves) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * freq, y * freq, z * freq);
      norm += amp; amp *= 0.5; freq *= 2.03;
    }
    return sum / norm;
  }

  function ridged(noise, x, y, z, octaves) {
    let sum = 0, amp = 0.5, freq = 1, prev = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(noise(x * freq, y * freq, z * freq));
      n *= n;
      sum += n * amp * prev;
      norm += amp; prev = n; amp *= 0.5; freq *= 2.1;
    }
    return sum / norm;
  }

  // ---------------------------------------------------------------------------
  // Colour helpers (per-planet flora/ocean tints)
  // ---------------------------------------------------------------------------

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
  }
  function shiftHue(rgb, deg, satMul) {
    const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    return hslToRgb(hsl[0] + deg, clamp(hsl[1] * (satMul || 1), 0, 1), hsl[2]);
  }

  // ---------------------------------------------------------------------------
  // Names
  // ---------------------------------------------------------------------------

  const SYL_A = ['Ka', 'Ve', 'Tho', 'Zu', 'Mi', 'Or', 'Xe', 'Ny', 'Ar', 'Se', 'Dra', 'Qua', 'Be', 'Ty',
    'Lu', 'Ix', 'Ae', 'Ri', 'Va', 'No', 'Sha', 'Kel', 'Myr', 'Pho', 'Eri', 'Ul', 'Zan', 'Cy', 'Oro', 'Tal'];
  const SYL_B = ['ra', 'lo', 'ni', 'va', 'ter', 'sol', 'me', 'do', 'li', 'ri', 'na', 'the', 'qui', 'ro',
    'ze', 'ma', '', '', ''];
  const SYL_C = ['ra', 'nus', 'dor', 'lia', 'x', 'th', 'on', 'is', 'ae', 'ion', 'ara', 'os', 'eus', 'ium',
    'ix', 'ea', 'ys', 'ar'];
  const pick = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];

  function planetName(hash) {
    const r = mulberry32(hash ^ 0x5bd1e995);
    const name = pick(r, SYL_A) + pick(r, SYL_B) + pick(r, SYL_C);
    const designation = 'TT-' + (1000 + (hash % 9000)) + 'bcdefg'.charAt(Math.floor(r() * 6));
    const peak = 'Mount ' + pick(r, SYL_A) + pick(r, SYL_C);
    return { name: name.charAt(0).toUpperCase() + name.slice(1), designation, peak };
  }

  // ---------------------------------------------------------------------------
  // State sanitising (used for sliders, presets and share links)
  // ---------------------------------------------------------------------------

  function clampSetting(value, key) {
    const lim = LIMITS[key];
    let n = NaN;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && /^[+-]?\d{1,6}(\.\d{1,6})?$/.test(value.trim())) n = Number(value.trim());
    if (!Number.isFinite(n)) return lim.def;
    return clamp(Math.round(n), lim.min, lim.max);
  }

  const DEFAULTS = Object.freeze({
    seed: DEFAULT_SEED,
    temp: LIMITS.temp.def,
    water: LIMITS.water.def,
    terrain: LIMITS.terrain.def,
    speed: LIMITS.speed.def,
    view: 'globe',
  });

  /** Returns a complete, valid state object from anything. Never throws. */
  function sanitizeState(obj) {
    const o = obj && typeof obj === 'object' ? obj : {};
    const seed = normalizeSeed(o.seed);
    return {
      seed: seed || DEFAULT_SEED,
      temp: clampSetting(o.temp, 'temp'),
      water: clampSetting(o.water, 'water'),
      terrain: clampSetting(o.terrain, 'terrain'),
      speed: clampSetting(o.speed, 'speed'),
      view: o.view === 'map' ? 'map' : 'globe',
    };
  }

  /** Parses a share-link hash like "#s=earth&t=15&w=68&r=50&v=map". Never throws. */
  function parseHash(hash) {
    const out = {};
    let h = typeof hash === 'string' ? hash : '';
    if (h.charAt(0) === '#') h = h.slice(1);
    if (h.length > 4000) h = h.slice(0, 4000);
    const keys = { s: 'seed', t: 'temp', w: 'water', r: 'terrain', d: 'speed', v: 'view' };
    h.split('&').forEach((part) => {
      const eq = part.indexOf('=');
      if (eq <= 0) return;
      const k = keys[part.slice(0, eq)];
      if (!k || Object.prototype.hasOwnProperty.call(out, k)) return; // first value wins
      let v;
      try { v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')); } catch (e) { return; }
      out[k] = v;
    });
    return sanitizeState(out);
  }

  function toHash(state) {
    const s = sanitizeState(state);
    return '#s=' + encodeURIComponent(s.seed) + '&t=' + s.temp + '&w=' + s.water +
      '&r=' + s.terrain + (s.speed !== LIMITS.speed.def ? '&d=' + s.speed : '') +
      (s.view === 'map' ? '&v=map' : '');
  }

  // A pool for the dice button — memorable, shareable seeds.
  const WORDS_A = ['amber', 'azure', 'crimson', 'silent', 'golden', 'frozen', 'emerald', 'velvet', 'lunar',
    'hollow', 'wild', 'ancient', 'distant', 'molten', 'misty', 'cobalt', 'violet', 'radiant', 'drifting',
    'quiet', 'stormy', 'sunken', 'feral', 'gentle', 'iron', 'jade', 'opal', 'scarlet', 'teal', 'cosmic'];
  const WORDS_B = ['harbor', 'tide', 'ember', 'canyon', 'meadow', 'orbit', 'reef', 'glacier', 'dune', 'grove',
    'summit', 'lagoon', 'comet', 'atlas', 'haven', 'delta', 'mesa', 'fjord', 'nebula', 'isle', 'frontier',
    'cascade', 'tundra', 'ridge', 'monsoon', 'oasis', 'echo', 'horizon', 'basin', 'aurora'];

  /** The only function that uses Math.random: it picks a NEW seed. */
  function randomSeed() {
    const a = WORDS_A[Math.floor(Math.random() * WORDS_A.length)];
    const b = WORDS_B[Math.floor(Math.random() * WORDS_B.length)];
    return a + '-' + b + '-' + (10 + Math.floor(Math.random() * 90));
  }

  // ---------------------------------------------------------------------------
  // Planet generation (seed-dependent fields; expensive, done once per seed)
  // ---------------------------------------------------------------------------

  const now = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now() : () => Date.now();

  /**
   * Builds a planet incrementally so the UI never freezes: call
   * step(budgetMs) once per frame until it returns true, then read .result.
   * createPlanet() simply runs it to completion.
   */
  function planetBuilder(seedInput, options) {
    const opts = options || {};
    const W = clamp((opts.width | 0) || 512, 16, 4096) & ~1;
    const H = clamp((opts.height | 0) || (W >> 1), 8, 2048) & ~1;
    const seed = normalizeSeed(seedInput) || DEFAULT_SEED;
    const hash = hashString(seed);
    const rand = mulberry32(hash);
    const nA = makeNoise3(rand), nB = makeNoise3(rand), nC = makeNoise3(rand);
    const o = new Float64Array(30);
    for (let i = 0; i < o.length; i++) o[i] = (rand() * 2 - 1) * 64;

    const contFreq = 0.6 + rand() * 0.7;
    const warpAmt = 0.25 + rand() * 0.45;
    const mtnFreq = 1.7 + rand() * 1.3;
    const moistFreq = 1.1 + rand() * 0.9;

    // Per-planet character: flora colour, ocean tint, rings.
    const floraRoll = rand();
    let floraShift = (rand() * 2 - 1) * 12, flora = 'Green';
    if (floraRoll < 0.07) { floraShift = 175; flora = 'Exotic violet'; }
    else if (floraRoll < 0.13) { floraShift = -105; flora = 'Exotic crimson'; }
    else if (floraRoll < 0.19) { floraShift = 60; flora = 'Exotic teal'; }
    else if (floraRoll < 0.24) { floraShift = -52; flora = 'Exotic gold'; }
    const oceanShift = (rand() * 2 - 1) * 14;
    const hasRings = rand() < 0.24;
    const ringPalette = [[226, 210, 182], [196, 210, 228], [232, 188, 146], [214, 196, 222]];
    const ringColor = ringPalette[Math.floor(rand() * ringPalette.length) % ringPalette.length];
    const ringInner = 1.28 + rand() * 0.14, ringOuter = 1.78 + rand() * 0.3;
    const ringBands = [];
    for (let i = 0; i < 18; i++) ringBands.push(0.15 + rand() * 0.75);

    const palette = BIOMES.map((b) => {
      if (b.flora) return shiftHue(b.color, floraShift, flora === 'Green' ? 1 : 1.12);
      if (b.water && !b.ice) return shiftHue(b.color, oceanShift, 1);
      return b.color.slice();
    });

    const N = W * H;
    const cont = new Float32Array(N), mtn = new Float32Array(N), det = new Float32Array(N);
    const moist = new Float32Array(N), tnoise = new Float32Array(N), city = new Float32Array(N);

    const rowLat = new Float32Array(H), rowSin = new Float32Array(H), rowCos = new Float32Array(H);
    const colSin = new Float32Array(W), colCos = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
      colSin[x] = Math.sin(lon); colCos[x] = Math.cos(lon);
    }
    for (let y = 0; y < H; y++) {
      const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
      rowLat[y] = lat; rowSin[y] = Math.sin(lat); rowCos[y] = Math.cos(lat);
    }

    // Low-frequency fields (domain warp, moisture, temperature wobble) are
    // smooth, so they are computed on a half-resolution grid and upsampled.
    const LW = W >> 1, LH = H >> 1, LN = LW * LH;
    const lwx = new Float32Array(LN), lwy = new Float32Array(LN), lwz = new Float32Array(LN);
    const lmo = new Float32Array(LN), ltn = new Float32Array(LN);

    const CW = Math.max(8, W >> 1), CH = Math.max(4, H >> 1);
    const cloudRaw = new Float32Array(CW * CH);

    function lowRow(y) {
      const lat = Math.PI / 2 - ((y + 0.5) / LH) * Math.PI;
      const sl = Math.sin(lat), cl = Math.cos(lat);
      let i = y * LW;
      for (let x = 0; x < LW; x++, i++) {
        const lon = ((x + 0.5) / LW) * 2 * Math.PI - Math.PI;
        const X = cl * Math.sin(lon), Y = sl, Z = cl * Math.cos(lon);
        const wx = nB(X * 1.6 + o[0], Y * 1.6 + o[1], Z * 1.6 + o[2]);
        const wy = nB(X * 1.6 + o[3], Y * 1.6 + o[4], Z * 1.6 + o[5]);
        const wz = nB(X * 1.6 + o[6], Y * 1.6 + o[7], Z * 1.6 + o[8]);
        lwx[i] = wx; lwy[i] = wy; lwz[i] = wz;
        const qx = X + wx * warpAmt, qy = Y + wy * warpAmt, qz = Z + wz * warpAmt;
        lmo[i] = fbm(nC, qx * moistFreq + o[18], qy * moistFreq + o[19], qz * moistFreq + o[20], 3);
        ltn[i] = nA(X * 1.3 + o[21], Y * 1.3 + o[22], Z * 1.3 + o[23]);
      }
    }

    function fullRow(y) {
      const sl = rowSin[y], cl = rowCos[y];
      // vertical position on the low-res grid
      const ly = clamp((y + 0.5) / 2 - 0.5, 0, LH - 1);
      const y0 = Math.floor(ly), y1 = Math.min(LH - 1, y0 + 1), fy = ly - y0;
      let i = y * W;
      for (let x = 0; x < W; x++, i++) {
        let lx = (x + 0.5) / 2 - 0.5;
        if (lx < 0) lx += LW;
        let x0 = Math.floor(lx); const fx = lx - x0;
        if (x0 >= LW) x0 -= LW;
        const x1 = x0 + 1 < LW ? x0 + 1 : 0;
        const a = y0 * LW + x0, b = y0 * LW + x1, c = y1 * LW + x0, d = y1 * LW + x1;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const wx = lwx[a] * w00 + lwx[b] * w10 + lwx[c] * w01 + lwx[d] * w11;
        const wy = lwy[a] * w00 + lwy[b] * w10 + lwy[c] * w01 + lwy[d] * w11;
        const wz = lwz[a] * w00 + lwz[b] * w10 + lwz[c] * w01 + lwz[d] * w11;
        moist[i] = lmo[a] * w00 + lmo[b] * w10 + lmo[c] * w01 + lmo[d] * w11;
        tnoise[i] = ltn[a] * w00 + ltn[b] * w10 + ltn[c] * w01 + ltn[d] * w11;

        const X = cl * colSin[x], Y = sl, Z = cl * colCos[x];
        const qx = X + wx * warpAmt, qy = Y + wy * warpAmt, qz = Z + wz * warpAmt;
        // A very low-frequency swell groups land into a few large continents.
        cont[i] = 0.62 * fbm(nA, qx * contFreq + o[9], qy * contFreq + o[10], qz * contFreq + o[11], 5) +
          0.42 * nB(X * 0.62 + o[27], Y * 0.62 + o[28], Z * 0.62 + o[29]);
        mtn[i] = ridged(nC, qx * mtnFreq + o[12], qy * mtnFreq + o[13], qz * mtnFreq + o[14], 4);
        det[i] = fbm(nB, X * 7 + o[15], Y * 7 + o[16], Z * 7 + o[17], 2);
        city[i] = nC(X * 19 + o[24], Y * 19 + o[25], Z * 19 + o[26]);
      }
    }

    function cloudRow(y) {
      const lat = Math.PI / 2 - ((y + 0.5) / CH) * Math.PI;
      const sl = Math.sin(lat), cl = Math.cos(lat);
      const band = 0.18 * Math.cos(lat * 6); // storm belts at the equator and mid-latitudes
      let c = y * CW;
      for (let x = 0; x < CW; x++, c++) {
        const lon = ((x + 0.5) / CW) * 2 * Math.PI - Math.PI;
        const X = cl * Math.sin(lon), Y = sl, Z = cl * Math.cos(lon);
        const w1 = fbm(nC, X * 1.4 + o[5], Y * 2.4 + o[9], Z * 1.4 + o[13], 2);
        const w2 = fbm(nA, X * 1.4 + o[2], Y * 2.4 + o[7], Z * 1.4 + o[11], 2);
        cloudRaw[c] = fbm(nB, (X + w1 * 0.9) * 1.7 + o[19], (Y * 1.5 + w2 * 0.6) * 1.7 + o[23], (Z + w2 * 0.9) * 1.7 + o[29], 5) + band;
      }
    }

    // Work units, weighted roughly by cost per row.
    const phases = [
      { rows: LH, fn: lowRow, cost: LW * 7 },
      { rows: H, fn: fullRow, cost: W * 13 },
      { rows: CH, fn: cloudRow, cost: CW * 9 },
    ];
    const total = phases.reduce((t, p) => t + p.rows * p.cost, 0);
    let phase = 0, row = 0, doneUnits = 0, result = null;

    function finish() {
      const rowWeight = new Float32Array(H);
      let totalWeight = 0;
      for (let y = 0; y < H; y++) { rowWeight[y] = rowCos[y]; totalWeight += rowCos[y] * W; }
      const names = planetName(hash);
      result = {
        seed, hash, W, H, N, CW, CH,
        cont, mtn, det, moist, tnoise, city, cloudRaw,
        rowLat, rowSin, rowCos, colSin, colCos, rowWeight, totalWeight,
        palette,
        traits: { flora, floraShift, oceanShift, rings: hasRings, ringColor, ringInner, ringOuter, ringBands },
        name: names.name, designation: names.designation, peakName: names.peak,
      };
    }

    return {
      seed,
      step(budgetMs) {
        if (result) return true;
        const budget = Number.isFinite(budgetMs) ? Math.max(1, budgetMs) : Infinity;
        const t0 = now();
        while (phase < phases.length) {
          const p = phases[phase];
          p.fn(row);
          doneUnits += p.cost;
          if (++row >= p.rows) { phase++; row = 0; }
          if (budget !== Infinity && now() - t0 >= budget) break;
        }
        if (phase >= phases.length && !result) finish();
        return !!result;
      },
      get progress() { return result ? 1 : doneUnits / total; },
      get result() { return result; },
    };
  }

  function createPlanet(seedInput, options) {
    const b = planetBuilder(seedInput, options);
    b.step(Infinity);
    return b.result;
  }

  // ---------------------------------------------------------------------------
  // Climate (cheap; re-run whenever a slider moves)
  // ---------------------------------------------------------------------------

  const HIST_BINS = 4096;

  function allocClimate(planet) {
    const N = planet.N;
    return {
      N, planet: null, terrain: -1,
      height: new Float32Array(N), shade: new Float32Array(N),
      hmin: 0, hmax: 0, cum: new Float64Array(HIST_BINS + 1),
      biome: new Uint8Array(N), temp: new Float32Array(N), elev: new Float32Array(N),
      rgb: new Uint8Array(N * 3), water: new Uint8Array(N),
      lights: new Uint8Array(N), lightType: new Uint8Array(N),
      wet: new Float32Array(N), river: new Uint8Array(N), bank: new Uint8Array(N), path: new Int32Array(4096),
      clouds: new Float32Array(planet.CW * planet.CH), // pre-threshold: density = smoothstep(0, 1, value)
      stats: null, settings: null, seaLevel: 0,
    };
  }

  function buildElevation(planet, terrain, out) {
    const { W, H, N, cont, mtn, det, rowWeight, totalWeight } = planet;
    const v = 0.12 + (terrain / 100) * 1.5;
    const h = out.height;
    let hmin = Infinity, hmax = -Infinity;
    for (let i = 0; i < N; i++) {
      // Continents come first; ridged mountains rise mainly on continental
      // crust, so ocean floors stay smooth and coastlines stay coherent.
      const c = cont[i];
      let mask = (c + 0.02) * 5;
      mask = mask < 0 ? 0 : mask > 1 ? 1 : mask * mask * (3 - 2 * mask);
      const e = c + v * (0.3 * mtn[i] * mask + 0.05 * det[i]);
      h[i] = e;
      if (e < hmin) hmin = e;
      if (e > hmax) hmax = e;
    }
    if (!(hmax > hmin)) hmax = hmin + 1e-6;
    // Area-weighted histogram → water level slider maps exactly to ocean coverage.
    const hist = new Float64Array(HIST_BINS);
    const scale = HIST_BINS / (hmax - hmin);
    let i = 0;
    for (let y = 0; y < H; y++) {
      const wgt = rowWeight[y];
      for (let x = 0; x < W; x++, i++) {
        let b = ((h[i] - hmin) * scale) | 0;
        if (b >= HIST_BINS) b = HIST_BINS - 1;
        hist[b] += wgt;
      }
    }
    const cum = out.cum;
    cum[0] = 0;
    for (let b = 0; b < HIST_BINS; b++) cum[b + 1] = cum[b] + hist[b] / totalWeight;
    // Hillshade from a north-west light, baked into the texture for relief.
    const sh = out.shade;
    const k = 26;
    for (let y = 0; y < H; y++) {
      const up = (y > 0 ? y - 1 : y) * W, dn = (y < H - 1 ? y + 1 : y) * W, row = y * W;
      for (let x = 0; x < W; x++) {
        const l = x > 0 ? x - 1 : W - 1, r = x < W - 1 ? x + 1 : 0;
        const g = (h[row + l] - h[row + r]) + (h[up + x] - h[dn + x]);
        sh[row + x] = 1 + clamp(g * k, -0.42, 0.42);
      }
    }
    out.hmin = hmin; out.hmax = hmax; out.planet = planet; out.terrain = terrain;
    out.median = seaLevelFor(out, 0.5);
  }

  function seaLevelFor(out, waterFrac) {
    const { cum, hmin, hmax } = out;
    if (waterFrac <= 0) return hmin - 1e-6;
    if (waterFrac >= 1) return hmax + 1e-6;
    let lo = 0, hi = HIST_BINS;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid + 1] < waterFrac) lo = mid + 1; else hi = mid; }
    const b = lo, span = cum[b + 1] - cum[b];
    const f = span > 0 ? (waterFrac - cum[b]) / span : 0;
    return hmin + ((b + clamp(f, 0, 1)) / HIST_BINS) * (hmax - hmin);
  }

  function sanitizeSettings(s) {
    const o = s && typeof s === 'object' ? s : {};
    return { temp: clampSetting(o.temp, 'temp'), water: clampSetting(o.water, 'water'), terrain: clampSetting(o.terrain, 'terrain') };
  }

  /**
   * Classifies every point into a biome, colours the texture and computes
   * stats. Reuses `out` buffers when given (fast path for live sliders).
   */
  function applyClimate(planet, settings, out) {
    const s = sanitizeSettings(settings);
    if (!out || out.N !== planet.N || out.clouds.length !== planet.CW * planet.CH) out = allocClimate(planet);
    if (out.planet !== planet || out.terrain !== s.terrain) buildElevation(planet, s.terrain, out);

    const { W, H, moist, tnoise, det, mtn, rowLat, rowSin, rowWeight, totalWeight, palette } = planet;
    const h = out.height, shade = out.shade;
    const wf = s.water / 100;
    const sl = seaLevelFor(out, wf);
    // Altitude cooling is measured from sea level, or from the median ground
    // height on dry worlds, so a low ocean does not make the whole world cold.
    const lapseRef = Math.max(sl, out.median);
    // Relief scales with terrain variation below the midpoint, so "rolling plains" stay low.
    const LS = LAND_SCALE * (0.3 + 0.7 * Math.min(1, s.terrain / 50));
    const base = s.temp;
    const biome = out.biome, temp = out.temp, elev = out.elev, rgb = out.rgb, water = out.water;

    const area = new Float64Array(BIOMES.length);
    let tempSum = 0, peak = -Infinity, landArea = 0;
    const hotDesert = [226, 156, 92];
    const rock = [118, 108, 98];

    let i = 0;
    for (let y = 0; y < H; y++) {
      const s2 = rowSin[y] * rowSin[y];
      // Area-weighted mean of sin^4(lat) over a sphere is 1/5, so this term
      // averages to zero: the slider value is the true sea-level mean.
      const latT = LAT_SPREAD * (0.2 - s2 * s2);
      const moistLat = 0.5 + 0.5 * Math.cos(rowLat[y] * 6);
      const wgt = rowWeight[y];
      for (let x = 0; x < W; x++, i++) {
        const e = h[i];
        const Tsea = base + latT + 3 * tnoise[i];
        const v = 1 + det[i] * 0.2;
        let b, T, em, r, g, bl;
        if (e < sl) {
          em = (e - sl) * ELEV_SCALE; // negative depth
          T = Tsea;
          const depth = -em;
          water[i] = 1;
          out.wet[i] = 1;
          if (Tsea < -9) {
            b = BIOME.SEA_ICE; water[i] = 0;
            const c = palette[b];
            r = c[0] * v; g = c[1] * v; bl = c[2] * v;
          } else {
            b = depth < 220 ? BIOME.SHALLOW : depth < 2600 ? BIOME.OCEAN : BIOME.DEEP;
            const t = Math.sqrt(clamp(depth / 5200, 0, 1));
            const cs = palette[BIOME.SHALLOW], co = palette[BIOME.OCEAN], cd = palette[BIOME.DEEP];
            if (t < 0.32) { const k = t / 0.32; r = lerp(cs[0], co[0], k); g = lerp(cs[1], co[1], k); bl = lerp(cs[2], co[2], k); }
            else { const k = (t - 0.32) / 0.68; r = lerp(co[0], cd[0], k); g = lerp(co[1], cd[1], k); bl = lerp(co[2], cd[2], k); }
            const vv = 1 + det[i] * 0.06;
            r *= vv; g *= vv; bl *= vv;
          }
        } else {
          water[i] = 0;
          // Heights are measured from the datum (sea level, or the median
          // ground on dry worlds) and curved so lowlands stay low.
          const dr = e - lapseRef;
          const emRel = dr >= 0 ? LS * dr * Math.sqrt(dr) : -LS * -dr * Math.sqrt(-dr);
          T = Tsea - (dr > 0 ? (LAPSE * emRel) / 1000 : 0);
          const ds = e - sl;
          const aboveSea = LS * ds * Math.sqrt(ds);
          // Shown heights are above sea level; with no ocean at all, above the median ground.
          em = wf > 0 ? aboveSea : emRel;
          let me = 0.62 * (moist[i] * 1.25 + 0.5) + 0.38 * moistLat + (wf - 0.55) * 0.35 - Math.max(0, T - 24) * 0.022;
          me = clamp(me, 0, 1);
          out.wet[i] = me;
          if (T > 52) b = BIOME.SCORCHED;
          else if (emRel > 3200) b = T < -14 ? BIOME.SNOW : BIOME.MOUNTAIN;
          else if (T < -18) b = BIOME.ICE;
          else if (T < -5) b = BIOME.SNOW;
          else if (aboveSea < 30 && wf > 0 && T > 1) b = BIOME.BEACH;
          else if (T < 3) b = BIOME.TUNDRA;
          else if (T < 9) b = me > 0.45 ? BIOME.TAIGA : BIOME.TUNDRA;
          else if (T < 22) b = me < 0.25 ? BIOME.DESERT : me < 0.5 ? BIOME.GRASSLAND : BIOME.FOREST;
          else b = me < 0.3 ? BIOME.DESERT : me < 0.5 ? BIOME.SAVANNA : BIOME.RAINFOREST;

          const c = palette[b];
          r = c[0]; g = c[1]; bl = c[2];
          if (b === BIOME.DESERT && T > 30) {
            const k = smoothstep(30, 48, T);
            r = lerp(r, hotDesert[0], k); g = lerp(g, hotDesert[1], k); bl = lerp(bl, hotDesert[2], k);
          }
          if (b !== BIOME.SNOW && b !== BIOME.ICE && b !== BIOME.SCORCHED) {
            const k = smoothstep(1800, 4600, emRel) * 0.85;
            r = lerp(r, rock[0], k); g = lerp(g, rock[1], k); bl = lerp(bl, rock[2], k);
          }
          const sh = shade[i] * v;
          r *= sh; g *= sh; bl *= sh;
          landArea += wgt;
          if (em > peak) peak = em;
        }
        biome[i] = b; temp[i] = T; elev[i] = em;
        area[b] += wgt;
        tempSum += T * wgt;
        const o3 = i * 3;
        rgb[o3] = r > 255 ? 255 : r < 0 ? 0 : r;
        rgb[o3 + 1] = g > 255 ? 255 : g < 0 ? 0 : g;
        rgb[o3 + 2] = bl > 255 ? 255 : bl < 0 ? 0 : bl;
      }
    }

    softenLand(out, planet, sl);
    const riverCount = carveRivers(out, planet, sl);

    const frac = Array.from(area, (a) => a / totalWeight);
    const waterFrac = frac[0] + frac[1] + frac[2] + frac[3];
    const landFrac = Math.max(0, 1 - waterFrac);
    const iceFrac = frac[BIOME.SEA_ICE] + frac[BIOME.SNOW] + frac[BIOME.ICE];
    const avgTemp = tempSum / totalWeight;
    let livable = 0;
    for (let b = 0; b < BIOMES.length; b++) livable += frac[b] * BIOMES[b].livable;
    const waterScore = waterFrac <= 0.001 ? 0 : clamp(1 - Math.abs(waterFrac - 0.62) / 0.5, 0, 1);
    const tempScore = clamp(1 - Math.abs(avgTemp - 14) / 30, 0, 1);
    const habitability = Math.round(100 * (0.55 * clamp(livable / 0.28, 0, 1) + 0.2 * waterScore + 0.25 * tempScore));

    // Night side: city lights on livable land (only if life could thrive), lava on scorched rock.
    const lights = out.lights, lightType = out.lightType, city = planet.city;
    const cityOn = habitability >= 35;
    const thr = 0.5 - 0.14 * clamp((habitability - 35) / 65, 0, 1);
    let litArea = 0;
    i = 0;
    for (let y = 0; y < H; y++) {
      const wgt = rowWeight[y];
      for (let x = 0; x < W; x++, i++) {
        const b = biome[i];
        let L = 0, type = 0;
        if (b === BIOME.SCORCHED) {
          const k = smoothstep(0.5, 0.75, mtn[i] + det[i] * 0.4);
          if (k > 0) { L = k * 230; type = 2; }
        } else if (cityOn && BIOMES[b].livable >= 0.5) {
          const coast = elev[i] < 60 ? 0.12 : 0;
          const k = smoothstep(thr, thr + 0.14, city[i] + coast);
          if (k > 0) { L = k * 255; type = 1; litArea += wgt * k; }
        }
        lights[i] = L; lightType[i] = type;
      }
    }

    // Clouds: wetter worlds are cloudier; scorching, dry worlds clear up.
    const cov = clamp(0.05 + 0.36 * wf - Math.max(0, base - 32) * 0.008 + (base < -10 ? -0.04 : 0), 0.02, 0.45);
    const cr = planet.cloudRaw, clouds = out.clouds;
    const lo = 0.24 - cov * 0.62, inv = 1 / 0.42;
    let cloudSum = 0;
    for (let j = 0; j < cr.length; j++) {
      const v = (cr[j] - lo) * inv;
      clouds[j] = v;
      cloudSum += v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v);
    }

    const stats = {
      frac, waterFrac, landFrac, iceFrac, avgTemp, habitability,
      peak: landArea > 0 ? Math.max(0, peak) : 0, hasLand: landArea > 0,
      civilization: litArea / totalWeight > 0.0004,
      cloudCover: cloudSum / cr.length,
      seaLevel: sl,
      rivers: riverCount,
    };
    const desc = describe(planet, stats);
    stats.className = desc.className;
    stats.habLabel = desc.habLabel;
    stats.note = desc.note;
    stats.atmosphere = atmosphereColor(stats);
    stats.topBiomes = frac
      .map((f, id) => ({ id, f }))
      .filter((b) => b.f > 0.0005)
      .sort((a, b) => b.f - a.f);
    out.stats = stats;
    out.settings = s;
    out.seaLevel = sl;
    out.landScale = LS;
    return out;
  }

  /**
   * Light 3x3 blur of land colours (never across a coastline), so biome
   * borders read as natural gradients instead of hard texel steps.
   */
  function softenLand(out, planet, sl) {
    const { W, H } = planet;
    const h = out.height, rgb = out.rgb;
    if (!out.rgbTmp || out.rgbTmp.length !== rgb.length) out.rgbTmp = new Uint8Array(rgb.length);
    const src = out.rgbTmp;
    src.set(rgb);
    for (let y = 1; y < H - 1; y++) {
      const up = (y - 1) * W, row = y * W, dn = (y + 1) * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (h[i] < sl) continue;
        const l = x > 0 ? x - 1 : W - 1, r = x < W - 1 ? x + 1 : 0;
        if (h[row + l] < sl || h[row + r] < sl || h[up + x] < sl || h[dn + x] < sl ||
            h[up + l] < sl || h[up + r] < sl || h[dn + l] < sl || h[dn + r] < sl) continue;
        const a = (up + l) * 3, b = (up + x) * 3, c = (up + r) * 3, d = (row + l) * 3, e = i * 3, f = (row + r) * 3,
          g = (dn + l) * 3, k = (dn + x) * 3, m = (dn + r) * 3;
        for (let ch = 0; ch < 3; ch++) {
          rgb[e + ch] = (src[a + ch] + src[c + ch] + src[g + ch] + src[m + ch] +
            2 * (src[b + ch] + src[d + ch] + src[f + ch] + src[k + ch]) + 4 * src[e + ch] + 8) >> 4;
        }
      }
    }
  }

  /**
   * Rivers: in each 16x16 block, the highest wet, unfrozen land point becomes
   * a spring. Water then runs downhill (steepest of 8 neighbours) until it
   * reaches the sea, joins another river or pools in a basin (a lake). Land
   * next to a river turns greener. Fully deterministic; returns the count.
   */
  const RIVER_CELL = 16;
  const DRY_BANK = new Uint8Array(16);
  [BIOME.DESERT, BIOME.SAVANNA, BIOME.GRASSLAND, BIOME.TUNDRA].forEach((b) => { DRY_BANK[b] = 1; });
  function riverBlocked(b) {
    return b === BIOME.SNOW || b === BIOME.ICE || b === BIOME.SCORCHED || b === BIOME.SEA_ICE;
  }
  function carveRivers(out, planet, sl) {
    const { W, H, palette, rowCos } = planet;
    const h = out.height, biome = out.biome, temp = out.temp, elev = out.elev, rgb = out.rgb, wet = out.wet;
    const shade = out.shade;
    if (!out.river || out.river.length !== W * H) {
      out.wet = out.wet && out.wet.length === W * H ? out.wet : new Float32Array(W * H);
      out.river = new Uint8Array(W * H); out.bank = new Uint8Array(W * H); out.path = new Int32Array(4096);
    }
    const river = out.river, bank = out.bank, path = out.path;
    river.fill(0); bank.fill(0);
    let count = 0;
    for (let y0 = 0; y0 + RIVER_CELL <= H; y0 += RIVER_CELL) {
      if (rowCos[y0 + (RIVER_CELL >> 1)] < 0.34) continue; // skip polar caps
      for (let x0 = 0; x0 + RIVER_CELL <= W; x0 += RIVER_CELL) {
        let best = -1, bestH = -Infinity;
        for (let y = y0; y < y0 + RIVER_CELL; y++) {
          for (let x = x0; x < x0 + RIVER_CELL; x++) {
            const i = y * W + x;
            if (h[i] < sl || h[i] <= bestH) continue;
            const b = biome[i];
            if (riverBlocked(b) || b === BIOME.BEACH || wet[i] < 0.5 || elev[i] < 700) continue;
            if (temp[i] < -3 || temp[i] > 45) continue;
            best = i; bestH = h[i];
          }
        }
        if (best < 0 || river[best]) continue;
        let cur = best, n = 0, end = 0; // end: 0 = basin, 1 = sea or another river
        path[n++] = cur;
        while (n < path.length) {
          const y = (cur / W) | 0, x = cur - y * W;
          let next = -1, nh = h[cur];
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              let xx = x + dx;
              if (xx < 0) xx += W; else if (xx >= W) xx -= W;
              const j = yy * W + xx;
              if (h[j] < nh) { nh = h[j]; next = j; }
            }
          }
          if (next < 0) break;                       // basin: ends in a lake
          if (h[next] < sl || river[next]) { end = 1; break; } // sea or confluence
          if (riverBlocked(biome[next])) break;       // runs under ice or dries out
          cur = next;
          path[n++] = cur;
        }
        if (n < (end ? 5 : 14)) continue;
        count++;
        for (let k = 0; k < n; k++) river[path[k]] = 1;
        if (!end) river[cur] = 2; // lake at the end of an inland river
      }
    }
    if (!count) return 0;
    // Banks: mark land within two texels of a river.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!river[y * W + x]) continue;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -2; dx <= 2; dx++) {
            let xx = x + dx;
            if (xx < 0) xx += W; else if (xx >= W) xx -= W;
            const j = yy * W + xx;
            const lvl = Math.abs(dx) <= 1 && Math.abs(dy) <= 1 ? 2 : 1;
            if (lvl > bank[j]) bank[j] = lvl;
          }
        }
      }
    }
    const green = palette[BIOME.GRASSLAND], lush = palette[BIOME.FOREST];
    const rs = palette[BIOME.SHALLOW], ro = palette[BIOME.OCEAN];
    const N = W * H;
    for (let i = 0; i < N; i++) {
      const o3 = i * 3;
      if (river[i]) {
        const sh = shade[i] * 0.92, k = river[i] === 2 ? 0.55 : 0.3;
        rgb[o3] = clamp(lerp(rs[0], ro[0], k) * sh, 0, 255);
        rgb[o3 + 1] = clamp(lerp(rs[1], ro[1], k) * sh, 0, 255);
        rgb[o3 + 2] = clamp(lerp(rs[2], ro[2], k) * sh, 0, 255);
      } else if (bank[i] && h[i] >= sl && DRY_BANK[biome[i]]) {
        const t = bank[i] === 2 ? 0.55 : 0.3, c = bank[i] === 2 ? lush : green, sh = shade[i];
        rgb[o3] = clamp(lerp(rgb[o3], c[0] * sh, t), 0, 255);
        rgb[o3 + 1] = clamp(lerp(rgb[o3 + 1], c[1] * sh, t), 0, 255);
        rgb[o3 + 2] = clamp(lerp(rgb[o3 + 2], c[2] * sh, t), 0, 255);
      }
    }
    return count;
  }

  function atmosphereColor(st) {
    let c = [96, 166, 255];
    const mix = (to, k) => { c = [lerp(c[0], to[0], k), lerp(c[1], to[1], k), lerp(c[2], to[2], k)]; };
    if (st.avgTemp > 26) mix([255, 150, 92], smoothstep(26, 50, st.avgTemp));
    if (st.avgTemp < 0) mix([196, 230, 255], smoothstep(0, -25, st.avgTemp));
    if (st.waterFrac < 0.2) mix([236, 186, 140], smoothstep(0.2, 0, st.waterFrac) * 0.6);
    return c.map((v) => Math.round(v));
  }

  function habLabelFor(h) {
    if (h >= 80) return 'Paradise';
    if (h >= 60) return 'Habitable';
    if (h >= 40) return 'Marginal';
    if (h >= 20) return 'Harsh';
    return 'Hostile';
  }

  function describe(planet, st) {
    const f = st.frac, L = st.landFrac, Wf = st.waterFrac, T = st.avgTemp;
    const land = (k) => (L > 0.0001 ? f[k] / L : 0);
    let cls;
    if (f[BIOME.SCORCHED] > 0.22) cls = 'Scorched World';
    else if (st.iceFrac > 0.55) cls = Wf > 0.6 ? 'Frozen Ocean World' : 'Ice World';
    else if (Wf >= 0.92) cls = 'Ocean World';
    else if (Wf >= 0.78) cls = 'Archipelago World';
    else if (Wf <= 0.15) cls = land(BIOME.DESERT) + land(BIOME.SCORCHED) + land(BIOME.SAVANNA) * 0.5 > 0.35 ? 'Desert World' : 'Dry World';
    else if (land(BIOME.DESERT) + land(BIOME.SAVANNA) * 0.5 > 0.45) cls = 'Arid World';
    else if (land(BIOME.MOUNTAIN) > 0.08) cls = 'Highland World';
    else if (land(BIOME.RAINFOREST) > 0.3 && land(BIOME.RAINFOREST) + land(BIOME.FOREST) > 0.5) cls = 'Jungle World';
    else if (land(BIOME.FOREST) + land(BIOME.TAIGA) > 0.5) cls = 'Forest World';
    else if (land(BIOME.TUNDRA) + land(BIOME.TAIGA) + land(BIOME.SNOW) + land(BIOME.ICE) > 0.5) cls = 'Boreal World';
    else if (Wf < 0.15) cls = 'Dry World';
    else cls = 'Temperate World';

    const pct = (x) => Math.round(x * 100) + '%';
    const notes = [];
    // 1. What dominates the surface.
    if (!st.hasLand) notes.push('Endless ocean wraps the globe; there is no dry land to stand on.');
    else if (Wf >= 0.97) notes.push('Oceans cover ' + pct(Wf) + ' of the surface; only a few tiny islands break the waves.');
    else if (Wf >= 0.78) notes.push('Oceans cover ' + pct(Wf) + ' of the surface, broken by scattered islands.');
    else if (Wf <= 0.005) notes.push('Not a single ocean: the whole surface is dry ground.');
    else if (Wf <= 0.15) notes.push('Water is scarce: seas cover only ' + pct(Wf) + ' of the surface.');
    else {
      let best = -1, bestF = 0;
      for (let b = 4; b < BIOMES.length; b++) if (f[b] > bestF) { bestF = f[b]; best = b; }
      if (best >= 0) notes.push(BIOMES[best].name + ' is the most common terrain, covering ' + pct(bestF / L) + ' of the land.');
    }
    // 2. Climate flavour.
    if (T > 38) notes.push('Surface heat averages ' + Math.round(T) + ' °C; probes would melt by noon.');
    else if (T > 26) notes.push('A hot world: ' + Math.round(T) + ' °C on average.');
    else if (T < -12) notes.push('Bring a very warm coat: it averages ' + Math.round(T) + ' °C.');
    else if (T < 2) notes.push('Cold and windswept, averaging ' + Math.round(T) + ' °C.');
    else if (st.hasLand && st.peak > 1500) notes.push(planet.peakName + ' rises ' + Math.round(st.peak).toLocaleString('en-US') + ' m above ' + (Wf > 0.01 ? 'sea level.' : 'the plains.'));
    else notes.push('Mild climate, averaging ' + Math.round(T) + ' °C.');
    // 3. Life, rings or flora.
    if (st.civilization) notes.push('Lights glitter across the night side. Someone lives here.');
    else if (f[BIOME.SCORCHED] > 0.05) notes.push('Rivers of lava glow on the night side.');
    else if (st.habitability >= 60) notes.push('Ideal for life, but nobody has moved in yet.');
    else if (planet.traits.rings) notes.push('A bright ring system circles its equator.');
    else if (planet.traits.flora !== 'Green' && L > 0.05) notes.push('Its plants are ' + planet.traits.flora.replace('Exotic ', '') + ', not green.');
    else notes.push('No sign of life detected.');
    return { className: cls, habLabel: habLabelFor(st.habitability), note: notes.join(' ') };
  }

  /** Point inspector for tooltips. Returns null for out-of-range input. */
  function sampleAt(planet, climate, tx, ty) {
    if (!planet || !climate || !Number.isFinite(tx) || !Number.isFinite(ty)) return null;
    const W = planet.W, H = planet.H;
    const x = ((Math.floor(tx) % W) + W) % W;
    const y = clamp(Math.floor(ty), 0, H - 1);
    const i = y * W + x;
    const b = climate.biome[i];
    const lat = (planet.rowLat[y] * 180) / Math.PI;
    const lon = (((x + 0.5) / W) * 360) - 180;
    return {
      biome: BIOMES[b], temp: climate.temp[i], elev: climate.elev[i], lat, lon, index: i,
      river: climate.river ? climate.river[i] : 0,
    };
  }

  return Object.freeze({
    VERSION: '1.0.0',
    DEFAULT_SEED, MAX_SEED_LENGTH, LIMITS, BIOME, BIOMES, PRESETS, DEFAULTS,
    normalizeSeed, hashString, mulberry32, makeNoise3,
    sanitizeState, parseHash, toHash, randomSeed, planetName,
    planetBuilder, createPlanet, applyClimate, sampleAt, smoothstep, clamp,
  });
});
