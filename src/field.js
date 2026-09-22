/* ============================================================
   field.js — the particle field
   ============================================================ */

import { program, buffer, attrib, mat4, mulberry32 } from './gl.js';
import * as S from './shaders.js';
import { BANDS, WAVE } from './audio.js';

/* ── palettes ─────────────────────────────────────────────────
   Authored in sRGB, converted to linear on upload so the ACES
   tonemap in the composite behaves physically.                */
export const PALETTES = [
  { id:'signal',   name:'Signal',   stops:['#03071A','#0C2A8E','#2F6BFF','#93C4FF','#FFFFFF'] },
  { id:'nocturne', name:'Nocturne', stops:['#050411','#241C74','#6E5BDE','#BBB2FF','#FFFFFF'] },
  { id:'abyss',    name:'Abyss',    stops:['#00131C','#064257','#11AFC6','#8FEAF5','#F4FEFF'] },
  { id:'ember',    name:'Ember',    stops:['#150300','#5C1206','#D9481A','#FFA94B','#FFF1D6'] },
  { id:'platinum', name:'Platinum', stops:['#040405','#282D36','#7C8697','#D6DCE6','#FFFFFF'] }
];

/* ── particle designs ─────────────────────────────────────────
   Each mode reinterprets the same buffers as a different form,
   so switching is a cross-fade rather than a rebuild.         */
export const MODES = [
  { id:'orb',     name:'Orb',     extent:2.55, pitch:0.235, plane:1.00, mirror:1.00 },
  { id:'corona',  name:'Corona',  extent:3.15, pitch:0.200, plane:1.00, mirror:0.50 },
  { id:'cymatic', name:'Cymatic', extent:3.55, pitch:0.455, plane:0.12, mirror:0.00 },
  { id:'helix',   name:'Helix',   extent:2.95, pitch:0.175, plane:0.45, mirror:0.55 }
];

/* The clock is wrapped here. Every animated term is driven through a
   phase that lands exactly on itself at this boundary, so the field
   runs indefinitely with neither a seam nor float-precision decay. */
export const LOOP = 1020;   // seconds — 6 × 170, divisible by every wisp rate

/* ── quality tiers ───────────────────────────────────────────
   `ss` supersamples above the device's own pixel ratio. `edge`
   asks for an absolute long-edge target instead.              */
export const TIERS = [
  { id:'balanced', name:'Balanced', dprCap:1.25, ss:1.00, mul:0.46, oct:1 },
  { id:'high',     name:'High',     dprCap:2.00, ss:1.00, mul:0.76, oct:2 },
  { id:'ultra',    name:'Ultra',    dprCap:2.00, ss:1.45, mul:1.00, oct:3 },
  { id:'max',      name:'8K',       dprCap:2.00, ss:1.00, mul:1.26, oct:3, edge:7680 }
];

const BASE = { shell:132000, wisp:46000, ripple:64000, dust:27000, spark:9216 };
const MAXC = Object.fromEntries(Object.entries(BASE).map(([k,v]) => [k, Math.ceil(v * 1.26)]));

const PIXEL_BUDGET = 35e6;   // RGBA16F scene target ceiling (~280 MB)

export class Field {
  constructor(gl){
    this.gl = gl;
    this.time = 0;

    this.progs = {
      shell:  program(gl, S.SHELL_VS,  S.POINT_FS, 'shell'),
      wisp:   program(gl, S.WISP_VS,   S.POINT_FS, 'wisp'),
      ripple: program(gl, S.RIPPLE_VS, S.POINT_FS, 'ripple'),
      dust:   program(gl, S.DUST_VS,   S.POINT_FS, 'dust'),
      spark:  program(gl, S.SPARK_VS,  S.POINT_FS, 'spark')
    };

    this.counts = { ...BASE };
    this.modeA = 0; this.modeB = 0; this.morph = 0; this.morphRate = 0;
    this.octaves = 3;
    this.intensity = 1;
    this.radius = 1.62;
    this.specAmp = 0.62;

    this._buildGeometry();
    this._buildSpectrumTexture();
    this._buildRipples();
    this._buildCamera();

    this.setPalette(0);
  }

  /* ── geometry ──────────────────────────────────────────── */

