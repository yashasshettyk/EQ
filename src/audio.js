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
  wholeTone: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]
};

/* Patterns are one bar of sixteenths. Each character is a velocity,
   '0' or '.' is a rest. Everything else in a scene is counted in the
   same sixteenths, so the whole piece stays on one grid. */
export const SCENES = [
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
            hat:'..4...4.3.4...4.', rim:'.............4..' } }
];

class Ambient {
  constructor(ctx, analyseInto, monitor, sceneId){
    this.ctx = ctx; this.running = false;
    this.setScene(sceneId, true);

    this.out = ctx.createGain();
    this.out.gain.value = 0.0001;
    this.out.connect(analyseInto);
    this.out.connect(monitor);

    this.dry = ctx.createGain(); this.dry.gain.value = 0.72;
    this.dry.connect(this.out);

    this.rev = ctx.createConvolver();
    this.revGain = ctx.createGain();
    this.rev.connect(this.revGain); this.revGain.connect(this.out);
    this.revIn = this.rev;

    this.voices = [];
    this._step = 0; this._timer = 0; this._arp = 0;
    this._tick = this._tick.bind(this);
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
    this.running = false; clearInterval(this._timer);
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

    lp.connect(bus); bus.connect(this.dry); bus.connect(this.revIn);
    this.voices.push(lfo, lfoAmp, lp, bus);

    if(s.sub){
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.value = s.root / 2;
      const g = ctx.createGain(); g.gain.value = 0.09;
      o.connect(g); g.connect(this.dry); o.start(t);
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
    this._timer = setInterval(this._tick, 40);
    this._tick();
  }

  /** Look-ahead scheduler, so musical timing stays sample-accurate
      no matter how the page's timers drift over a long run. */
  _tick(){
    if(!this.running) return;
    const ctx = this.ctx, s = this.scene;
    const horizon = ctx.currentTime + 0.30;
    let guard = 0;
    while(this._next < horizon && guard++ < 96){
      // A long-suspended tab can leave _next far behind; catch it up
      // rather than scheduling thousands of notes in the past.
      if(this._next < ctx.currentTime - 1) this._next = ctx.currentTime + 0.05;
      const n = this._step, t = this._next;

      this.drums(n, t);
      if(!s.drums && n % 16 === 0) this.pulse(t, 1);

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
    const peak = 0.09 + Math.random() * 0.07;
    const decay = s.pluckDecay ? s.pluckDecay * (0.8 + Math.random() * 0.5)
                               : 1.4 + Math.random() * 1.4;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    o.connect(bp); bp.connect(g); g.connect(this.dry); g.connect(this.revIn);
    o.start(t); o.stop(t + decay + 0.4);
    o.onended = () => { try{ o.disconnect(); bp.disconnect(); g.disconnect(); }catch{} };
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
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(s.root * 1.16, t);
    o.frequency.exponentialRampToValueAtTime(s.root * 0.37, t + 0.16);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(s.pulseAmp * amp, t + 0.008);
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
    this.running = false; clearInterval(this._timer);
    ramp(this.out.gain, 0.0001, this.ctx.currentTime, 0.5);
  }
  resume(){
    if(this.running) return;
    this.running = true;
    ramp(this.out.gain, 0.9, this.ctx.currentTime, 1.2);
    this._next = this.ctx.currentTime + 0.2;
    this._timer = setInterval(this._tick, 40);
  }
  stop(){
    this.running = false; clearInterval(this._timer);
    ramp(this.out.gain, 0.0001, this.ctx.currentTime, 0.35);
    setTimeout(() => {
      this._teardownVoices();
      try{ this.out.disconnect(); this.dry.disconnect(); this.rev.disconnect();
           this.revGain.disconnect(); }catch{}
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
