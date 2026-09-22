/* ============================================================
   audio.js — capture, analysis, feature extraction
   ------------------------------------------------------------
   Exposes a frame-stable feature set the renderer can trust:
     spectrum[BANDS]  log-spaced, envelope-followed, auto-gained
     wave[WAVE]       time domain, smoothed
     level bass low mid high air centroid  (0..1)
     beat             impulse, decays to 0
   ============================================================ */

export const BANDS = 256;
export const WAVE  = 256;

const FMIN = 28, FMAX = 16500;

export class AudioEngine {
  constructor(){
    this.ctx = null;
    this.kind = 'none';          // none | system | mic | file | ambient
    this.ready = false;
    this.error = null;

    this.spectrum = new Float32Array(BANDS);
    this.wave     = new Float32Array(WAVE);
    this.peaks    = new Float32Array(BANDS);

    this.level = 0; this.bass = 0; this.low = 0; this.mid = 0;
    this.high  = 0; this.air  = 0; this.centroid = 0.35;
    this.beat  = 0; this.beatAt = -1e9; this.beatCount = 0;

    this._bins    = null;
    this._time    = null;
    this._map     = null;
    this._env     = new Float32Array(BANDS);
    this._prevLow = new Float32Array(96);   // previous frame's low bands, for flux
    this._fMean   = 0;                      // running flux baseline
    this._fDev    = 0;                      // running flux deviation
    this._agc     = 0.22;                    // adaptive gain, tracks running loudness
    this._lastBeat= -1e9;
    this._media   = null;                    // <audio> in file mode
    this._stream  = null;
    this._nodes   = [];
    this._ambient = null;
    this._sourceNode = null;
  }

  /* ── lifecycle ───────────────────────────────────────────── */

  _ensureCtx(){
    if(this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new AC({ latencyHint:'interactive' });

    const analyser = this.analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.55;   // we run our own envelopes on top
    analyser.minDecibels = -94;
    analyser.maxDecibels = -14;

    this.input = ctx.createGain();
    this.input.gain.value = 1;
    this.input.connect(analyser);

    this.monitor = ctx.createGain();         // only the sources we must play back
    this.monitor.gain.value = 1;
    this.monitor.connect(ctx.destination);

    this._bins = new Uint8Array(analyser.frequencyBinCount);
    this._time = new Float32Array(analyser.fftSize);
    this._map  = buildBandMap(analyser.frequencyBinCount, ctx.sampleRate, analyser.fftSize);
    return ctx;
  }

  async resume(){
    if(this.ctx && this.ctx.state !== 'running'){ try{ await this.ctx.resume(); }catch{} }
  }

  /** Tear down the current source but keep the graph and analyser alive. */
  stop(){
    if(this._ambient){ this._ambient.stop(); this._ambient = null; }
    if(this._media){ this._media.pause(); this._media.removeAttribute('src'); this._media.load(); }
    if(this._stream){ this._stream.getTracks().forEach(t=>t.stop()); this._stream = null; }
    for(const n of this._nodes){ try{ n.disconnect(); }catch{} }
    this._nodes = []; this._sourceNode = null;
    this.kind = 'none'; this.ready = false;
  }

  _attach(node, { monitor = false } = {}){
    this._sourceNode = node;
    node.connect(this.input);
    if(monitor) node.connect(this.monitor);
    this._nodes.push(node);
  }

  /* ── sources ─────────────────────────────────────────────── */

  async useSystem(){
    if(!navigator.mediaDevices?.getDisplayMedia)
      throw fail('unsupported', 'This browser cannot capture system audio. Try Chrome, Edge or Arc.');

    // Spec requires a video track to be requested; we keep it live but never
    // render it — stopping it would end the whole capture session in Chrome.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video:{ frameRate: 1, width: 2, height: 2 },
      audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false,
              channelCount:2, sampleRate:48000 },
      systemAudio:'include', selfBrowserSurface:'exclude', preferCurrentTab:false
    });

    if(stream.getAudioTracks().length === 0){
      stream.getTracks().forEach(t=>t.stop());
      throw fail('no-audio',
        'No audio came through. Re-pick the source and switch on “Share tab audio” (Chrome only offers it for a Tab or for Entire Screen).');
    }

    this._ensureCtx();
    this.stop();
    this._stream = stream;
    stream.getVideoTracks().forEach(t => { t.enabled = false; });
    stream.getAudioTracks()[0].addEventListener('ended', () => this.onended?.('system'));

    this._attach(this.ctx.createMediaStreamSource(stream));
    this.kind = 'system'; this.ready = true;
    await this.resume();
    return this;
  }

  async useMic(){
    if(!navigator.mediaDevices?.getUserMedia)
      throw fail('unsupported', 'Microphone capture is unavailable in this browser.');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1 }
    });

    this._ensureCtx();
    this.stop();
    this._stream = stream;
    // Never monitored — that would be a feedback loop through the speakers.
    this._attach(this.ctx.createMediaStreamSource(stream));
    this.kind = 'mic'; this.ready = true;
    await this.resume();
    return this;
  }

  async useFile(file){
    this._ensureCtx();

    if(!this._media){
      const el = this._media = new Audio();
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.addEventListener('ended', () => this.onended?.('file'));
      this._mediaNode = this.ctx.createMediaElementSource(el);
    }

    this.stop();
    const url = URL.createObjectURL(file);
    if(this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = url;

    this._media.src = url;
    this._media.loop = this.loopFile !== false;
    this._attach(this._mediaNode, { monitor:true });

    await this._media.play().catch(()=>{});
    this.kind = 'file'; this.ready = true;
    this.trackName = file.name.replace(/\.[^.]+$/, '');
    await this.resume();
    return this;
  }

  async useAmbient(sceneId){
    this._ensureCtx();
    this.stop();
    this._ambient = new Ambient(this.ctx, this.input, this.monitor, sceneId || this.sceneId);
    this._ambient.onhit = v => this.pushBeat(v);
    this._ambient.start();
    this.sceneId = this._ambient.scene.id;
    this.kind = 'ambient'; this.ready = true;
    this.trackName = this._ambient.scene.name;
    await this.resume();
    return this;
  }

  /** Change the generative piece in place, crossfading. */
  setScene(id){
    this.sceneId = id;
    if(this._ambient){
      const s = this._ambient.setScene(id);
      this.trackName = s.name;
      return s;
    }
    return SCENES.find(x => x.id === id) || SCENES[0];
  }
  get scene(){ return this._ambient?.scene || SCENES.find(x => x.id === this.sceneId) || SCENES[0]; }

  /* ── transport ───────────────────────────────────────────── */

  get playing(){
    if(this.kind === 'file')    return this._media && !this._media.paused;
    if(this.kind === 'ambient') return !!this._ambient && this._ambient.running;
    return this.ready;
  }
  get duration(){ return this.kind === 'file' ? (this._media?.duration || 0) : 0; }
  get position(){ return this.kind === 'file' ? (this._media?.currentTime || 0) : 0; }
  set position(t){ if(this.kind === 'file' && this._media) this._media.currentTime = t; }

  toggle(){
    if(this.kind === 'file' && this._media){
      this._media.paused ? this._media.play().catch(()=>{}) : this._media.pause();
    } else if(this.kind === 'ambient' && this._ambient){
      this._ambient.running ? this._ambient.suspend() : this._ambient.resume();
    }
    return this.playing;
  }

  /* ── per-frame analysis ──────────────────────────────────── */

  update(dt){
    // Decay the beat impulse whether or not a source is live.
    this.beat = Math.max(0, this.beat - dt * 3.4);

    if(!this.ready || !this.analyser){ this._decay(dt); return; }

    const an = this.analyser, bins = this._bins, map = this._map;
    an.getByteFrequencyData(bins);
    an.getFloatTimeDomainData(this._time);

    // 1 ─ fold FFT bins into log-spaced bands (peak-biased, so detail survives)
    let sum = 0, wsum = 0, raw = 0;
    const spec = this.spectrum, env = this._env;
    const atk = 1 - Math.exp(-dt / 0.012);   // near-instant attack
    const rel = 1 - Math.exp(-dt / 0.155);   // musical release

    for(let b = 0; b < BANDS; b++){
      const s = map.start[b], e = map.end[b];
      let peak = 0, mean = 0;
      for(let i = s; i < e; i++){ const v = bins[i]; if(v > peak) peak = v; mean += v; }
      const n = Math.max(1, e - s);
      let v = (peak * 0.68 + (mean / n) * 0.32) / 255;

      // Gentle tilt: the ear hears highs as quieter, so lift them for the eye.
      v *= 1 + map.tilt[b];
      raw += v;

      const prev = env[b];
      env[b] = v > prev ? prev + (v - prev) * atk : prev + (v - prev) * rel;

      sum  += env[b] * map.centerNorm[b];
      wsum += env[b];
    }

    // 2 ─ adaptive gain so quiet mixes still fill the frame
    const loud = raw / BANDS;
    const target = Math.max(0.045, loud);
    this._agc += (target - this._agc) * (target > this._agc ? 0.14 : 0.010);
    const gain = clamp(0.34 / Math.max(0.045, this._agc), 0.65, 4.2);

    for(let b = 0; b < BANDS; b++){
      const v = clamp(env[b] * gain, 0, 1.45);
      spec[b] = v;
      this.peaks[b] = Math.max(v, this.peaks[b] - dt * 0.55);
    }

    // 3 ─ macro bands
    this.bass = bandAvg(spec, 0.000, 0.085);
    this.low  = bandAvg(spec, 0.060, 0.220);
    this.mid  = bandAvg(spec, 0.200, 0.480);
    this.high = bandAvg(spec, 0.450, 0.760);
    this.air  = bandAvg(spec, 0.720, 1.000);
    this.centroid += ((wsum > 1e-4 ? sum / wsum : 0.35) - this.centroid) * Math.min(1, dt * 3.0);

    // 4 ─ RMS level from the time domain (honest loudness, not FFT-shaped)
    let acc = 0; const td = this._time;
    for(let i = 0; i < td.length; i += 2) acc += td[i] * td[i];
    const rms = Math.sqrt(acc / (td.length / 2));
    const lvl = clamp(rms * 3.1 * gain * 0.55, 0, 1);
    this.level += (lvl - this.level) * Math.min(1, dt * (lvl > this.level ? 22 : 6));

    // 5 ─ waveform, decimated and softened
    const step = td.length / WAVE;
    for(let i = 0; i < WAVE; i++){
      const j = (i * step) | 0;
      const v = (td[j] + td[Math.min(td.length-1, j + (step>>1)|0)]) * 0.5;
      this.wave[i] += (clamp(v * 2.4, -1, 1) - this.wave[i]) * Math.min(1, dt * 34);
    }

    // 6 ─ onsets. A generative scene reports its own hits exactly, so we
    //     only run detection on audio we did not author.
    if(this.kind !== 'ambient') this._detectBeat(dt);
  }

  /** Onset detection by positive spectral flux across the low end.
      Absolute energy is the wrong signal here: a track with a constant
      sub floor keeps the level high between hits, so the kicks never
      stand out. Flux measures *change*, which is what an onset is.
      The statistics use time constants rather than a frame-count
      window, so detection behaves the same at 30 fps and at 144. */
  _detectBeat(dt){
    const spec = this.spectrum, prev = this._prevLow;
    let flux = 0;
    for(let b = 0; b < 96; b++){
      const d = spec[b] - prev[b];
      if(d > 0) flux += d * (1 - b / 150);      // weight the lowest bands most
      prev[b] = spec[b];
    }
    flux /= 96;

    const kSlow = 1 - Math.exp(-dt / 1.10);
    const kFast = 1 - Math.exp(-dt / 0.42);
    this._fMean += (flux - this._fMean) * kSlow;
    this._fDev  += (Math.abs(flux - this._fMean) - this._fDev) * kFast;

    const thr = this._fMean + this._fDev * 2.0 + 0.0012;
    const now = performance.now() / 1000;

    if(flux > thr && now - this._lastBeat > 0.11){
      const strength = clamp((flux - thr) / Math.max(thr, 1e-4) * 0.55, 0.28, 1.6);
      this.pushBeat(strength);
    }
  }

  /** Register an onset from any source — detected, or handed to us by a
      generative scene that knows exactly when it fired. */
  pushBeat(strength){
    const now = performance.now() / 1000;
    if(now - this._lastBeat < 0.055) return;
    this._lastBeat = now;
    this.beatAt = now;
    this.beatCount++;
    this.beat = Math.max(this.beat, strength);
    this.onbeat?.(strength);
  }

  _decay(dt){
    const k = Math.min(1, dt * 2.2);
    for(let b=0;b<BANDS;b++){ this.spectrum[b] *= 1-k; this.peaks[b] *= 1-k; }
    for(let i=0;i<WAVE;i++)   this.wave[i] *= 1-k;
    this.level *= 1-k; this.bass *= 1-k; this.low *= 1-k;
    this.mid *= 1-k; this.high *= 1-k; this.air *= 1-k;
  }
}