  _buildGeometry(){
    const gl = this.gl;
    const rnd = mulberry32(0x5EED1);
    this.vao = {};

    const seeds = n => { const a = new Float32Array(n*4); for(let i=0;i<a.length;i++) a[i]=rnd(); return a; };

    /* Fibonacci sphere, then a deterministic shuffle so that drawing
       only a prefix at lower quality still samples the whole sphere. */
    const sphere = n => {
      const a = new Float32Array(n*3);
      const gr = Math.PI * (3 - Math.sqrt(5));
      for(let i=0;i<n;i++){
        const y = 1 - (i / (n - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y*y));
        const th = gr * i;
        a[i*3]   = Math.cos(th) * r;
        a[i*3+1] = y;
        a[i*3+2] = Math.sin(th) * r;
      }
      for(let i=n-1;i>0;i--){
        const j = (rnd() * (i+1)) | 0;
        for(let k=0;k<3;k++){ const t=a[i*3+k]; a[i*3+k]=a[j*3+k]; a[j*3+k]=t; }
      }
      return a;
    };

    const mk = (name, attrs, count) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const p = this.progs[name];
      for(const [attrName, data, size, usage] of attrs){
        const buf = buffer(gl, data, usage);
        attrib(gl, p.a[attrName], buf, size);
        if(usage === gl.DYNAMIC_DRAW) (this.dyn ||= {})[attrName] = buf;
      }
      gl.bindVertexArray(null);
      this.vao[name] = { vao, max: count };
    };

    mk('shell',  [['aDir', sphere(MAXC.shell), 3], ['aSeed', seeds(MAXC.shell), 4]], MAXC.shell);
    mk('wisp',   [['aDir', sphere(MAXC.wisp),  3], ['aSeed', seeds(MAXC.wisp),  4]], MAXC.wisp);

    // ripple plane: uniform-area disc sampling
    {
      const n = MAXC.ripple, xz = new Float32Array(n*2);
      for(let i=0;i<n;i++){
        const r = 8.6 * Math.sqrt(rnd());
        const t = rnd() * Math.PI * 2;
        xz[i*2] = Math.cos(t) * r;
        xz[i*2+1] = Math.sin(t) * r;
      }
      mk('ripple', [['aXZ', xz, 2], ['aSeed', seeds(n), 4]], n);
    }

    // dust volume, biased away from the centre so it reads as depth
    {
      const n = MAXC.dust, pos = new Float32Array(n*3);
      for(let i=0;i<n;i++){
        const r = 3.2 + Math.pow(rnd(), 0.62) * 16;
        const u = rnd()*2-1, th = rnd()*Math.PI*2;
        const s = Math.sqrt(Math.max(0,1-u*u));
        pos[i*3]   = Math.cos(th)*s*r;
        pos[i*3+1] = u*r*0.55;
        pos[i*3+2] = Math.sin(th)*s*r;
      }
      mk('dust', [['aPos', pos, 3], ['aSeed', seeds(n), 4]], n);
    }

