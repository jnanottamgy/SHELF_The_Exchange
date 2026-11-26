/*!
 * Tiny Terra — sound.
 * Everything is synthesised live with the Web Audio API: no audio files,
 * no network. Each planet hums its own chord (picked from its seed), the
 * ocean swell follows the water level, and warmer worlds sound brighter.
 * Audio only starts after the first click or key press (browser rule).
 */
(function (root) {
  'use strict';

  const AC = root.AudioContext || root.webkitAudioContext;
  const STORE_KEY = 'tinyterra-sound';
  const ROOTS = [110, 116.54, 123.47, 130.81, 146.83, 164.81, 174.61, 196]; // A2..G3
  const VOICES = 4;

  let ctx = null, master = null, padBus = null, padFilter = null, oceanGain = null, sfxBus = null;
  let voices = [];
  let enabled = true;
  let started = false;
  let lastTick = 0;
  let pending = { hash: 0, temp: 15, water: 68 };

  try { enabled = localStorage.getItem(STORE_KEY) !== 'off'; } catch (e) { enabled = true; }

  function now() { return ctx ? ctx.currentTime : 0; }

  function build() {
    if (ctx || !AC) return !!ctx;
    try { ctx = new AC(); } catch (e) { ctx = null; return false; }
    master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3;
    master.connect(comp); comp.connect(ctx.destination);

    // Ambient pad: detuned triangle voices through a slowly breathing low-pass.
    padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass'; padFilter.frequency.value = 900; padFilter.Q.value = 0.7;
    padBus = ctx.createGain(); padBus.gain.value = 0.055;
    padFilter.connect(padBus); padBus.connect(master);
    const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07; lfoGain.gain.value = 260;
    lfo.connect(lfoGain); lfoGain.connect(padFilter.frequency); lfo.start();
    for (let i = 0; i < VOICES; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = i === 0 ? 'sine' : 'triangle';
      o.frequency.value = 110;
      o.detune.value = (i - 1.5) * 6;
      g.gain.value = i === 0 ? 0.5 : 0.28;
      o.connect(g); g.connect(padFilter); o.start();
      voices.push(o);
    }

    // Ocean: looping noise through a band-pass, swelling like waves.
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = (seed / 0x7fffffff) * 2 - 1; }
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = 420; band.Q.value = 0.6;
    const swell = ctx.createGain(); swell.gain.value = 0.5;
    const wave = ctx.createOscillator(), waveGain = ctx.createGain();
    wave.frequency.value = 0.11; waveGain.gain.value = 0.45;
    wave.connect(waveGain); waveGain.connect(swell.gain); wave.start();
    oceanGain = ctx.createGain(); oceanGain.gain.value = 0;
    noise.connect(band); band.connect(swell); swell.connect(oceanGain); oceanGain.connect(master);
    noise.start();

    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.5; sfxBus.connect(master);
    applyPlanet(true);
    return true;
  }

  function ramp(param, value, secs) {
    const t = now();
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + secs);
  }

  /** Chord from the seed; colder worlds lean minor, warmer worlds major. */
  function applyPlanet(instant) {
    if (!ctx) return;
    const h = pending.hash >>> 0;
    const base = ROOTS[h % ROOTS.length];
    const third = pending.temp < 5 ? 1.1892 : 1.2599;
    const ratios = [0.5, 1, 1.4983, 2 * third];
    const secs = instant ? 0.05 : 2.2;
    voices.forEach((o, i) => ramp(o.frequency, base * ratios[i], secs));
    applyClimate(instant);
  }

  function applyClimate(instant) {
    if (!ctx) return;
    const t = Math.max(-30, Math.min(50, pending.temp));
    const w = Math.max(0, Math.min(100, pending.water)) / 100;
    ramp(padFilter.frequency, 420 + ((t + 30) / 80) * 1500, instant ? 0.05 : 0.6);
    ramp(oceanGain.gain, 0.012 + w * 0.05, instant ? 0.05 : 0.8);
  }

  // ---------------------------------------------------------------------------
  // Short sound effects
  // ---------------------------------------------------------------------------
  function tone(freq, start, dur, type, vol, endFreq) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    const t = now() + start;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(sfxBus);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function whoosh(dur, from, to, vol) {
    const len = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    const g = ctx.createGain(), t = now();
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(sfxBus);
    src.start(t);
  }

  const SFX = {
    click() { tone(880, 0, 0.07, 'sine', 0.12, 660); },
    toggle() { tone(660, 0, 0.06, 'triangle', 0.1); tone(990, 0.05, 0.08, 'triangle', 0.08); },
    off() { tone(700, 0, 0.06, 'triangle', 0.09); tone(470, 0.05, 0.09, 'triangle', 0.07); },
    tick() { tone(1500, 0, 0.025, 'square', 0.025); },
    dice() { [0, 0.05, 0.1, 0.15].forEach((s, i) => tone(500 + i * 170, s, 0.07, 'triangle', 0.09)); },
    planet() {
      const b = ROOTS[(pending.hash >>> 0) % ROOTS.length] * 2;
      [1, 1.2599, 1.4983, 2].forEach((r, i) => tone(b * r, i * 0.09, 0.9, 'sine', 0.07));
      whoosh(1.1, 300, 2400, 0.05);
    },
    preset() { whoosh(0.9, 2000, 260, 0.08); tone(330, 0.1, 0.5, 'sine', 0.05, 495); },
    view() { tone(520, 0, 0.09, 'sine', 0.1, 780); },
    chime() { tone(1046.5, 0, 0.5, 'sine', 0.09); tone(1568, 0.08, 0.6, 'sine', 0.07); },
    shutter() { whoosh(0.18, 3000, 900, 0.12); tone(1200, 0.12, 0.25, 'sine', 0.06); },
    lapse() { whoosh(1.4, 180, 1600, 0.06); },
    error() { tone(220, 0, 0.18, 'triangle', 0.09, 160); },
  };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function start() {
    if (started || !enabled) return;
    if (!build()) return;
    started = true;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    ramp(master.gain, 0.9, 2.5);
  }

  const api = {
    get supported() { return !!AC; },
    get enabled() { return enabled; },
    get running() { return !!ctx && ctx.state === 'running' && enabled; },
    /** Call from a user gesture; safe to call repeatedly. */
    unlock() { start(); if (ctx && enabled && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
    setEnabled(on) {
      enabled = !!on;
      try { localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off'); } catch (e) { /* private mode */ }
      if (enabled) {
        if (!started) start();
        else { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); ramp(master.gain, 0.9, 0.4); }
      } else if (ctx) {
        ramp(master.gain, 0, 0.25);
      }
      return enabled;
    },
    planet(hash, temp, water) {
      pending.hash = hash >>> 0; pending.temp = temp; pending.water = water;
      applyPlanet(false);
    },
    climate(temp, water) {
      pending.temp = temp; pending.water = water;
      applyClimate(false);
    },
    sfx(name) {
      if (!ctx || !enabled || !started || ctx.state !== 'running' || !SFX[name]) return;
      if (name === 'tick') {
        const t = now();
        if (t - lastTick < 0.06) return;
        lastTick = t;
      }
      try { SFX[name](); } catch (e) { /* never let sound break the app */ }
    },
    pause() { if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); },
    resume() { if (ctx && enabled && started && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
  };

  root.TerraAudio = api;
})(typeof self !== 'undefined' ? self : this);