/* ── helpers ───────────────────────────────────────────────── */

function fail(code, msg){ const e = new Error(msg); e.code = code; return e; }
function clamp(v,a,b){ return v<a?a:v>b?b:v; }

function bandAvg(spec, a, b){
  const s = (a * BANDS)|0, e = Math.max(s+1, (b * BANDS)|0);
  let acc = 0; for(let i=s;i<e;i++) acc += spec[i];
  return acc / (e - s);
}

/** Log-spaced FFT-bin → band mapping, plus a perceptual high-frequency tilt. */
function buildBandMap(binCount, sampleRate, fftSize){
  const start = new Int32Array(BANDS), end = new Int32Array(BANDS);
  const tilt  = new Float32Array(BANDS), centerNorm = new Float32Array(BANDS);
  const hzPerBin = sampleRate / fftSize;
  const lmin = Math.log(FMIN), lmax = Math.log(Math.min(FMAX, sampleRate/2 - 1));

  for(let b = 0; b < BANDS; b++){
    const f0 = Math.exp(lmin + (lmax - lmin) * (b       / BANDS));
    const f1 = Math.exp(lmin + (lmax - lmin) * ((b + 1) / BANDS));
    let s = Math.floor(f0 / hzPerBin), e = Math.ceil(f1 / hzPerBin);
    s = clamp(s, 0, binCount - 1);
    e = clamp(Math.max(e, s + 1), 1, binCount);
    start[b] = s; end[b] = e;
    const t = b / (BANDS - 1);
    tilt[b] = 0.55 * Math.pow(t, 1.25);   // +0..55% toward the top octaves
    centerNorm[b] = t;
  }
  return { start, end, tilt, centerNorm };
}

/* ============================================================
   Ambient — generative pieces that never end.
   Each scene is a parameter set over one engine: scale, register,
   tempo, density, timbre and space. Nothing is pre-rendered and
   nothing loops, so it can run for days without repeating.
   ============================================================ */

const SCALES = {
  pentMinor: [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24],
  aeolian:   [0, 2, 3, 5, 7, 8, 10, 12, 14, 15, 17, 19, 20, 22, 24],
  lydian:    [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24],
  dorian:    [0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 17, 19, 21, 22, 24],
  wholeTone: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24],
  // Major-family sets. Consonant thirds and sixths are what make a piece
  // read as settled rather than searching.
  major:     [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24],
  majorPent: [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24],
  ionian9:   [0, 2, 4, 7, 9, 11, 12, 14, 16, 19, 21, 23, 24]
};

/* Solfeggio tunings. There is no physics behind the folklore, but they are
   pleasant roots and they keep these pieces away from concert pitch, which
   is part of why they sit differently in the ear. */
export const HZ = { ut:396, re:417, mi:528, fa:639, sol:741, la:852 };

/* Chord shapes, in semitones. The ninth is what stops a triad sounding
   like a test tone — it is most of the lushness in this kind of music. */
const CHORDS = {
  maj:  [0, 4, 7, 14],
  min:  [0, 3, 7, 14],
  maj7: [0, 4, 7, 11],
  sus:  [0, 5, 7, 14]
};

/* Progressions as [root semitone, quality]. All of these resolve upward;
   that is what makes them read as lift rather than as motion. */
const PROG = {
  lift:    [[0,'maj'], [7,'maj'], [9,'min'], [5,'maj']],   // I  V  vi IV
  anthem:  [[9,'min'], [5,'maj'], [0,'maj'], [7,'maj']],   // vi IV I  V
  open:    [[0,'maj'], [4,'min'], [9,'min'], [5,'maj']],   // I  iii vi IV
  wide:    [[5,'maj'], [0,'maj'], [7,'maj'], [9,'min']]    // IV I  V  vi
};

/* Patterns are one bar of sixteenths. Each character is a velocity,
   '0' or '.' is a rest. Everything else in a scene is counted in the
   same sixteenths, so the whole piece stays on one grid. */

/* ── drum kits, reused across the library ─────────────────── */
const K = {
  four:    { kick:'9...9...9...9...', snare:'....8.......8...', hat:'..5.4.5.4.5.4.5.', open:'..............6.' },
  house:   { kick:'9...9...9...9...', hat:'..5...5...5...5.', open:'......7.......7.' },
  half:    { kick:'9.......9.......', snare:'........9.......', hat:'..5.4.5...5.4.5.' },
  broken:  { kick:'8.....7...8.....', snare:'....9.......9..6', hat:'..4...4.3.4...4.' },
  soft:    { kick:'7...........5...', hat:'..3...3...3...3.', rim:'........4.......' },
  heart:   { kick:'8...............', rim:'........3.......' },
  shuffle: { kick:'6.......6...6...', hat:'..4..4..4..4..4.', rim:'....5.......5...' },
  tick:    { hat:'..4...4...4...4.' },
  deep:    { kick:'9...9...9...9...', rim:'..........4.....', hat:'....3.......3...' },
  trap:    { kick:'9.....9...9.....', snare:'........9.......', hat:'4.4.4.4.4.4.4.4.' },
  march:   { kick:'8...8...8...8...', snare:'..4...4...4...4.' },
  sparse:  { kick:'7.......5.......' }
};

/* Every piece is this template with a handful of fields overridden.
   Spelling out a hundred complete definitions would bury the few
   numbers that actually differ between them. */
const BASE = {
  scale:'majorPent', step:0.125, swing:0, pulseAmp:0.42,
  pluckEvery:4, pluckChance:0.5, pluckOct:12, pluckWave:'sine',
  droneGain:0.09, droneType:'sine', cutoff:600, lfo:0.03, lfoAmt:400,
  noiseGain:0.030, noiseFreq:4000, revSec:4.0, revMix:0.50, swellEvery:64
};
const S = (id, name, blurb, o) => ({ ...BASE, id, name, blurb, ...o });

/* bpm → seconds per sixteenth */
const bpm = n => 60 / n / 4;