    // sparks: written from the CPU on each onset, integrated on the GPU
    {
      const n = MAXC.spark;
      this.sparkPos  = new Float32Array(n*3);
      this.sparkVel  = new Float32Array(n*3);
      this.sparkMeta = new Float32Array(n*4);   // birth, life, hue, size
      mk('spark', [
        ['aPos0', this.sparkPos,  3, gl.DYNAMIC_DRAW],
        ['aVel0', this.sparkVel,  3, gl.DYNAMIC_DRAW],
        ['aMeta', this.sparkMeta, 4, gl.DYNAMIC_DRAW]
      ], n);
      this.sparkHead = 0;
    }
  }

  /* ── audio texture: 256 × 3 (spectrum / peaks / waveform) ── */

  _buildSpectrumTexture(){
    const gl = this.gl;
    this.specData = new Float32Array(BANDS * 3);
    this.specTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, BANDS, 3, 0, gl.RED, gl.FLOAT, this.specData);
    for(const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for(const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
  }

  _uploadAudio(a){
    const gl = this.gl, d = this.specData;
    d.set(a.spectrum, 0);
    d.set(a.peaks, BANDS);
    for(let i=0;i<WAVE;i++) d[BANDS*2 + i] = a.wave[i] * 0.5 + 0.5;
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BANDS, 3, gl.RED, gl.FLOAT, d);
  }

  /* ── ripples ───────────────────────────────────────────── */

  _buildRipples(){
    this.ripples = new Float32Array(S.MAX_RIPPLES * 4);
    for(let i=0;i<S.MAX_RIPPLES;i++) this.ripples[i*4+3] = 0;
    this._rippleHead = 0;
    this._autoRipple = 0;
  }

  spawnRipple(x, z, amp){
    const i = this._rippleHead % S.MAX_RIPPLES;
    this._rippleHead++;
    const o = i*4;
    this.ripples[o]   = x;
    this.ripples[o+1] = z;
    this.ripples[o+2] = this.time;
    this.ripples[o+3] = amp;
  }

  /* ── sparks ────────────────────────────────────────────── */

  emitSparks(n, strength, centroid){
    const cap = this.counts.spark;
    n = Math.min(n, 700);
    const t = this.time;
    const base = this.radius + 0.12;
    let first = this.sparkHead % cap, wrote = 0;

    for(let k=0;k<n;k++){
      const i = (this.sparkHead++ % cap);
      // launch from a random point on the shell, mostly outward
      const u = Math.random()*2-1, th = Math.random()*Math.PI*2;
      const s = Math.sqrt(Math.max(0,1-u*u));
      const dx = Math.cos(th)*s, dy = u, dz = Math.sin(th)*s;
      const r = base * (0.92 + Math.random()*0.3);
      this.sparkPos[i*3]   = dx*r;
      this.sparkPos[i*3+1] = dy*r*0.9;
      this.sparkPos[i*3+2] = dz*r;
      const sp = (1.1 + Math.random()*2.6) * (0.55 + strength);
      this.sparkVel[i*3]   = dx*sp + (Math.random()-0.5)*0.7;
      this.sparkVel[i*3+1] = dy*sp*0.85 + Math.random()*0.5;
      this.sparkVel[i*3+2] = dz*sp + (Math.random()-0.5)*0.7;
      this.sparkMeta[i*4]   = t;
      this.sparkMeta[i*4+1] = 0.9 + Math.random()*1.5;
      this.sparkMeta[i*4+2] = centroid * 0.6 + Math.random()*0.4;
      this.sparkMeta[i*4+3] = Math.random()*Math.random();
      wrote++;
    }

    // Push only the touched range; wrap means two writes at most.
    const gl = this.gl;
    const end = first + wrote;
    const ranges = end <= cap ? [[first, wrote]] : [[first, cap-first], [0, end-cap]];
    for(const [off, len] of ranges){
      if(len <= 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn.aPos0);
      gl.bufferSubData(gl.ARRAY_BUFFER, off*3*4, this.sparkPos,  off*3, len*3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn.aVel0);
      gl.bufferSubData(gl.ARRAY_BUFFER, off*3*4, this.sparkVel,  off*3, len*3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn.aMeta);
      gl.bufferSubData(gl.ARRAY_BUFFER, off*4*4, this.sparkMeta, off*4, len*4);
    }
  }

  /* ── camera ────────────────────────────────────────────── */

  _buildCamera(){
    this.cam = {
      yaw: 0.52, pitch: 0.235, dist: 8.6,
      yawV: 0, pitchV: 0, distTarget: 8.6,
      target: [0, 0.02, 0], shake: 0, drift: 0,
      pitchGoal: 0.235, pitchGoalT: 0
    };
    this.composition = 0; this.compTarget = 0;
    this.userDolly = false;
    this.view = mat4.create();
    this.proj = mat4.create();
    this.viewProj = mat4.create();
    this.eye = [0,0,0];
    this.fov = 42 * Math.PI / 180;
  }

  /** Slide the form sideways in clip space so UI copy can share the frame. */
  setComposition(x, immediate){
    this.compTarget = x;
    if(immediate) this.composition = x;
  }

  /** Distance that frames the form the same way on any aspect ratio. */
  fitDistance(){
    const extent = MODES[this.modeB].extent, frac = 0.80;
    const tv = Math.tan(this.fov / 2);
    const th = tv * (this.aspect || 1);
    return clamp(Math.max(extent / (tv * frac), extent / (th * frac)), 4.6, 15);
  }

  orbit(dx, dy){
    this.cam.yawV   -= dx * 0.0042;
    this.cam.pitchV -= dy * 0.0036;
    this.cam.pitchGoalT = 0;
    this.cam.drift   = 0;            // user took over; pause the auto-orbit
  }
  dolly(dy){
    this.userDolly = true;
    this.cam.distTarget = clamp(this.cam.distTarget * (1 + dy * 0.0012), 2.4, 16);
  }
  recentre(){
    this.userDolly = false;
    this.cam.distTarget = this.fitDistance();
    this.cam.pitch = 0.235; this.cam.yawV = 0; this.cam.pitchV = 0;
    this.cam.drift = 1;
  }

  _updateCamera(dt, a){
    const c = this.cam;
    c.yaw   += c.yawV;   c.yawV   *= Math.pow(0.0025, dt);
    c.pitch += c.pitchV; c.pitchV *= Math.pow(0.0025, dt);
    c.pitch = clamp(c.pitch, -1.15, 1.15);

    // resume a slow auto-orbit once the pointer has been still
    c.drift = Math.min(1, c.drift + dt * 0.18);
    c.yaw  += dt * 0.026 * c.drift;

    if(c.pitchGoalT > 0){
      c.pitchGoalT -= dt;
      c.pitch += (c.pitchGoal - c.pitch) * Math.min(1, dt * 2.2);
    }
    c.dist += (c.distTarget - c.dist) * Math.min(1, dt * 4.5);
    c.shake = Math.max(0, c.shake - dt * 4.2);

    const bob  = Math.sin(this.time * 0.31) * 0.035 + Math.sin(this.time * 0.17) * 0.022;
    const pull = a.bass * 0.30 + a.level * 0.10;      // the mix breathes the camera
    const d    = c.dist - pull;

    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const sh = c.shake;
    this.eye[0] = Math.sin(c.yaw) * cp * d + Math.sin(this.time*31.0)*sh*0.02;
    this.eye[1] = sp * d + 0.40 + bob + Math.cos(this.time*27.0)*sh*0.02;
    this.eye[2] = Math.cos(c.yaw) * cp * d;

    this.composition += (this.compTarget - this.composition) * Math.min(1, dt * 2.6);

    mat4.perspective(this.proj, this.fov, this.aspect, 0.05, 90);
    // A shear on the z column becomes a constant NDC x offset after the
    // perspective divide — it shifts the subject without skewing it.
    this.proj[8] = -this.composition;
    mat4.lookAt(this.view, this.eye, this.cam.target, [0,1,0]);
    mat4.multiply(this.viewProj, this.proj, this.view);
  }

  /* ── settings ──────────────────────────────────────────── */

  setMode(i){
    const next = ((i % MODES.length) + MODES.length) % MODES.length;
    if(next === this.modeB && this.morphRate === 0) return MODES[next];
    // If a cross-fade is already running, land it before starting the next.
    if(this.morphRate !== 0){ this.modeA = this.modeB; this.morph = 0; }
    this.modeB = next;
    this.morph = 0;
    this.morphRate = 1 / 1.5;

    const m = MODES[next];
    this.cam.pitchGoal = m.pitch;
    this.cam.pitchGoalT = 1.8;
    if(!this.userDolly) this.cam.distTarget = this.fitDistance();
    return m;
  }

  get mode(){ return MODES[this.modeB]; }

  setPalette(i){
    this.paletteIndex = ((i % PALETTES.length) + PALETTES.length) % PALETTES.length;
    const p = PALETTES[this.paletteIndex];
    this.palLinear = new Float32Array(15);
    p.stops.forEach((hex, k) => {
      const [r,g,b] = hexToLinear(hex);
      this.palLinear[k*3] = r; this.palLinear[k*3+1] = g; this.palLinear[k*3+2] = b;
    });
    return p;
  }

  setTier(tier){
    this.tier = tier;
    this.octaves = tier.oct;
    for(const k in BASE) this.counts[k] = Math.min(MAXC[k], Math.round(BASE[k] * tier.mul));
  }

  /** Works out the scene resolution for a tier, honouring the GPU's
      limits and a memory budget. Returns the render-pixel size. */
  resolutionFor(tier, cssW, cssH){
    const gl = this.gl;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const dpr = Math.min(window.devicePixelRatio || 1, tier.dprCap);
    let w, h;

    if(tier.edge){
      const long = Math.max(cssW, cssH);
      const scale = Math.min(tier.edge / long, 4.5);
      w = cssW * scale; h = cssH * scale;
    } else {
      w = cssW * dpr * tier.ss; h = cssH * dpr * tier.ss;
    }

    // clamp to the largest texture the driver will give us
    const k1 = Math.min(1, maxTex / Math.max(w, h));
    w *= k1; h *= k1;
    // and to the memory budget
    const k2 = Math.min(1, Math.sqrt(PIXEL_BUDGET / Math.max(1, w * h)));
    w *= k2; h *= k2;

    return { w: Math.max(2, Math.floor(w)), h: Math.max(2, Math.floor(h)) };
  }

  resize(w, h, aspect){
    this.rw = w; this.rh = h; this.aspect = aspect;
    if(!this.userDolly) this.cam.distTarget = this.fitDistance();
    // Point size in pixels for a unit-sized particle at unit depth.
    this.pixelScale = (h / (2 * Math.tan(this.fov / 2))) * 0.0045;
  }

  /* ── frame ─────────────────────────────────────────────── */

  _setCommon(p, a){
    const gl = this.gl, u = p.u;
    gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    gl.uniform3fv(u.uCam, this.eye);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform2f(u.uRes, this.rw, this.rh);
    gl.uniform1f(u.uPixelScale, this.pixelScale);
    gl.uniform1f(u.uMinPx, 1.35);
    gl.uniform1i(u.uSpec, 0);
    gl.uniform1f(u.uLevel, a.level);
    gl.uniform1f(u.uBass, a.bass);
    gl.uniform1f(u.uLowMid, a.low);
    gl.uniform1f(u.uMid, a.mid);
    gl.uniform1f(u.uHigh, a.high);
    gl.uniform1f(u.uAir, a.air);
    gl.uniform1f(u.uCentroid, a.centroid);
    gl.uniform1f(u.uBeat, a.beat);
    gl.uniform1f(u.uIdle, Math.max(0, 1 - Math.min(1, a.level * 5.5 + a.bass * 2.2)));
    gl.uniform1f(u.uLoopW, (Math.PI * 2) / LOOP);
    gl.uniform1f(u.uRadius, this.radius);
    gl.uniform1f(u.uSpecAmp, this.specAmp);
    gl.uniform1i(u.uOctaves, this.octaves);
    gl.uniform1i(u.uModeA, this.modeA);
    gl.uniform1i(u.uModeB, this.modeB);
    gl.uniform1f(u.uMorph, this.morph);
    gl.uniform1f(u.uIntensity, this.intensity);
    gl.uniform3fv(u.uPal, this.palLinear);
    gl.uniform4fv(u.uRipples, this.ripples);
  }

  /** Roll the clock over, rebasing every absolute timestamp with it. */
  _wrapClock(){
    this.time -= LOOP;
    for(let i = 0; i < S.MAX_RIPPLES; i++) this.ripples[i*4+2] -= LOOP;
    const meta = this.sparkMeta;
    for(let i = 0; i < meta.length; i += 4) meta[i] -= LOOP;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn.aMeta);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, meta);
  }

  render(dt, a){
    const gl = this.gl;
    this.time += dt;
    if(this.time >= LOOP) this._wrapClock();

    if(this.morphRate > 0){
      this.morph += dt * this.morphRate;
      if(this.morph >= 1){ this.morph = 0; this.morphRate = 0; this.modeA = this.modeB; }
    }

    // idle swell: keep water moving even in silence
    this._autoRipple -= dt;
    if(this._autoRipple <= 0){
      this._autoRipple = 2.6 + Math.random() * 2.4;
      this.spawnRipple((Math.random()-0.5)*3.4, (Math.random()-0.5)*3.4, 0.16 + Math.random()*0.10);
    }

    this._updateCamera(dt, a);
    this._uploadAudio(a);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);      // additive: order-independent

    const PLANE_Y = -2.52;

    const draw = (name, extra, count) => {
      const p = this.progs[name];
      p.use();
      this._setCommon(p, a);
      extra?.(p);
      gl.bindVertexArray(this.vao[name].vao);
      gl.drawArrays(gl.POINTS, 0, count ?? this.counts[name]);
    };

    const m = MODES[this.modeB], mPrev = MODES[this.modeA];
    const k = this.morph;
    const lerp = key => mPrev[key] + (m[key] - mPrev[key]) * k;

    draw('dust');
    // Reflection first, so the water surface reads as lying over it.
    draw('shell', p => {
      gl.uniform1f(p.u.uMirror, 1);
      gl.uniform1f(p.u.uMirrorY, PLANE_Y);
      gl.uniform1f(p.u.uIntensity, this.intensity * lerp('mirror'));
    }, Math.round(this.counts.shell * 0.5));
    draw('ripple', p => {
      gl.uniform1f(p.u.uPlaneY, PLANE_Y);
      gl.uniform1f(p.u.uRippleAmp, 1.42);
      gl.uniform1f(p.u.uIntensity, this.intensity * lerp('plane'));
    });
    draw('wisp');
    draw('shell', p => {
      gl.uniform1f(p.u.uMirror, 0);
      gl.uniform1f(p.u.uMirrorY, PLANE_Y);
    });
    draw('spark');

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}

/* ── helpers ───────────────────────────────────────────────── */

function clamp(v,a,b){ return v<a?a:v>b?b:v; }

function hexToLinear(hex){
  const n = parseInt(hex.slice(1), 16);
  const srgb = [(n>>16 & 255)/255, (n>>8 & 255)/255, (n & 255)/255];
  return srgb.map(c => c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4));
}
