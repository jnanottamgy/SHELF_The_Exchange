/*!
 * Tiny Terra — self-checks for the planet engine.
 * Runs in the browser (tests.html) and in Node: `node js/tests.js`.
 */
(function (root) {
  'use strict';

  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function approx(a, b, tol, msg) {
    if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'value') + ': expected ' + b + ' ± ' + tol + ', got ' + a);
  }
  function fingerprint(c) {
    let h = 0x811c9dc5;
    const feed = (arr) => { for (let i = 0; i < arr.length; i += 7) { h ^= Math.round(arr[i] * 1000); h = Math.imul(h, 16777619); } };
    feed(c.rgb); feed(c.biome); feed(c.temp); feed(c.clouds); feed(c.lights);
    return (h >>> 0).toString(16) + ':' + c.stats.habitability + ':' + c.stats.className;
  }
  function allFinite(arr) { for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false; return true; }

  const WEIRD_SEEDS = [
    '', ' ', '   \t\n ', '🌍🔥🪐', 'a'.repeat(10000), '<script>alert(1)</script>', "'; DROP TABLE planets; --",
    '\u0000\u0001\u0002', 'مرحبا بالعالم', '日本語のシード', '\uD800', '​​', 'null', 'undefined', 'NaN',
    '-0', '1e309', '__proto__', 'constructor', '%00%ZZ', '../../etc/passwd', 'ＴＥＲＲＡ', 'é', 'é',
  ];

  function defineTests(T) {
    const tests = [];
    const test = (name, fn, group) => tests.push({ name, fn, group: group || 'Engine' });
    const SMALL = { width: 96 };

    // ---------------- Determinism ----------------
    test('Same seed and settings always build the identical planet', () => {
      const a = T.applyClimate(T.createPlanet('blue marble'), { temp: 15, water: 68, terrain: 50 });
      const b = T.applyClimate(T.createPlanet('blue marble'), { temp: 15, water: 68, terrain: 50 });
      assert(fingerprint(a) === fingerprint(b), 'fingerprints differ: ' + fingerprint(a) + ' vs ' + fingerprint(b));
    }, 'Determinism');

    test('Generation never calls Math.random', () => {
      const orig = Math.random;
      Math.random = () => { throw new Error('Math.random was called during generation'); };
      try {
        const p = T.createPlanet('no dice', SMALL);
        T.applyClimate(p, { temp: 10, water: 40, terrain: 70 });
      } finally { Math.random = orig; }
    }, 'Determinism');

    test('Incremental builder gives exactly the same planet as a one-shot build', () => {
      const b = T.planetBuilder('chunky', SMALL);
      let last = -1, guard = 0;
      while (!b.step(0.01)) {
        assert(b.progress >= last, 'progress went backwards');
        last = b.progress;
        assert(++guard < 100000, 'builder never finished');
      }
      assert(b.progress === 1, 'progress should end at 1');
      const x = fingerprint(T.applyClimate(b.result, { temp: 20, water: 50, terrain: 50 }));
      const y = fingerprint(T.applyClimate(T.createPlanet('chunky', SMALL), { temp: 20, water: 50, terrain: 50 }));
      assert(x === y, 'builder result differs');
    }, 'Determinism');

    test('Different seeds give different planets', () => {
      const seen = new Set();
      ['alpha', 'beta', 'gamma', 'delta', 'Alpha', 'alpha ', 'alpha1'].forEach((s) => {
        seen.add(fingerprint(T.applyClimate(T.createPlanet(s, SMALL), {})));
      });
      // 'alpha ' trims to 'alpha', so 6 distinct planets are expected.
      assert(seen.size === 6, 'expected 6 distinct planets, got ' + seen.size);
    }, 'Determinism');

    test('Re-running the climate on reused buffers matches a fresh run', () => {
      const p = T.createPlanet('buffers', SMALL);
      let c = T.applyClimate(p, { temp: -20, water: 90, terrain: 10 });
      c = T.applyClimate(p, { temp: 30, water: 20, terrain: 90 }, c);
      c = T.applyClimate(p, { temp: 15, water: 60, terrain: 50 }, c);
      const fresh = T.applyClimate(p, { temp: 15, water: 60, terrain: 50 });
      assert(fingerprint(c) === fingerprint(fresh), 'stale data leaked between climate runs');
    }, 'Determinism');

    // ---------------- Seeds ----------------
    test('Seeds are trimmed, whitespace is collapsed and length is capped at 200', () => {
      assert(T.normalizeSeed('  hello   world  ') === 'hello world', 'whitespace not normalised');
      assert(Array.from(T.normalizeSeed('x'.repeat(5000))).length === 200, 'length not capped');
      assert(Array.from(T.normalizeSeed('🪐'.repeat(300))).length === 200, 'emoji length not capped by character');
      assert(T.normalizeSeed('é') === T.normalizeSeed('é'), 'unicode forms should match');
    }, 'Seeds');

    test('Any value is accepted as a seed without throwing', () => {
      const odd = [null, undefined, 0, -1, NaN, Infinity, {}, [], [1, 2], true, Symbol('x'), function () { }, { toString() { throw new Error('boom'); } }];
      odd.forEach((v) => { const s = T.normalizeSeed(v); assert(typeof s === 'string', 'not a string for ' + String(typeof v)); });
    }, 'Seeds');

    test('Hostile and unusual seeds generate valid planets', () => {
      WEIRD_SEEDS.forEach((s) => {
        const c = T.applyClimate(T.createPlanet(s, { width: 48 }), {});
        assert(Number.isFinite(c.stats.avgTemp), 'avgTemp not finite for ' + JSON.stringify(s.slice(0, 20)));
        assert(c.stats.className && c.stats.note, 'missing description for ' + JSON.stringify(s.slice(0, 20)));
      });
    }, 'Seeds');

    test('A blank seed falls back to the default planet', () => {
      const a = T.createPlanet('   ', { width: 48 }), b = T.createPlanet(T.DEFAULT_SEED, { width: 48 });
      assert(a.seed === T.DEFAULT_SEED && a.hash === b.hash, 'blank seed did not use the default');
    }, 'Seeds');

    test('Planet names are deterministic and well formed', () => {
      for (let i = 0; i < 200; i++) {
        const n1 = T.planetName(T.hashString('n' + i)), n2 = T.planetName(T.hashString('n' + i));
        assert(n1.name === n2.name && n1.designation === n2.designation, 'name changed between runs');
        assert(/^[A-Z][a-z]+$/.test(n1.name), 'bad name ' + n1.name);
        assert(/^TT-\d{4}[b-g]$/.test(n1.designation), 'bad designation ' + n1.designation);
      }
    }, 'Seeds');

    // ---------------- Sliders ----------------
    test('Water level slider sets ocean coverage exactly (±1.5%)', () => {
      const p = T.createPlanet('tides', { width: 128 });
      let c = null;
      [0, 30, 100].forEach((terrain) => {
        for (let w = 0; w <= 100; w += 5) {
          c = T.applyClimate(p, { temp: 15, water: w, terrain }, c);
          approx(c.stats.waterFrac * 100, w, 1.5, 'ocean % at water ' + w + ', terrain ' + terrain);
        }
      });
    }, 'Sliders');

    test('Water 0% leaves no ocean; water 100% leaves no land', () => {
      const p = T.createPlanet('extremes', SMALL);
      const dry = T.applyClimate(p, { temp: 15, water: 0, terrain: 50 });
      assert(dry.stats.waterFrac === 0, 'dry planet has water');
      const wet = T.applyClimate(p, { temp: 15, water: 100, terrain: 50 });
      assert(wet.stats.landFrac === 0 && !wet.stats.hasLand && wet.stats.peak === 0, 'waterworld has land');
    }, 'Sliders');

    test('A hot planet has more desert; a cold planet has more snow and ice', () => {
      const p = T.createPlanet('climate', { width: 128 });
      const hot = T.applyClimate(p, { temp: 40, water: 40, terrain: 50 }).stats;
      const cold = T.applyClimate(p, { temp: -20, water: 40, terrain: 50 }).stats;
      const desert = (s) => s.frac[T.BIOME.DESERT] + s.frac[T.BIOME.SCORCHED];
      assert(desert(hot) > desert(cold) + 0.2, 'hot planet should be much more desert');
      assert(cold.iceFrac > hot.iceFrac + 0.3, 'cold planet should be much icier');
    }, 'Sliders');

    test('Average temperature rises steadily with the temperature slider', () => {
      const p = T.createPlanet('thermo', SMALL);
      let prev = -Infinity, c = null;
      for (let t = -30; t <= 50; t += 5) {
        c = T.applyClimate(p, { temp: t, water: 60, terrain: 50 }, c);
        assert(c.stats.avgTemp > prev, 'avg temp did not rise at ' + t);
        prev = c.stats.avgTemp;
      }
    }, 'Sliders');

    test('More terrain variation makes taller mountains', () => {
      const p = T.createPlanet('peaks', SMALL);
      const low = T.applyClimate(p, { temp: 15, water: 60, terrain: 0 }).stats.peak;
      const high = T.applyClimate(p, { temp: 15, water: 60, terrain: 100 }).stats.peak;
      assert(high > low * 1.3, 'terrain 100 peak ' + Math.round(high) + ' vs terrain 0 peak ' + Math.round(low));
    }, 'Sliders');

    test('Every slider combination produces valid numbers and colours', () => {
      const p = T.createPlanet('sweep', { width: 48 });
      let c = null;
      for (const temp of [-30, -10, 0, 15, 35, 50]) {
        for (const water of [0, 1, 50, 99, 100]) {
          for (const terrain of [0, 50, 100]) {
            c = T.applyClimate(p, { temp, water, terrain }, c);
            const st = c.stats;
            assert(allFinite(c.temp) && allFinite(c.elev) && allFinite(c.clouds), 'non-finite field at ' + [temp, water, terrain]);
            assert(Number.isInteger(st.habitability) && st.habitability >= 0 && st.habitability <= 100, 'bad habitability');
            assert([st.waterFrac, st.landFrac, st.iceFrac, st.avgTemp, st.peak].every(Number.isFinite), 'non-finite stat');
            const sum = st.frac.reduce((a, b) => a + b, 0);
            approx(sum, 1, 1e-6, 'biome fractions sum');
            for (let i = 0; i < c.biome.length; i++) assert(T.BIOMES[c.biome[i]], 'unknown biome id ' + c.biome[i]);
          }
        }
      }
    }, 'Sliders');

    test('Out-of-range and junk settings are clamped, never crash', () => {
      const p = T.createPlanet('junk', { width: 48 });
      const junk = [{ temp: 1e9, water: -1e9, terrain: NaN }, { temp: 'hot', water: '50', terrain: null }, null, 'x', { temp: Infinity }];
      junk.forEach((s) => {
        const c = T.applyClimate(p, s);
        assert(Number.isFinite(c.stats.avgTemp), 'junk settings broke the climate');
        assert(c.settings.temp >= -30 && c.settings.temp <= 50 && c.settings.water >= 0 && c.settings.water <= 100, 'not clamped');
      });
    }, 'Sliders');

    test('Presets are valid, unique and inside slider limits', () => {
      const ids = new Set();
      T.PRESETS.forEach((p) => {
        assert(!ids.has(p.id), 'duplicate preset ' + p.id); ids.add(p.id);
        ['temp', 'water', 'terrain'].forEach((k) => assert(p[k] >= T.LIMITS[k].min && p[k] <= T.LIMITS[k].max, p.id + '.' + k + ' out of range'));
      });
    }, 'Sliders');

    // ---------------- Share links ----------------
    test('Share links round-trip exactly', () => {
      const s = { seed: 'Planet X 🌍 & friends?=#', temp: -12, water: 33, terrain: 81, view: 'map' };
      const back = T.parseHash(T.toHash(s));
      assert(back.seed === s.seed && back.temp === -12 && back.water === 33 && back.terrain === 81 && back.view === 'map', 'round trip failed: ' + JSON.stringify(back));
    }, 'Share links');

    test('Tampered share links are cleaned up safely', () => {
      const cases = [
        ['#t=abc&w=xyz&r=', { temp: 15, water: 68, terrain: 50 }],
        ['#t=9999&w=-5&r=1e400', { temp: 50, water: 0, terrain: 50 }],
        ['#t=-0.4&w=33.6', { temp: 0, water: 34 }],
        ['#s=%E0%A4%A&t=10', { seed: T.DEFAULT_SEED, temp: 10 }],
        ['#s=first&s=second', { seed: 'first' }],
        ['#v=<img src=x onerror=alert(1)>', { view: 'globe' }],
        ['#__proto__=1&constructor=2', { seed: T.DEFAULT_SEED }],
        ['', { seed: T.DEFAULT_SEED, temp: 15, water: 68, terrain: 50, view: 'globe' }],
        ['#&&&==&=&s', { seed: T.DEFAULT_SEED }],
      ];
      cases.forEach(([hash, expect]) => {
        const st = T.parseHash(hash);
        Object.keys(expect).forEach((k) => assert(st[k] === expect[k], hash + ' → ' + k + ' = ' + st[k] + ', expected ' + expect[k]));
      });
      const long = T.parseHash('#s=' + 'x'.repeat(100000));
      assert(Array.from(long.seed).length <= 200, 'long seed not capped');
      [undefined, null, 42, {}, '#'].forEach((h) => assert(T.parseHash(h).seed === T.DEFAULT_SEED, 'bad hash input'));
    }, 'Share links');

    test('Sanitised state has exactly the expected keys (no prototype tricks)', () => {
      const evil = JSON.parse('{"__proto__": {"polluted": true}, "seed": "ok", "extra": 1}');
      const st = T.sanitizeState(evil);
      assert(({}).polluted === undefined, 'prototype polluted');
      assert(Object.keys(st).sort().join(',') === 'seed,speed,temp,terrain,view,water', 'unexpected keys ' + Object.keys(st));
    }, 'Share links');

    // ---------------- Data integrity ----------------
    test('Biome table is complete and every biome has a colour', () => {
      T.BIOMES.forEach((b, i) => {
        assert(b.id === i, 'biome id mismatch');
        assert(b.name && b.color.length === 3 && b.color.every((v) => v >= 0 && v <= 255), 'bad biome ' + b.key);
      });
    }, 'Data');

    test('Inspector handles any coordinate, including off-map ones', () => {
      const p = T.createPlanet('probe', { width: 48 });
      const c = T.applyClimate(p, {});
      [[0, 0], [-5, -5], [1e6, 1e6], [47.99, 23.99], [-0.0001, 12]].forEach(([x, y]) => {
        const s = T.sampleAt(p, c, x, y);
        assert(s && s.biome && Number.isFinite(s.temp) && s.lat >= -90 && s.lat <= 90 && s.lon >= -180 && s.lon <= 180, 'bad sample at ' + x + ',' + y);
      });
      assert(T.sampleAt(p, c, NaN, 0) === null && T.sampleAt(null, c, 0, 0) === null, 'invalid input should return null');
    }, 'Data');

    test('Unusual texture sizes still work', () => {
      [[16, 8], [33, 17], [64, 64]].forEach(([w, h]) => {
        const c = T.applyClimate(T.createPlanet('size', { width: w, height: h }), {});
        assert(Number.isFinite(c.stats.avgTemp), 'size ' + w + 'x' + h + ' failed');
      });
    }, 'Data');

    // ---------------- Performance ----------------
    test('Full planet builds in under 1.5 s and re-colours in under 60 ms', () => {
      const now = (typeof performance !== 'undefined') ? () => performance.now() : () => Date.now();
      let t = now();
      const p = T.createPlanet('stopwatch');
      const gen = now() - t;
      let c = T.applyClimate(p, {});
      t = now();
      for (let i = 0; i < 5; i++) c = T.applyClimate(p, { temp: 10 + i, water: 60, terrain: 50 }, c);
      const recolor = (now() - t) / 5;
      assert(gen < 1500, 'build took ' + Math.round(gen) + ' ms');
      assert(recolor < 60, 'recolour took ' + Math.round(recolor) + ' ms');
      return 'build ' + Math.round(gen) + ' ms · recolour ' + recolor.toFixed(1) + ' ms';
    }, 'Performance');

    return tests;
  }

  /** Runs tests one at a time so a browser page stays responsive. */
  function runAll(T, onResult, onDone) {
    const tests = defineTests(T);
    const results = [];
    let i = 0;
    const next = () => {
      if (i >= tests.length) { if (onDone) onDone(results); return; }
      const t = tests[i++];
      const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      let ok = true, detail = '';
      try { const r = t.fn(); if (typeof r === 'string') detail = r; }
      catch (e) { ok = false; detail = e && e.message ? e.message : String(e); }
      const ms = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - now;
      const res = { name: t.name, group: t.group, ok, detail, ms };
      results.push(res);
      if (onResult) onResult(res, i, tests.length);
      setTimeout(next, 0);
    };
    next();
  }

  const api = { runAll, defineTests };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (require.main === module) {
      const T = require('./terra.js');
      runAll(T, (r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.detail ? '  (' + r.detail + ')' : '')), (all) => {
        const failed = all.filter((r) => !r.ok).length;
        console.log('\n' + (all.length - failed) + '/' + all.length + ' checks passed');
        process.exitCode = failed ? 1 : 0;
      });
    }
  } else root.TerraTests = api;
})(typeof self !== 'undefined' ? self : this);