export const SCENES = [
  { id:'solace', name:'Solace', blurb:'Warm pad and singing bowls · 528 Hz', calm:true,
    root:HZ.mi/2, scale:'majorPent', step:0.5, swing:0,
    pluckEvery:8, pluckChance:0.3, pluckOct:12, pluckWave:'sine',
    droneGain:0.13, droneType:'sine', cutoff:700, lfo:0.014, lfoAmt:260,
    noiseGain:0.030, noiseFreq:2600, revSec:7.5, revMix:0.72, swellEvery:16,
    bowlEvery:8, bowlChance:0.6, cueEvery:4, breath:5.5 },

  { id:'theta', name:'Theta', blurb:'6 Hz binaural drone · headphones', calm:true,
    root:HZ.ut/2, scale:'majorPent', step:0.6, swing:0,
    pluckEvery:16, pluckChance:0.18, pluckOct:24, pluckWave:'sine',
    droneGain:0.11, droneType:'sine', cutoff:420, lfo:0.011, lfoAmt:160,
    noiseGain:0.042, noiseFreq:1200, revSec:8.0, revMix:0.68, swellEvery:16,
    binaural:6, cueEvery:4, breath:6.0 },

  { id:'meadow', name:'Meadow', blurb:'Bright lydian air, gentle and open', calm:true,
    root:HZ.sol/4, scale:'lydian', step:0.28, swing:0.16,
    pluckEvery:4, pluckChance:0.6, pluckOct:24, pluckWave:'sine',
    droneGain:0.075, droneType:'triangle', cutoff:1100, lfo:0.024, lfoAmt:520,
    noiseGain:0.048, noiseFreq:6400, revSec:5.4, revMix:0.60, swellEvery:16,
    drums:{ kick:'4...............', hat:'....2.......2...' } },

  { id:'bowls', name:'Bowls', blurb:'Struck bowls in a very large room', calm:true,
    root:HZ.fa/4, scale:'majorPent', step:0.75, swing:0,
    pluckEvery:32, pluckChance:0.12, pluckOct:12, pluckWave:'sine',
    droneGain:0.09, droneType:'sine', cutoff:520, lfo:0.009, lfoAmt:180,
    noiseGain:0.022, noiseFreq:2000, revSec:9.0, revMix:0.80, swellEvery:16,
    bowlEvery:4, bowlChance:0.8, cueEvery:3, breath:7.0 },

  { id:'sunrise', name:'Sunrise', blurb:'Major swells that keep opening upward', calm:true,
    root:HZ.la/8, scale:'major', step:0.42, swing:0,
    pluckEvery:6, pluckChance:0.5, pluckOct:24, pluckWave:'triangle',
    droneGain:0.105, droneType:'sawtooth', cutoff:800, lfo:0.020, lfoAmt:620,
    noiseGain:0.038, noiseFreq:4800, revSec:6.4, revMix:0.64, swellEvery:8,
    bowlEvery:32, bowlChance:0.4,
    drums:{ kick:'5.......4.......' } },

  { id:'stillwater', name:'Stillwater', blurb:'Almost nothing, very slowly', calm:true,
    root:HZ.re/4, scale:'ionian9', step:0.9, swing:0,
    pluckEvery:8, pluckChance:0.35, pluckOct:12, pluckWave:'sine',
    droneGain:0.14, droneType:'sine', cutoff:340, lfo:0.008, lfoAmt:140,
    noiseGain:0.050, noiseFreq:900, revSec:9.0, revMix:0.78, swellEvery:8,
    binaural:10, breath:5.5, bowlEvery:8, bowlChance:0.45, cueEvery:3 },

  { id:'uplift', name:'Uplift', blurb:'Supersaw trance, four to the floor',
    root:73.4, scale:'major', step:0.1087, swing:0,
    pluckEvery:16, pluckChance:0, pluckOct:24, pluckWave:'sine',
    droneGain:0.035, droneType:'sawtooth', cutoff:420, lfo:0.07, lfoAmt:400,
    noiseGain:0.016, noiseFreq:7600, revSec:2.8, revMix:0.34, swellEvery:256,
    sub:true, sidechain:0.78,
    prog:'lift', chordEvery:2, chordVoices:7, chordDetune:17, chordLevel:0.055,
    bass:'0.0.0.0.0.0.0.0.', riserEvery:64,
    drums:{ kick:'9...9...9...9...', snare:'....8.......8...',
            hat:'..4...4...4...4.', open:'..7...7...7...7.' } },

  { id:'sunroom', name:'Sunroom', blurb:'Warm deep house, easy and bright',
    root:65.4, scale:'major', step:0.1220, swing:0.10,
    pluckEvery:8, pluckChance:0.45, pluckOct:24, pluckWave:'triangle', pluckDecay:0.5,
    droneGain:0.045, droneType:'triangle', cutoff:520, lfo:0.04, lfoAmt:320,
    noiseGain:0.020, noiseFreq:5600, revSec:3.4, revMix:0.42, swellEvery:128,
    sub:true, sidechain:0.62,
    prog:'wide', chordEvery:4, chordVoices:5, chordDetune:11, chordLevel:0.050,
    bass:'..0...0...0...0.',
    drums:{ kick:'9...9...9...9...', snare:'....7.......7...',
            hat:'..5...5...5...5.', rim:'..........4.....' } },

  { id:'horizon', name:'Horizon', blurb:'Progressive house, long and open',
    root:69.3, scale:'major', step:0.1190, swing:0,
    pluckEvery:4, pluckChance:0.35, pluckOct:24, pluckWave:'sine', pluckDecay:0.7,
    droneGain:0.055, droneType:'sawtooth', cutoff:460, lfo:0.03, lfoAmt:560,
    noiseGain:0.024, noiseFreq:6800, revSec:4.6, revMix:0.50, swellEvery:64,
    sub:true, sidechain:0.70,
    prog:'anthem', chordEvery:8, chordVoices:7, chordDetune:14, chordLevel:0.048,
    bass:'0...0...0...0...', riserEvery:128,
    drums:{ kick:'9...9...9...9...', hat:'..4.5.4...4.5.4.', open:'......7.......7.' } },

  { id:'neon', name:'Neon', blurb:'Future bass, half-time and huge',
    root:87.3, scale:'lydian', step:0.0882, swing:0,
    pluckEvery:16, pluckChance:0.3, pluckOct:24, pluckWave:'triangle', pluckDecay:0.4,
    droneGain:0.030, droneType:'sawtooth', cutoff:600, lfo:0.12, lfoAmt:700,
    noiseGain:0.026, noiseFreq:9000, revSec:3.0, revMix:0.44, swellEvery:128,
    sub:true, sidechain:0.85,
    prog:'open', chordEvery:2, chordVoices:7, chordDetune:26, chordLevel:0.052,
    chordWobble:true, bass:'0.......0.......', riserEvery:64,
    drums:{ kick:'9.......9.......', snare:'........9.......',
            hat:'..5.4.5...5.4.5.', open:'..............7.' } },

  { id:'voltage', name:'Voltage', blurb:'Melodic techno, hypnotic and steady',
    root:61.7, scale:'major', step:0.1154, swing:0,
    pluckEvery:1, pluckChance:1, pluckOct:24, pluckWave:'square', pluckDecay:0.22,
    arp:[0, 4, 7, 11, 7, 4, 2, 4], arpOct:24,
    droneGain:0.050, droneType:'sawtooth', cutoff:380, lfo:0.05, lfoAmt:440,
    noiseGain:0.014, noiseFreq:8200, revSec:2.4, revMix:0.30, swellEvery:128,
    sub:true, sidechain:0.72,
    prog:'lift', chordEvery:16, chordVoices:5, chordDetune:9, chordLevel:0.042,
    bass:'0.0.0.0.0.0.0.0.',
    drums:{ kick:'9...9...9...9...', hat:'..4...4...4...4.', open:'..............6.',
            rim:'....5.......5...' } },

  { id:'drift', name:'Drift', blurb:'Slow pads, soft kick, brushed hats',
    root:110, scale:'pentMinor', step:0.125, swing:0.14,
    pluckEvery:4, pluckChance:0.62, pluckOct:12, pluckWave:'triangle',
    droneGain:0.10, droneType:'sawtooth', cutoff:520, lfo:0.043, lfoAmt:360,
    noiseGain:0.035, noiseFreq:3600, revSec:3.6, revMix:0.42, swellEvery:64,
    drums:{ kick:'7...........5...', hat:'..3...3...3...3.', rim:'........4.......' } },

  { id:'pulse', name:'Pulse', blurb:'Four on the floor, tight and driving',
    root:82.4, scale:'dorian', step:0.1071, swing:0,
    pluckEvery:8, pluckChance:0.5, pluckOct:24, pluckWave:'square',
    droneGain:0.075, droneType:'sawtooth', cutoff:360, lfo:0.09, lfoAmt:420,
    noiseGain:0.022, noiseFreq:6200, revSec:1.9, revMix:0.26, swellEvery:128,
    sub:true,
    drums:{ kick:'9...9...9...9...', snare:'....8.......8...',
            hat:'..5.4.5.4.5.4.5.', open:'..............6.' } },

  { id:'tide', name:'Tide', blurb:'Oceanic, one deep beat a bar',
    root:55, scale:'aeolian', step:0.25, swing:0,
    pluckEvery:8, pluckChance:0.3, pluckOct:12, pluckWave:'sine',
    droneGain:0.15, droneType:'sine', cutoff:300, lfo:0.017, lfoAmt:240,
    noiseGain:0.055, noiseFreq:1400, revSec:6.5, revMix:0.62, swellEvery:32,
    drums:{ kick:'8...............', rim:'........3.......' } },

  { id:'bloom', name:'Bloom', blurb:'Bright bells over a light shuffle',
    root:146.8, scale:'lydian', step:0.09375, swing:0.18,
    pluckEvery:3, pluckChance:0.82, pluckOct:24, pluckWave:'sine',
    droneGain:0.055, droneType:'triangle', cutoff:900, lfo:0.06, lfoAmt:700,
    noiseGain:0.040, noiseFreq:8200, revSec:4.8, revMix:0.55, swellEvery:48,
    drums:{ kick:'6.......6...6...', hat:'..4..4..4..4..4.', rim:'....5.......5...' } },

  { id:'glass', name:'Glass', blurb:'Whole-tone shimmer, brushed pulse',
    root:98, scale:'wholeTone', step:0.15, swing:0.2,
    pluckEvery:4, pluckChance:0.55, pluckOct:24, pluckWave:'triangle',
    droneGain:0.085, droneType:'sine', cutoff:1200, lfo:0.031, lfoAmt:900,
    noiseGain:0.062, noiseFreq:5200, revSec:5.6, revMix:0.68, swellEvery:32,
    drums:{ kick:'6.......5.......', hat:'....3.......3...' } },

  { id:'rain', name:'Rain', blurb:'Granular droplets, distant heartbeat',
    root:65.4, scale:'pentMinor', step:0.125, swing:0,
    pluckEvery:16, pluckChance:0.4, pluckOct:12, pluckWave:'sine',
    droneGain:0.11, droneType:'sine', cutoff:260, lfo:0.023, lfoAmt:180,
    noiseGain:0.030, noiseFreq:2400, revSec:5.2, revMix:0.58, swellEvery:128,
    drops:0.55,
    drums:{ kick:'6.......4.......', rim:'..2...2...2...2.' } },

  { id:'choir', name:'Choir', blurb:'Formant pads over a slow heartbeat',
    root:87.3, scale:'aeolian', step:0.3, swing:0,
    pluckEvery:8, pluckChance:0.35, pluckOct:12, pluckWave:'sine',
    droneGain:0.13, droneType:'sawtooth', cutoff:1600, lfo:0.019, lfoAmt:300,
    noiseGain:0.018, noiseFreq:3000, revSec:6.8, revMix:0.70, swellEvery:32,
    formant:true,
    drums:{ kick:'7.....5.........' } },

  { id:'circuit', name:'Circuit', blurb:'Sixteenth arpeggio, crisp kit',
    root:130.8, scale:'dorian', step:0.1172, swing:0,
    pluckEvery:1, pluckChance:1, pluckOct:12, pluckWave:'square', pluckDecay:0.30,
    droneGain:0.055, droneType:'sawtooth', cutoff:480, lfo:0.11, lfoAmt:520,
    noiseGain:0.016, noiseFreq:7400, revSec:1.6, revMix:0.22, swellEvery:256,
    arp:[0, 2, 4, 6, 4, 2, 7, 4], arpOct:12, sub:true,
    drums:{ kick:'9...9...9..59...', snare:'....9.......9...',
            hat:'6.5.6.5.6.5.6.5.', open:'..........7.....' } },

  { id:'kinetic', name:'Kinetic', blurb:'Crisp club beat, claps and open hats',
    root:98, scale:'dorian', step:0.1210, swing:0.06,
    pluckEvery:4, pluckChance:0.45, pluckOct:24, pluckWave:'square',
    droneGain:0.06, droneType:'sawtooth', cutoff:420, lfo:0.08, lfoAmt:600,
    noiseGain:0.020, noiseFreq:7800, revSec:2.2, revMix:0.28, swellEvery:64,
    sub:true,
    drums:{ kick:'9...9...9...9..7', snare:'....9.......9...',
            hat:'5.6.5.6.5.6.5.6.', open:'......8.......8.',
            rim:'..........3.....' } },

  { id:'lattice', name:'Lattice', blurb:'Syncopated and dubby, wide space',
    root:73.4, scale:'aeolian', step:0.1630, swing:0.22,
    pluckEvery:6, pluckChance:0.5, pluckOct:12, pluckWave:'triangle',
    droneGain:0.095, droneType:'sawtooth', cutoff:330, lfo:0.026, lfoAmt:380,
    noiseGain:0.030, noiseFreq:4200, revSec:5.0, revMix:0.60, swellEvery:64,
    sub:true,
    drums:{ kick:'8.....7...8.....', snare:'....9.......9..6',
            hat:'..4...4.3.4...4.', rim:'.............4..' } },

  /* ═══ the wider library ═══════════════════════════════════
     Twenty-one pieces above were written one at a time. These
     are composed over the same engine from the axes that
     actually change how a piece sounds: mode, register, tempo,
     percussion, and which harmonic engine is driving it.     */

  /* ── Calm ── */
  S('hush','Hush','Barely there, all air', { calm:true, root:HZ.mi/2, step:bpm(52), scale:'majorPent',
    droneGain:0.12, cutoff:420, noiseGain:0.048, noiseFreq:1800, revSec:8, revMix:0.74,
    bowlEvery:8, bowlChance:0.5, cueEvery:4, breath:6.5, pluckChance:0.2 }),
  S('linen','Linen','Soft folds of pad', { calm:true, root:HZ.fa/4, step:bpm(58), scale:'major',
    droneGain:0.13, droneType:'triangle', cutoff:640, revSec:7, revMix:0.68, cueEvery:4, breath:5.5 }),
  S('cove','Cove','Water in a small stone room', { calm:true, root:HZ.re/4, step:bpm(46), scale:'majorPent',
    droneGain:0.11, cutoff:380, noiseGain:0.055, noiseFreq:1100, revSec:8.5, revMix:0.78,
    drops:0.3, cueEvery:4, breath:6 }),
  S('vesper','Vesper','Evening bells, far off', { calm:true, root:HZ.la/8, step:bpm(44), scale:'ionian9',
    droneGain:0.10, revSec:9, revMix:0.80, bowlEvery:6, bowlChance:0.7, cueEvery:3 }),
  S('willow','Willow','Slow and pendulous', { calm:true, root:HZ.ut/2, step:bpm(50), scale:'aeolian',
    droneGain:0.12, cutoff:440, revSec:7.5, revMix:0.70, cueEvery:4, breath:7, pluckChance:0.3 }),
  S('pearl','Pearl','Bright and very quiet', { calm:true, root:HZ.sol/4, step:bpm(62), scale:'lydian',
    droneGain:0.07, droneType:'triangle', cutoff:1100, noiseGain:0.05, noiseFreq:7200,
    revSec:6, revMix:0.64, cueEvery:4, pluckOct:24, pluckChance:0.55 }),
  S('lantern','Lantern','Warm, with a slow pulse', { calm:true, root:HZ.mi/2, step:bpm(54), scale:'major',
    droneGain:0.11, cutoff:560, revSec:6.5, revMix:0.62, drums:K.heart, bowlEvery:16, bowlChance:0.4 }),
  S('fathom','Fathom','Deep, almost subsonic', { calm:true, root:HZ.ut/4, step:bpm(40), scale:'aeolian',
    droneGain:0.16, cutoff:260, noiseGain:0.05, noiseFreq:800, revSec:9, revMix:0.72,
    binaural:4, cueEvery:3, breath:7.5 }),
  S('clearing','Clearing','Open and unhurried', { calm:true, root:HZ.sol/4, step:bpm(56), scale:'major',
    droneGain:0.09, droneType:'triangle', cutoff:840, revSec:6, revMix:0.60, cueEvery:4,
    drums:K.tick, pluckOct:24 }),
  S('harbour','Harbour','A slow swell against stone', { calm:true, root:HZ.re/4, step:bpm(48), scale:'ionian9',
    droneGain:0.13, cutoff:400, noiseGain:0.06, noiseFreq:1000, revSec:8, revMix:0.74,
    cueEvery:4, breath:6, swellEvery:16 }),
  S('quill','Quill','Fine, sparse, high', { calm:true, root:HZ.la/4, step:bpm(60), scale:'lydian',
    droneGain:0.06, cutoff:1300, noiseGain:0.055, noiseFreq:8600, revSec:5.5, revMix:0.66,
    pluckOct:24, pluckChance:0.6, cueEvery:4 }),
  S('moss','Moss','Low, soft, close', { calm:true, root:HZ.ut/2, step:bpm(46), scale:'majorPent',
    droneGain:0.14, cutoff:320, revSec:7, revMix:0.68, cueEvery:4, breath:6.5, pluckChance:0.25 }),
  S('nimbus','Nimbus','A cloud with light behind it', { calm:true, root:HZ.fa/4, step:bpm(52), scale:'lydian',
    droneGain:0.10, droneType:'sawtooth', cutoff:900, noiseGain:0.05, revSec:7, revMix:0.70,
    formant:true, cueEvery:4 }),
  S('cradle','Cradle','A rocking three', { calm:true, root:HZ.mi/2, step:bpm(50), scale:'major',
    droneGain:0.11, cutoff:520, revSec:6.5, revMix:0.64, drums:K.sparse, bowlEvery:12, bowlChance:0.45 }),
  S('fable','Fable','Simple and consonant', { calm:true, root:HZ.sol/4, step:bpm(58), scale:'majorPent',
    droneGain:0.10, cutoff:700, revSec:6, revMix:0.60, pluckChance:0.55, cueEvery:4 }),
  S('orchard','Orchard','Bright plucks over a low bed', { calm:true, root:HZ.la/8, step:bpm(64), scale:'major',
    droneGain:0.09, cutoff:760, revSec:5.5, revMix:0.58, pluckOct:24, pluckChance:0.7,
    drums:K.tick, cueEvery:4 }),
  S('reverie','Reverie','Drifting, no centre', { calm:true, root:HZ.re/4, step:bpm(42), scale:'wholeTone',
    droneGain:0.12, cutoff:600, noiseGain:0.05, revSec:8.5, revMix:0.76, cueEvery:3, breath:7 }),
  S('alcove','Alcove','Small room, long tail', { calm:true, root:HZ.fa/4, step:bpm(54), scale:'aeolian',
    droneGain:0.11, cutoff:480, revSec:9, revMix:0.80, bowlEvery:8, bowlChance:0.6, cueEvery:4 }),
  S('slate','Slate','Grey, even, restful', { calm:true, root:HZ.ut/2, step:bpm(48), scale:'ionian9',
    droneGain:0.13, cutoff:360, revSec:7.5, revMix:0.70, binaural:8, cueEvery:4, breath:5.5 }),
  S('dawnlight','Dawnlight','Slowly getting brighter', { calm:true, root:HZ.la/8, step:bpm(56), scale:'major',
    droneGain:0.10, droneType:'sawtooth', cutoff:820, lfoAmt:700, revSec:6.5, revMix:0.64,
    swellEvery:8, bowlEvery:16, bowlChance:0.5, cueEvery:4 }),

  /* ── Uplifting ── */
  S('ascend','Ascend','Big supersaw, wide open', { root:73.4, scale:'major', step:bpm(138),
    sub:true, sidechain:0.80, prog:'lift', chordEvery:2, chordVoices:7, chordDetune:18,
    chordLevel:0.055, bass:'0.0.0.0.0.0.0.0.', riserEvery:64, drums:K.four,
    droneGain:0.035, droneType:'sawtooth', cutoff:420, revSec:2.8, revMix:0.34, pluckChance:0 }),
  S('lumen','Lumen','Bright house, easy lift', { root:65.4, scale:'major', step:bpm(124),
    sub:true, sidechain:0.66, prog:'wide', chordEvery:4, chordVoices:5, chordDetune:12,
    chordLevel:0.050, bass:'..0...0...0...0.', drums:K.house,
    droneGain:0.045, cutoff:520, revSec:3.4, revMix:0.42, pluckOct:24 }),
  S('skyline','Skyline','Long progressive build', { root:69.3, scale:'major', step:bpm(126),
    sub:true, sidechain:0.72, prog:'anthem', chordEvery:8, chordVoices:7, chordDetune:14,
    chordLevel:0.048, bass:'0...0...0...0...', riserEvery:128, drums:K.house,
    droneGain:0.055, droneType:'sawtooth', cutoff:460, revSec:4.6, revMix:0.50 }),
  S('meridian','Meridian','Steady, wide, patient', { root:61.7, scale:'major', step:bpm(122),
    sub:true, sidechain:0.68, prog:'open', chordEvery:8, chordVoices:5, chordDetune:10,
    chordLevel:0.046, bass:'0...0...0...0...', drums:K.deep,
    droneGain:0.05, cutoff:440, revSec:3.8, revMix:0.44 }),
  S('cascade','Cascade','Falling arpeggio over a pump', { root:82.4, scale:'lydian', step:bpm(128),
    sub:true, sidechain:0.74, prog:'lift', chordEvery:16, chordVoices:5, chordDetune:9,
    chordLevel:0.040, bass:'0.0.0.0.0.0.0.0.', drums:K.four,
    arp:[0,4,7,11,14,11,7,4], arpOct:24, pluckEvery:1, pluckChance:1,
    pluckWave:'square', pluckDecay:0.26, droneGain:0.04, cutoff:480, revSec:2.4, revMix:0.30 }),
  S('vista','Vista','Slow and very wide', { root:58.3, scale:'major', step:bpm(118),
    sub:true, sidechain:0.64, prog:'wide', chordEvery:16, chordVoices:7, chordDetune:16,
    chordLevel:0.050, bass:'0.......0.......', drums:K.sparse,
    droneGain:0.06, cutoff:400, revSec:5.2, revMix:0.56, riserEvery:128 }),
  S('daybreak','Daybreak','Warm, gathering', { root:87.3, scale:'major', step:bpm(120),
    sub:true, sidechain:0.70, prog:'anthem', chordEvery:4, chordVoices:7, chordDetune:13,
    chordLevel:0.048, bass:'..0...0...0...0.', drums:K.house, swellEvery:32,
    droneGain:0.05, droneType:'triangle', cutoff:700, revSec:4.0, revMix:0.48 }),
  S('zenith','Zenith','Fast and euphoric', { root:73.4, scale:'lydian', step:bpm(142),
    sub:true, sidechain:0.82, prog:'lift', chordEvery:2, chordVoices:7, chordDetune:20,
    chordLevel:0.054, bass:'0.0.0.0.0.0.0.0.', riserEvery:64, drums:K.four,
    droneGain:0.03, droneType:'sawtooth', cutoff:440, revSec:2.6, revMix:0.32, pluckChance:0 }),
  S('parallel','Parallel','Tight, mechanical lift', { root:65.4, scale:'dorian', step:bpm(130),
    sub:true, sidechain:0.76, prog:'open', chordEvery:8, chordVoices:5, chordDetune:8,
    chordLevel:0.042, bass:'0.0.0.0.0.0.0.0.', drums:K.deep,
    arp:[0,3,7,10,7,3], arpOct:24, pluckEvery:1, pluckChance:1, pluckWave:'square',
    pluckDecay:0.20, droneGain:0.045, cutoff:400, revSec:2.2, revMix:0.26 }),
  S('flux','Flux','Half-time, heavy chords', { root:87.3, scale:'lydian', step:bpm(150),
    sub:true, sidechain:0.86, prog:'open', chordEvery:2, chordVoices:7, chordDetune:28,
    chordWobble:true, chordLevel:0.052, bass:'0.......0.......', riserEvery:64, drums:K.half,
    droneGain:0.03, droneType:'sawtooth', cutoff:600, revSec:3.0, revMix:0.44 }),
  S('radiant','Radiant','High and shimmering', { root:98, scale:'major', step:bpm(132),
    sub:true, sidechain:0.72, prog:'lift', chordEvery:4, chordVoices:7, chordDetune:15,
    chordLevel:0.046, bass:'0...0...0...0...', drums:K.four, noiseGain:0.03, noiseFreq:9000,
    droneGain:0.035, cutoff:800, revSec:3.6, revMix:0.46, pluckOct:24 }),
  S('alloy','Alloy','Metallic and driving', { root:61.7, scale:'dorian', step:bpm(134),
    sub:true, sidechain:0.78, prog:'anthem', chordEvery:8, chordVoices:5, chordDetune:7,
    chordLevel:0.040, bass:'0.0.0.0.0.0.0.0.', drums:K.four,
    droneGain:0.05, droneType:'sawtooth', cutoff:380, revSec:2.0, revMix:0.24 }),
  S('prism','Prism','Bright, splitting into colours', { root:92.5, scale:'lydian', step:bpm(126),
    sub:true, sidechain:0.70, prog:'wide', chordEvery:4, chordVoices:7, chordDetune:22,
    chordLevel:0.048, bass:'..0...0...0...0.', drums:K.house,
    droneGain:0.04, cutoff:900, revSec:4.2, revMix:0.50, noiseGain:0.028, noiseFreq:8000 }),
  S('momentum','Momentum','Forward, never resting', { root:69.3, scale:'major', step:bpm(136),
    sub:true, sidechain:0.76, prog:'lift', chordEvery:4, chordVoices:5, chordDetune:11,
    chordLevel:0.044, bass:'0.0.0.0.0.0.0.0.', drums:K.four, riserEvery:64,
    droneGain:0.04, cutoff:460, revSec:2.6, revMix:0.30 }),
  S('overture','Overture','Grand and slow to arrive', { root:55, scale:'major', step:bpm(112),
    sub:true, sidechain:0.60, prog:'anthem', chordEvery:16, chordVoices:7, chordDetune:15,
    chordLevel:0.052, bass:'0.......0.......', drums:K.march, swellEvery:16,
    droneGain:0.07, droneType:'sawtooth', cutoff:420, revSec:5.6, revMix:0.60, riserEvery:128 }),
  S('kite','Kite','Light, lifting, airy', { root:104, scale:'lydian', step:bpm(124),
    sidechain:0.58, prog:'wide', chordEvery:8, chordVoices:5, chordDetune:14,
    chordLevel:0.042, bass:'..0...0...0...0.', drums:K.shuffle, swing:0.14,
    droneGain:0.035, droneType:'triangle', cutoff:1000, revSec:4.4, revMix:0.54, pluckOct:24 }),
  S('sable','Sable','Dark but rising', { root:58.3, scale:'aeolian', step:bpm(128),
    sub:true, sidechain:0.74, prog:'anthem', chordEvery:8, chordVoices:7, chordDetune:12,
    chordLevel:0.046, bass:'0...0...0...0...', drums:K.deep,
    droneGain:0.055, droneType:'sawtooth', cutoff:360, revSec:3.4, revMix:0.40 }),
  S('signalfire','Signal Fire','Insistent and bright', { root:77.8, scale:'major', step:bpm(140),
    sub:true, sidechain:0.80, prog:'lift', chordEvery:2, chordVoices:7, chordDetune:17,
    chordLevel:0.050, bass:'0.0.0.0.0.0.0.0.', drums:K.four, riserEvery:64,
    droneGain:0.03, cutoff:500, revSec:2.4, revMix:0.30, pluckChance:0 }),

  /* ── Rhythmic ── */
  S('gridline','Gridline','Strict and square', { root:65.4, scale:'dorian', step:bpm(128),
    sub:true, drums:K.four, droneGain:0.06, droneType:'sawtooth', cutoff:400, revSec:2.0, revMix:0.26,
    pluckOct:24, pluckWave:'square', pluckDecay:0.3 }),
  S('basalt','Basalt','Heavy and low', { root:49, scale:'aeolian', step:bpm(120),
    sub:true, drums:K.deep, droneGain:0.11, cutoff:300, revSec:3.0, revMix:0.34, pluckChance:0.3 }),
  S('tessera','Tessera','Interlocking pattern', { root:73.4, scale:'dorian', step:bpm(132),
    drums:K.broken, swing:0.12, droneGain:0.07, cutoff:480, revSec:3.2, revMix:0.40, pluckOct:24 }),
  S('cadence','Cadence','A steady walking pulse', { root:61.7, scale:'major', step:bpm(108),
    drums:K.march, droneGain:0.08, droneType:'triangle', cutoff:620, revSec:3.6, revMix:0.44 }),
  S('marrow','Marrow','Sparse and deep', { root:55, scale:'aeolian', step:bpm(96),
    sub:true, drums:K.sparse, droneGain:0.12, cutoff:320, revSec:4.4, revMix:0.50, pluckChance:0.35 }),
  S('cobalt','Cobalt','Cool and even', { root:69.3, scale:'dorian', step:bpm(124),
    drums:K.house, droneGain:0.07, cutoff:520, revSec:2.8, revMix:0.36, pluckOct:24, pluckChance:0.55 }),
  S('anvil','Anvil','Hard-hitting and plain', { root:58.3, scale:'aeolian', step:bpm(130),
    sub:true, drums:K.four, droneGain:0.08, droneType:'sawtooth', cutoff:340, revSec:1.8, revMix:0.22 }),
  S('relay','Relay','Passing figures back and forth', { root:82.4, scale:'dorian', step:bpm(126),
    drums:K.broken, arp:[0,3,7,10,12,10,7,3], arpOct:12, pluckEvery:2, pluckChance:1,
    pluckWave:'triangle', pluckDecay:0.4, droneGain:0.06, cutoff:560, revSec:3.0, revMix:0.38 }),
  S('ticker','Ticker','All hats, almost no body', { root:98, scale:'wholeTone', step:bpm(140),
    drums:K.trap, droneGain:0.04, cutoff:700, revSec:2.2, revMix:0.30, pluckOct:24, pluckChance:0.4 }),
  S('foundry','Foundry','Industrial and repetitive', { root:51.9, scale:'aeolian', step:bpm(122),
    sub:true, drums:K.deep, droneGain:0.10, droneType:'sawtooth', cutoff:300, lfo:0.08,
    revSec:2.6, revMix:0.30, pluckWave:'square', pluckDecay:0.25 }),
  S('slipstream','Slipstream','Fast and frictionless', { root:87.3, scale:'lydian', step:bpm(144),
    drums:K.house, droneGain:0.05, cutoff:760, revSec:2.4, revMix:0.34, pluckOct:24,
    arp:[0,2,4,7,9,7,4,2], arpOct:24, pluckEvery:1, pluckChance:1, pluckDecay:0.22 }),
  S('carbon','Carbon','Dry and tight', { root:65.4, scale:'dorian', step:bpm(134),
    sub:true, drums:K.four, droneGain:0.06, cutoff:380, revSec:1.6, revMix:0.20, noiseGain:0.012 }),
  S('vault','Vault','Huge room, slow hits', { root:46.2, scale:'aeolian', step:bpm(88),
    sub:true, drums:K.heart, droneGain:0.13, cutoff:280, revSec:6.5, revMix:0.62, pluckChance:0.3 }),
  S('pivot','Pivot','Syncopated and light', { root:77.8, scale:'dorian', step:bpm(118),
    drums:K.shuffle, swing:0.2, droneGain:0.06, droneType:'triangle', cutoff:640,
    revSec:3.4, revMix:0.42, pluckOct:24 }),
  S('ratchet','Ratchet','Stuttering and mechanical', { root:61.7, scale:'wholeTone', step:bpm(136),
    sub:true, drums:K.trap, droneGain:0.05, droneType:'sawtooth', cutoff:420, lfo:0.13,
    revSec:2.0, revMix:0.24, pluckWave:'square', pluckDecay:0.18 }),
  S('loom','Loom','Woven, patient', { root:69.3, scale:'dorian', step:bpm(104),
    drums:K.soft, swing:0.16, droneGain:0.09, cutoff:540, revSec:4.0, revMix:0.48,
    pluckChance:0.6, pluckOct:24 }),
  S('quarry','Quarry','Blunt and spacious', { root:55, scale:'aeolian', step:bpm(100),
    sub:true, drums:K.march, droneGain:0.11, cutoff:340, revSec:4.8, revMix:0.52 }),
  S('conduit','Conduit','Relentless sixteenths', { root:73.4, scale:'dorian', step:bpm(138),
    sub:true, drums:K.four, arp:[0,3,5,7,10,7,5,3], arpOct:12, pluckEvery:1, pluckChance:1,
    pluckWave:'square', pluckDecay:0.2, droneGain:0.05, cutoff:400, revSec:1.8, revMix:0.22 }),
  S('pendulum','Pendulum','Swinging, unhurried', { root:58.3, scale:'major', step:bpm(92),
    drums:K.shuffle, swing:0.24, droneGain:0.09, droneType:'triangle', cutoff:580,
    revSec:4.2, revMix:0.50, pluckChance:0.5 }),
  S('beacon','Beacon','Steady, with a wide tail', { root:82.4, scale:'major', step:bpm(114),
    drums:K.house, droneGain:0.07, cutoff:660, revSec:4.6, revMix:0.54, swellEvery:32, pluckOct:24 }),

  /* ── Texture ── */
  S('static','Static','Filtered noise, almost music', { root:55, scale:'wholeTone', step:bpm(70),
    droneGain:0.06, cutoff:400, noiseGain:0.09, noiseFreq:3200, revSec:5.0, revMix:0.56,
    drops:0.4, pluckChance:0.2, cueEvery:4, calm:true }),
  S('pollen','Pollen','Countless small events', { root:98, scale:'lydian', step:bpm(96),
    droneGain:0.05, cutoff:900, noiseGain:0.04, noiseFreq:7000, revSec:4.6, revMix:0.56,
    drops:0.8, pluckOct:24, pluckChance:0.3, calm:true, cueEvery:4 }),
  S('sediment','Sediment','Settling slowly', { root:49, scale:'aeolian', step:bpm(58),
    droneGain:0.13, cutoff:280, noiseGain:0.06, noiseFreq:1400, revSec:7.5, revMix:0.68,
    drops:0.45, calm:true, cueEvery:3, breath:7 }),
  S('frost','Frost','Crystalline and thin', { root:HZ.la/4, scale:'wholeTone', step:bpm(76),
    droneGain:0.05, cutoff:1200, noiseGain:0.07, noiseFreq:9500, revSec:6.0, revMix:0.66,
    drops:0.5, pluckOct:24, calm:true, cueEvery:4 }),
  S('ash','Ash','Grey and falling', { root:51.9, scale:'aeolian', step:bpm(64),
    droneGain:0.11, cutoff:340, noiseGain:0.075, noiseFreq:2200, revSec:7.0, revMix:0.64,
    drops:0.6, calm:true, cueEvery:4 }),
  S('filament','Filament','A thin bright thread', { root:HZ.sol/2, scale:'lydian', step:bpm(84),
    droneGain:0.045, cutoff:1400, noiseGain:0.05, noiseFreq:11000, revSec:5.4, revMix:0.60,
    pluckOct:24, pluckChance:0.5, calm:true, cueEvery:4 }),
  S('grain','Grain','Coarse and close', { root:65.4, scale:'dorian', step:bpm(88),
    droneGain:0.08, cutoff:520, noiseGain:0.085, noiseFreq:4200, revSec:4.0, revMix:0.48, drops:0.7 }),
  S('vapour','Vapour','Formless, drifting', { root:HZ.re/2, scale:'wholeTone', step:bpm(54),
    droneGain:0.10, droneType:'sawtooth', cutoff:700, noiseGain:0.065, revSec:8.0, revMix:0.74,
    formant:true, calm:true, cueEvery:3, breath:6.5 }),
  S('cinder','Cinder','Warm embers, occasional sparks', { root:58.3, scale:'aeolian', step:bpm(72),
    droneGain:0.10, cutoff:420, noiseGain:0.05, noiseFreq:3000, revSec:5.5, revMix:0.58,
    drops:0.35, drums:K.heart, calm:true }),
  S('spindrift','Spindrift','Spray off the top of a wave', { root:HZ.fa/2, scale:'majorPent', step:bpm(80),
    droneGain:0.07, cutoff:800, noiseGain:0.08, noiseFreq:6400, revSec:6.5, revMix:0.68,
    drops:0.55, calm:true, cueEvery:4, breath:5.5 }),
  S('lichen','Lichen','Slow spreading texture', { root:46.2, scale:'aeolian', step:bpm(50),
    droneGain:0.14, cutoff:250, noiseGain:0.055, noiseFreq:1600, revSec:8.5, revMix:0.72,
    binaural:5, calm:true, cueEvery:3, breath:7.5 }),
  S('silt','Silt','Fine particles in still water', { root:HZ.ut/2, scale:'majorPent', step:bpm(60),
    droneGain:0.12, cutoff:360, noiseGain:0.07, noiseFreq:1900, revSec:7.5, revMix:0.70,
    drops:0.5, calm:true, cueEvery:4, breath:6 }),

  /* ── Drone ── */
  S('monolith','Monolith','One chord, held', { root:43.7, scale:'aeolian', step:bpm(40),
    droneGain:0.18, cutoff:240, revSec:9.0, revMix:0.74, pluckChance:0.1, calm:true, cueEvery:4 }),
  S('undertow','Undertow','Pulling downward', { root:41.2, scale:'aeolian', step:bpm(38),
    droneGain:0.17, cutoff:220, noiseGain:0.05, revSec:9.0, revMix:0.78, binaural:4,
    calm:true, cueEvery:3, breath:8 }),
  S('bedrock','Bedrock','Immovable', { root:38.9, scale:'majorPent', step:bpm(36),
    droneGain:0.19, cutoff:200, revSec:8.5, revMix:0.70, pluckChance:0.08, calm:true, cueEvery:4 }),
  S('longwave','Long Wave','A very slow rise and fall', { root:46.2, scale:'ionian9', step:bpm(42),
    droneGain:0.16, cutoff:280, revSec:9.0, revMix:0.76, swellEvery:8, calm:true,
    cueEvery:4, breath:8 }),
  S('keel','Keel','Steady under everything', { root:49, scale:'majorPent', step:bpm(44),
    droneGain:0.15, cutoff:300, revSec:8.0, revMix:0.72, binaural:7, calm:true, cueEvery:4 }),
  S('mantle','Mantle','Warm and enormous', { root:HZ.ut/4, scale:'major', step:bpm(40),
    droneGain:0.17, droneType:'triangle', cutoff:260, revSec:9.0, revMix:0.78,
    calm:true, cueEvery:4, breath:7 }),
  S('hollow','Hollow','Empty and resonant', { root:51.9, scale:'wholeTone', step:bpm(46),
    droneGain:0.14, cutoff:340, noiseGain:0.05, revSec:9.0, revMix:0.80, formant:true,
    calm:true, cueEvery:4 }),
  S('tectonic','Tectonic','Vast and barely moving', { root:36.7, scale:'aeolian', step:bpm(34),
    droneGain:0.20, cutoff:180, revSec:9.0, revMix:0.74, binaural:3, calm:true,
    cueEvery:3, breath:8 }),
  S('abyssal','Abyssal','As low as it goes', { root:32.7, scale:'majorPent', step:bpm(32),
    droneGain:0.20, cutoff:170, noiseGain:0.045, revSec:9.0, revMix:0.78,
    calm:true, cueEvery:3, breath:8 })
];

/* A sequencer clock that a throttled page cannot starve.
   ------------------------------------------------------------
   `setInterval` on the main thread is clamped hard once the page is
   hidden — on a phone with the screen off it can drop to roughly once
   a second, or worse. A look-ahead scheduler fed that slowly schedules
   notes into the past and the music stutters. A worker's timer is
   throttled far less, and it is not competing with rendering, so the
   ticks keep arriving. Falls back to setInterval where a worker cannot
   be created. */
function makeClock(onTick){
  const src = `let id = null;
    onmessage = e => {
      clearInterval(id); id = null;
      if(e.data && e.data.ms) id = setInterval(() => postMessage(0), e.data.ms);
    };`;
  try{
    const url = URL.createObjectURL(new Blob([src], { type:'application/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = () => onTick();
    /* stop() only pauses. Terminating here would be a trap: restart()
       stops the clock and then starts it again on every change of piece,
       and a terminated worker can never tick again — the music would die
       the first time you picked a different one. */
    return {
      set(ms){ try{ w.postMessage({ ms }); }catch{} },
      stop(){ try{ w.postMessage({}); }catch{} },
      dispose(){ try{ w.postMessage({}); w.terminate(); }catch{} }
    };
  }catch{
    let id = 0;
    return {
      set(ms){ clearInterval(id); id = setInterval(onTick, ms); },
      stop(){ clearInterval(id); id = 0; },
      dispose(){ clearInterval(id); id = 0; }
    };
  }
}

class Ambient {
  constructor(ctx, analyseInto, monitor, sceneId){
    this.ctx = ctx; this.running = false;
    this.setScene(sceneId, true);

    this.out = ctx.createGain();
    this.out.gain.value = 0.0001;

    /* A limiter on the way out. The busier pieces stack a kick, a sub, a
       supersaw chord and a hat on the same beat, and the sum clips well
       before any one of them is too loud. Catching the peaks here is
       cheaper than keeping every part quiet enough to never collide. */
    const comp = this.comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -9;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;

    this.out.connect(comp);
    comp.connect(analyseInto);
    comp.connect(monitor);

    this.dry = ctx.createGain(); this.dry.gain.value = 0.72;
    this.dry.connect(this.out);

    /* Sidechain bus. Everything harmonic runs through this and the kick
       ducks it — the pump is most of what makes this kind of music feel
       like it is moving, and it is doing real work here rather than being
       an effect painted on top: without it the sub and the kick fight for
       the same space and both lose. Drums bypass it. */
    this.duck = ctx.createGain(); this.duck.gain.value = 1;
    this.duck.connect(this.dry);

    this.rev = ctx.createConvolver();
    this.revGain = ctx.createGain();
    this.rev.connect(this.revGain); this.revGain.connect(this.out);
    this.revIn = this.rev;

    this.voices = [];
    this._step = 0; this._arp = 0; this._bar = 0;
    this._tick = this._tick.bind(this);
    this._clock = makeClock(this._tick);
    /* Ticking slowly while hidden is fine as long as we schedule far
       enough ahead to cover the gap — and it saves waking the phone up
       twenty-five times a second for nothing. */
    this._retune = () => {
      if(this.running) this._clock.set(document.hidden ? 400 : 40);
    };
    document.addEventListener('visibilitychange', this._retune);
  }

  setScene(id, silent){
    const s = SCENES.find(x => x.id === id) || SCENES[0];
    this.scene = s;
    this.scaleNotes = SCALES[s.scale];
    if(!silent) this.restart();
    return s;
  }

  /** Swap scenes without a gap: fade out, rebuild, fade back in. */
  restart(){
    const ctx = this.ctx, t = ctx.currentTime;
    const wasRunning = this.running;
    this.running = false; this._clock.stop();
    ramp(this.out.gain, 0.0001, t, 0.6);
    setTimeout(() => {
      this._teardownVoices();
      if(wasRunning) this.start();
    }, 680);
  }

  _teardownVoices(){
    for(const v of this.voices){ try{ v.stop?.(); }catch{} try{ v.disconnect(); }catch{} }
    this.voices = [];
  }

  start(){
    const ctx = this.ctx, s = this.scene, t = ctx.currentTime;
    try{ this.duck.gain.cancelScheduledValues(t); this.duck.gain.setValueAtTime(1, t); }catch{}
    this.rev.buffer = impulse(ctx, s.revSec, 2.4);
    this.revGain.gain.value = s.revMix;

    // ── drone: detuned oscillators through a breathing lowpass
    const bus = ctx.createGain(); bus.gain.value = s.droneGain;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = s.cutoff; lp.Q.value = 3.2;

    const lfo = ctx.createOscillator(); lfo.frequency.value = s.lfo;
    const lfoAmp = ctx.createGain(); lfoAmp.gain.value = s.lfoAmt;
    lfo.connect(lfoAmp); lfoAmp.connect(lp.frequency); lfo.start(t);

    [0, 0.08, -0.06, 12.02].forEach((cents, i) => {
      const o = ctx.createOscillator();
      o.type = i === 3 ? 'sine' : s.droneType;
      o.frequency.value = s.root * Math.pow(2, cents / 12);
      const g = ctx.createGain(); g.gain.value = i === 3 ? 0.22 : 0.16;
      o.connect(g); g.connect(lp); o.start(t);
      this.voices.push(o, g);
    });
    if(s.formant){
      // Three parallel resonant peaks approximate a sung vowel; drifting
      // them slowly makes the pad read as a voice rather than a synth.
      [[620, 8, 1.0], [1180, 10, 0.62], [2600, 12, 0.28]].forEach(([f, q, g], i) => {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
        const fg = ctx.createGain(); fg.gain.value = g * 1.6;
        const fl = ctx.createOscillator(); fl.frequency.value = 0.021 + i * 0.013;
        const fa = ctx.createGain(); fa.gain.value = f * 0.22;
        fl.connect(fa); fa.connect(bp.frequency); fl.start(t);
        lp.connect(bp); bp.connect(fg); fg.connect(bus);
        this.voices.push(bp, fg, fl, fa);
      });
    }

    const harmonic = s.sidechain ? this.duck : this.dry;
    lp.connect(bus); bus.connect(harmonic); bus.connect(this.revIn);
    this.voices.push(lfo, lfoAmp, lp, bus);

    if(s.binaural && ctx.createStereoPanner){
      // Two pure tones a few hertz apart, one to each ear. The beat is
      // perceived rather than present in either channel, so it only works
      // on headphones — the blurb says so.
      [[-1, 0], [1, s.binaural]].forEach(([pan, offset]) => {
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.value = s.root * 2 + offset;
        const g = ctx.createGain(); g.gain.value = 0.085;
        const p = ctx.createStereoPanner(); p.pan.value = pan;
        o.connect(g); g.connect(p); p.connect(this.dry);
        o.start(t);
        this.voices.push(o, g, p);
      });
    }

    if(s.breath){
      // A swell paced to slow breathing. Nothing here is doing anything
      // clever — it is simply something steady to fall in step with.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 1 / s.breath;
      // Keep the swing off zero: a negative gain would flip phase.
      const depth = ctx.createGain(); depth.gain.value = 0.34;
      const bed = ctx.createGain(); bed.gain.value = 0.40;
      lfo.connect(depth); depth.connect(bed.gain);
      lfo.start(t);
      bus.connect(bed); bed.connect(this.revIn);
      this.voices.push(lfo, depth, bed);
    }

    if(s.sub){
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.value = s.root / 2;
      const g = ctx.createGain(); g.gain.value = 0.09;
      o.connect(g); g.connect(s.sidechain ? this.duck : this.dry); o.start(t);
      this.voices.push(o, g);
    }

    // ── shimmer: filtered noise sweeping the top octaves
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 6); noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = s.noiseFreq; bp.Q.value = 1.1;
    const nl = ctx.createOscillator(); nl.frequency.value = s.lfo * 0.7;
    const nlg = ctx.createGain(); nlg.gain.value = s.noiseFreq * 0.6;
    nl.connect(nlg); nlg.connect(bp.frequency); nl.start(t);
    const ng = ctx.createGain(); ng.gain.value = s.noiseGain;
    noise.connect(bp); bp.connect(ng); ng.connect(this.dry); ng.connect(this.revIn);
    noise.start(t);
    this.voices.push(noise, bp, nl, nlg, ng);

    ramp(this.out.gain, 0.9, t, 3.2);

    this.running = true;
    this._next = ctx.currentTime + 0.25;
    this._clock.set(document.hidden ? 400 : 40);
    this._tick();
  }

  /** Look-ahead scheduler, so musical timing stays sample-accurate
      no matter how the page's timers drift over a long run. */
  _tick(){
    if(!this.running) return;
    const ctx = this.ctx, s = this.scene;

    /* How far ahead to commit. Short while visible, so a change of piece
       takes effect straight away; long while hidden, because the clock
       may only get to run once every second or two and everything
       between now and the next tick has to already be scheduled. */
    const hidden = typeof document !== 'undefined' && document.hidden;
    const horizon = ctx.currentTime + (hidden ? 3.0 : 0.30);
    let guard = 0;
    while(this._next < horizon && guard++ < 400){
      /* If we fell behind anyway, re-enter on a bar line rather than
         wherever the clock happens to be. Jumping to `now` lands
         mid-pattern and is audible as a lurch; this stays in phase. */
      if(this._next < ctx.currentTime - 0.25){
        const bar = s.step * 16;
        const behind = (ctx.currentTime + 0.06) - this._next;
        const bars = Math.ceil(behind / bar);
        this._next += bars * bar;
        this._step += bars * 16;
      }
      const n = this._step, t = this._next;

      this.drums(n, t);
      if(!s.drums){
        if(s.calm){
          // No thump — just a cue often enough that the field keeps
          // breathing. Eight seconds apart and it reads as frozen.
          if(n % (s.cueEvery ?? 4) === 0) this._report(t, 0.24 + Math.random() * 0.14);
        } else if(n % 16 === 0){
          this.pulse(t, 1);
        }
      }

      if(n % (s.pluckEvery || 4) === 0){
        if(s.arp){
          // A running sequence rather than scattered notes, with an
          // occasional octave lift so it never settles into a pattern.
          const deg  = s.arp[this._arp % s.arp.length];
          const lift = (this._arp % (s.arp.length * 4) >= s.arp.length * 3) ? 12 : 0;
          this.pluck(t, deg, s.arpOct + lift);
          this._arp++;
        } else if(Math.random() < s.pluckChance){
          this.pluck(t);
        }
      }

      if(n % 16 === 0) this._bar = (n / 16) | 0;

      if(s.prog){
        const [rootSemi, quality] = this._chord();
        if(n % (s.chordEvery ?? 4) === 0) this.stab(t, rootSemi, quality);
        if(s.bass){
          const i = n % 16;
          if(i < s.bass.length && s.bass[i] !== '.') this.bassNote(t, rootSemi);
        }
        if(s.riserEvery && n % s.riserEvery === s.riserEvery - 16) this.riser(t, 1);
      }

      if(s.bowlEvery && n % s.bowlEvery === 0 && Math.random() < (s.bowlChance ?? 0.5)){
        const sc = this.scaleNotes;
        const semi = sc[(Math.random() * Math.min(5, sc.length)) | 0];
        this.bowl(t, s.root * 2 * Math.pow(2, semi / 12), 0.8 + Math.random() * 0.5);
      }

      if(s.drops && Math.random() < s.drops) this.drop(t);
      if(n % s.swellEvery === (s.swellEvery >> 1)) this.swell(t);

      this._next += s.step; this._step++;
    }
  }

  _noise(){
    return this._nb || (this._nb = noiseBuffer(this.ctx, 1.2));
  }

  /** Hits are scheduled ahead on the audio clock; this lands the visual
      cue at the same moment the sound actually reaches the speakers. */
  _report(when, strength){
    if(!this.onhit) return;
    const delay = (when - this.ctx.currentTime) * 1000;
    if(delay < -60) return;
    setTimeout(() => { if(this.running) this.onhit(strength); }, Math.max(0, delay));
  }

  /** One bar position: fire whatever the patterns ask for. */
  drums(n, t){
    const d = this.scene.drums;
    if(!d) return;
    const i = n % 16;
    const hit = pat => {
      if(!pat || i >= pat.length) return 0;
      const c = pat.charCodeAt(i) - 48;
      return c >= 1 && c <= 9 ? c / 9 : 0;
    };
    // Push the off-beats late for a human feel.
    const sw = (i % 2 === 1) ? (this.scene.swing || 0) * this.scene.step : 0;
    let v;
    if((v = hit(d.kick))){
      this.kick(t, v);
      if(this.scene.sidechain) this.duckAt(t, this.scene.sidechain * v);
      this._report(t, v);
    }
    if((v = hit(d.snare))){
      this.snare(t + sw * 0.4, v);
      this._report(t + sw * 0.4, v * 0.55);
    }
    if((v = hit(d.hat)))   this.hat(t + sw, v, false);
    if((v = hit(d.open)))  this.hat(t + sw, v, true);
    if((v = hit(d.rim)))   this.rim(t + sw, v);
  }

  /** Sine body with a pitch drop, plus a filtered click. The click is
      what makes it read as crisp rather than as a soft thud. */
  kick(t, v){
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(148, t);
    o.frequency.exponentialRampToValueAtTime(43, t + 0.075);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.82 * v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g); g.connect(this.dry);
    o.start(t); o.stop(t + 0.4);
    o.onended = () => { try{ o.disconnect(); g.disconnect(); }catch{} };

    const n = ctx.createBufferSource(); n.buffer = this._noise();
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1700;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.20 * v, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.016);
    n.connect(hp); hp.connect(ng); ng.connect(this.dry);
    n.start(t); n.stop(t + 0.05);
    n.onended = () => { try{ n.disconnect(); hp.disconnect(); ng.disconnect(); }catch{} };
  }

  snare(t, v){
    const ctx = this.ctx;
    const n = ctx.createBufferSource(); n.buffer = this._noise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1950; bp.Q.value = 0.85;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.34 * v, t + 0.003);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.155);
    n.connect(bp); bp.connect(ng); ng.connect(this.dry); ng.connect(this.revIn);
    n.start(t); n.stop(t + 0.2);
    n.onended = () => { try{ n.disconnect(); bp.disconnect(); ng.disconnect(); }catch{} };

    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(240, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g); g.connect(this.dry);
    o.start(t); o.stop(t + 0.14);
    o.onended = () => { try{ o.disconnect(); g.disconnect(); }catch{} };
  }

  hat(t, v, open){
    const ctx = this.ctx;
    const n = ctx.createBufferSource(); n.buffer = this._noise();
    n.playbackRate.value = 1.4 + Math.random() * 0.3;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7200;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 9800; bp.Q.value = 1.3;
    const g = ctx.createGain();
    const dur = open ? 0.26 : 0.040;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.17 * v, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(hp); hp.connect(bp); bp.connect(g);
    g.connect(this.dry); if(open) g.connect(this.revIn);
    n.start(t); n.stop(t + dur + 0.05);
    n.onended = () => { try{ n.disconnect(); hp.disconnect(); bp.disconnect(); g.disconnect(); }catch{} };
  }

  rim(t, v){
    const ctx = this.ctx;
    const n = ctx.createBufferSource(); n.buffer = this._noise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2500; bp.Q.value = 9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.28 * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.030);
    n.connect(bp); bp.connect(g); g.connect(this.dry); g.connect(this.revIn);
    n.start(t); n.stop(t + 0.06);
    n.onended = () => { try{ n.disconnect(); bp.disconnect(); g.disconnect(); }catch{} };
  }

  pluck(t, degree, oct){
    const ctx = this.ctx, s = this.scene, sc = this.scaleNotes;
    const idx  = degree === undefined ? (Math.random() * sc.length) | 0
                                      : degree % sc.length;
    const semi = sc[idx] + (oct === undefined ? s.pluckOct : oct);
    const f = s.root * Math.pow(2, semi / 12);
    const o = ctx.createOscillator();
    o.type = Math.random() < 0.45 ? s.pluckWave : 'sine';
    o.frequency.value = f;

    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass'; bp.Q.value = 6;
    bp.frequency.setValueAtTime(Math.min(18000, f * 7), t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(60, f * 1.4), t + 1.1);

    const g = ctx.createGain();
    const peak = (s.calm ? 0.055 : 0.09) + Math.random() * (s.calm ? 0.04 : 0.07);
    const decay = s.pluckDecay ? s.pluckDecay * (0.8 + Math.random() * 0.5)
                : (s.calm ? 2.6 + Math.random() * 2.2 : 1.4 + Math.random() * 1.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    o.connect(bp); bp.connect(g); g.connect(this.dry); g.connect(this.revIn);
    o.start(t); o.stop(t + decay + 0.4);
    o.onended = () => { try{ o.disconnect(); bp.disconnect(); g.disconnect(); }catch{} };
  }

  /** Pull the harmonic bus down on the kick and let it breathe back in.
      The release is what you actually hear, so it is longer than the dip. */
  duckAt(t, depth){
    const g = this.duck.gain;
    try{
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.02, 1 - depth), t);
      g.linearRampToValueAtTime(1, t + 0.20);
    }catch{}
  }

  /** The chord under the current bar. */
  _chord(){
    const s = this.scene;
    const prog = PROG[s.prog] || PROG.lift;
    return prog[this._bar % prog.length];
  }

  /** A supersaw stab. Seven saws spread a few cents apart is the whole
      trick — one saw is thin, seven is a wall. */
  stab(t, rootSemi, quality){
    const ctx = this.ctx, s = this.scene;
    const notes = CHORDS[quality] || CHORDS.maj;
    const voices = s.chordVoices ?? 5;
    const spread = s.chordDetune ?? 12;
    const dur = (s.chordEvery ?? 4) * s.step * 0.92;

    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(s.chordLevel ?? 0.05, t + 0.012);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 1.1;
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.exponentialRampToValueAtTime(1400, t + dur);

    bus.connect(lp);
    lp.connect(s.sidechain ? this.duck : this.dry);
    lp.connect(this.revIn);

    for(const n of notes){
      const f = s.root * 4 * Math.pow(2, (rootSemi + n) / 12);
      if(f > 6000) continue;
      for(let v = 0; v < voices; v++){
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = (v - (voices - 1) / 2) * spread;
        if(s.chordWobble){
          // Future bass lives on this: the chord bends under itself.
          o.detune.setValueAtTime(o.detune.value - 55, t);
          o.detune.linearRampToValueAtTime(
            (v - (voices - 1) / 2) * spread, t + dur * 0.55);
        }
        const g = ctx.createGain();
        g.gain.value = 0.9 / (voices * notes.length);
        o.connect(g); g.connect(bus);
        o.start(t); o.stop(t + dur + 0.4);
        o.onended = () => { try{ o.disconnect(); g.disconnect(); }catch{} };
      }
    }
    setTimeout(() => { try{ bus.disconnect(); lp.disconnect(); }catch{} },
               (dur + 1) * 1000);
  }

  /** Sub bass on the chord root. Short, so it never masks the kick. */
  bassNote(t, rootSemi){
    const ctx = this.ctx, s = this.scene;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = s.root * Math.pow(2, rootSemi / 12);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 220; lp.Q.value = 3;

    const g = ctx.createGain();
    const dur = s.step * 1.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.30, t + 0.010);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o.connect(lp); lp.connect(g); g.connect(s.sidechain ? this.duck : this.dry);
    o.start(t); o.stop(t + dur + 0.1);
    o.onended = () => { try{ o.disconnect(); lp.disconnect(); g.disconnect(); }catch{} };
  }

  /** A riser over the bar before a section turns over. */
  riser(t, bars){
    const ctx = this.ctx, s = this.scene;
    const dur = bars * 16 * s.step;

    const n = ctx.createBufferSource(); n.buffer = this._noise(); n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 2.6;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(11000, t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.075, t + dur * 0.92);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);

    n.connect(bp); bp.connect(g); g.connect(this.dry); g.connect(this.revIn);
    n.start(t); n.stop(t + dur + 0.2);
    n.onended = () => { try{ n.disconnect(); bp.disconnect(); g.disconnect(); }catch{} };
  }

  /** A struck bowl. The partials of a real bowl are inharmonic — they are
      not integer multiples of the fundamental — and the high ones die away
      first. Pairing each partial with a slightly detuned twin gives the
      slow shimmer that makes a bowl sound alive rather than like a bell
      sample. */
  bowl(t, freq, amp){
    const ctx = this.ctx;
    const ratios = [1, 2.71, 5.43, 8.91, 13.3];
    const decays = [9.5, 6.4, 4.2, 2.8, 1.9];

    ratios.forEach((r, i) => {
      const level = amp * 0.16 / Math.pow(i + 1, 1.35);
      const decay = decays[i];
      [0, 1].forEach(twin => {
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.value = freq * r * (twin ? 1.0035 : 1);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(level, t + 0.006 + i * 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        o.connect(g); g.connect(this.dry); g.connect(this.revIn);
        o.start(t); o.stop(t + decay + 0.2);
        o.onended = () => { try{ o.disconnect(); g.disconnect(); }catch{} };
      });
    });

    // A breath of air on the strike, so it has an edge to it.
    const n = ctx.createBufferSource(); n.buffer = this._noise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq * 6; bp.Q.value = 2.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.030 * amp, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    n.connect(bp); bp.connect(ng); ng.connect(this.revIn);
    n.start(t); n.stop(t + 0.35);
    n.onended = () => { try{ n.disconnect(); bp.disconnect(); ng.disconnect(); }catch{} };

    // A calm piece has no drums, so the bowl is what the field sees.
    this._report(t, 0.30 + amp * 0.25);
  }

  /** A droplet: a very short band-passed noise burst. Dozens a second
      build the texture of rain without a single sample. */
  drop(t){
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._dropBuf || (this._dropBuf = noiseBuffer(ctx, 0.5));
    src.playbackRate.value = 0.7 + Math.random() * 1.6;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500 + Math.random() * 5200;
    bp.Q.value = 9 + Math.random() * 16;

    const g = ctx.createGain();
    const len = 0.05 + Math.random() * 0.20;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06 + Math.random() * 0.09, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);

    src.connect(bp); bp.connect(g); g.connect(this.dry); g.connect(this.revIn);
    const off = Math.random() * 0.22;
    src.start(t + off); src.stop(t + off + len + 0.05);
    src.onended = () => { try{ src.disconnect(); bp.disconnect(); g.disconnect(); }catch{} };
  }

  /** The low pulse — this is what the onset detector hears, and so
      what spawns the ripples. */
  pulse(t, amp){
    const ctx = this.ctx, s = this.scene;
    const peak = (s.pulseAmp || 0.42) * (amp || 1);
    if(!isFinite(peak) || peak <= 0) return;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(s.root * 1.16, t);
    o.frequency.exponentialRampToValueAtTime(s.root * 0.37, t + 0.16);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.58);

    o.connect(g); g.connect(this.dry);
    o.start(t); o.stop(t + 0.7);
    o.onended = () => { try{ o.disconnect(); g.disconnect(); }catch{} };
  }

  swell(t){
    const ctx = this.ctx, s = this.scene, sc = this.scaleNotes;
    const semi = sc[(Math.random() * 5) | 0];
    const o = ctx.createOscillator(); o.type = s.droneType === 'sine' ? 'triangle' : 'sawtooth';
    o.frequency.value = s.root * Math.pow(2, (semi + 24) / 12);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 8;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(4200, t + 2.6);
    f.frequency.exponentialRampToValueAtTime(400, t + 6.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.055, t + 2.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 6.6);
    o.connect(f); f.connect(g); g.connect(this.revIn); g.connect(this.dry);
    o.start(t); o.stop(t + 7);
    o.onended = () => { try{ o.disconnect(); f.disconnect(); g.disconnect(); }catch{} };
  }

  suspend(){
    this.running = false; this._clock.stop();
    ramp(this.out.gain, 0.0001, this.ctx.currentTime, 0.5);
  }
  resume(){
    if(this.running) return;
    this.running = true;
    ramp(this.out.gain, 0.9, this.ctx.currentTime, 1.2);
    this._next = this.ctx.currentTime + 0.2;
    this._clock.set(document.hidden ? 400 : 40);
  }
  stop(){
    this.running = false;
    this._clock.dispose();
    document.removeEventListener('visibilitychange', this._retune);
    ramp(this.out.gain, 0.0001, this.ctx.currentTime, 0.35);
    setTimeout(() => {
      this._teardownVoices();
      try{ this.out.disconnect(); this.dry.disconnect(); this.rev.disconnect();
           this.revGain.disconnect(); this.duck.disconnect();
           this.comp.disconnect(); }catch{}
    }, 450);
  }
}

function ramp(param, to, t, dur){
  try{
    param.cancelScheduledValues(t);
    param.setValueAtTime(Math.max(0.0001, param.value), t);
    param.exponentialRampToValueAtTime(Math.max(0.0001, to), t + dur);
  }catch{}
}

function noiseBuffer(ctx, sec){
  const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
  const d = b.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i] = Math.random()*2-1;
  return b;
}

function impulse(ctx, sec, decay){
  const n = ctx.sampleRate * sec;
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for(let c=0;c<2;c++){
    const d = b.getChannelData(c);
    for(let i=0;i<n;i++){
      const t = i/n;
      d[i] = (Math.random()*2-1) * Math.pow(1-t, decay) * (1 - t*0.25);
    }
  }
  return b;
}
