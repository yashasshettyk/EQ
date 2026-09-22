/* ============================================================
   solar.js — the solar system view
   ------------------------------------------------------------
   Shares the GL context, the post chain and the device profile
   with the particle field. Bodies are rasterised spheres with
   procedural surfaces; belt, dust and stars ride the same
   additive point pipeline the field already uses.
   ============================================================ */

import { program, buffer, attrib, mat4, mulberry32 } from './gl.js';
import { layout } from './bodies.js';
import * as SS from './solar-shaders.js';

const DUST_VS = /* glsl */`#version 300 es
precision highp float;
in vec3 aPos;
in vec4 aSeed;
uniform mat4  uViewProj;
uniform vec3  uCam;
uniform float uTime, uPixelScale, uSpan, uLevel;
uniform int   uKind;          // 0 stars, 1 belt, 2 near dust
out vec3  vCol;
out float vA;

void main(){
  vec3 p = aPos;
  float bright, size;

  if(uKind == 0){
    // Stars sit on a shell that follows the camera, so they never
    // resolve into a sphere you can fly out of.
    p = uCam + normalize(aPos) * uSpan;
    bright = (0.04 + pow(aSeed.x, 6.0) * 1.15) * (0.6 + 0.4 * sin(uTime * (0.3 + aSeed.y) + aSeed.z * 6.28));
    size = 0.55 + pow(aSeed.x, 8.0) * 2.2;
    vCol = mix(vec3(0.62, 0.72, 1.0), vec3(1.0, 0.92, 0.80), aSeed.w);
  } else if(uKind == 1){
    // Asteroid belt: a ring between Mars and Jupiter, gently inclined.
    float a = aSeed.x * 6.2831853 + uTime * 0.012 * (0.7 + aSeed.y * 0.5);
    float r = uSpan * (0.86 + aSeed.y * 0.30);
    p = vec3(cos(a) * r, (aSeed.z - 0.5) * uSpan * 0.06, sin(a) * r);
    bright = 0.035 + aSeed.w * 0.16;
    size = 0.5 + aSeed.w * 1.3;
    vCol = mix(vec3(0.42, 0.38, 0.34), vec3(0.72, 0.66, 0.58), aSeed.w);
  } else {
    /* Near dust. It sits between the camera and the subject by design, so
       it has to stay tiny and faint — at any real size it stops reading as
       dust and starts reading as dirt on the lens. */
    p = uCam + aPos * uSpan;
    bright = (0.010 + aSeed.x * 0.030) * (0.5 + uLevel);
    size = 0.10 + aSeed.y * 0.16;
    vCol = vec3(0.55, 0.68, 0.95);
  }

  vec4 view = uViewProj * vec4(p, 1.0);
  gl_Position = view;
  gl_PointSize = clamp(size * uPixelScale / max(0.4, view.w) * 0.02, 1.0, 4.0);
  vA = bright;
}`;

const DUST_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vCol;
in float vA;
out vec4 frag;
void main(){
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if(r2 > 1.0) discard;
  float a = exp(-r2 * 3.2) * vA;
  frag = vec4(vCol * a, 1.0);
}`;

export class Solar {
  constructor(gl, profile){
    this.gl = gl;
    this.profile = profile;
    this.time = 0;
    this.bodies = layout();
    this.focus = 3;                    // Earth
    this.focusBlend = 1;

    this.progs = {
      body: program(gl, SS.BODY_VS, SS.BODY_FS, 'body'),
      ring: program(gl, SS.RING_VS, SS.RING_FS, 'ring'),
      dust: program(gl, DUST_VS, DUST_FS, 'dust'),
      sky:  program(gl, SS.SKY_VS, SS.SKY_FS, 'sky'),
      orbit: program(gl, SS.ORBIT_VS, SS.ORBIT_FS, 'orbit')
    };
    this.skyVao = gl.createVertexArray();

    this._buildSphere(profile.mobile ? 5 : 6);
    this._buildRing();
    this._buildOrbit();
    this._buildPoints();
    this._buildCamera();

    this.view = mat4.create();
    this.proj = mat4.create();
    this.viewProj = mat4.create();
    this.eye = [0, 0, 0];
    this.fov = 45 * Math.PI / 180;
  }

  /* ── geometry ───────────────────────────────────────────── */

  /** A UV sphere. Bands scale with the tier so a close body stays
      round rather than showing its silhouette facets. */
  _buildSphere(detail){
    const gl = this.gl;
    const cols = 1 << detail, rows = cols >> 1;
    const pos = [], idx = [];
    for(let y = 0; y <= rows; y++){
      const v = y / rows, phi = v * Math.PI;
      for(let x = 0; x <= cols; x++){
        const u = x / cols, th = u * Math.PI * 2;
        pos.push(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
      }
    }
    for(let y = 0; y < rows; y++)
      for(let x = 0; x < cols; x++){
        const a = y * (cols + 1) + x, b = a + cols + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    attrib(gl, this.progs.body.a.aPos, buffer(gl, new Float32Array(pos)), 3);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.sphere = { vao, count: idx.length };
  }

  _buildRing(){
    const gl = this.gl;
    const N = 256, pos = [], idx = [];
    for(let i = 0; i <= N; i++){
      const a = i / N * Math.PI * 2;
      pos.push(Math.cos(a) * 0.30, Math.sin(a) * 0.30);   // inner edge
      pos.push(Math.cos(a), Math.sin(a));                  // outer edge
    }
    for(let i = 0; i < N; i++){
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    attrib(gl, this.progs.ring.a.aXY, buffer(gl, new Float32Array(pos)), 2);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.ring = { vao, count: idx.length };
  }

  _buildOrbit(){
    const gl = this.gl, N = 512;
    const t = new Float32Array(N + 1);
    for(let i = 0; i <= N; i++) t[i] = i / N;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    attrib(gl, this.progs.orbit.a.aT, buffer(gl, t), 1);
    gl.bindVertexArray(null);
    this.orbitPath = { vao, count: N + 1 };
  }

  _buildPoints(){
    const gl = this.gl, rnd = mulberry32(0xA57E401);
    const scale = this.profile.mobile ? 0.35 : 1;
    const mk = (n, gen) => {
      n = Math.max(600, Math.round(n * scale));
      const pos = new Float32Array(n * 3), seed = new Float32Array(n * 4);
      for(let i = 0; i < n; i++){
        const p = gen(rnd);
        pos[i*3] = p[0]; pos[i*3+1] = p[1]; pos[i*3+2] = p[2];
        for(let k = 0; k < 4; k++) seed[i*4+k] = rnd();
      }
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      attrib(gl, this.progs.dust.a.aPos, buffer(gl, pos), 3);
      attrib(gl, this.progs.dust.a.aSeed, buffer(gl, seed), 4);
      gl.bindVertexArray(null);
      return { vao, count: n };
    };

    const onSphere = r => {
      const u = r() * 2 - 1, t = r() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - u*u));
      return [Math.cos(t) * s, u, Math.sin(t) * s];
    };
    this.stars = mk(14000, onSphere);
    this.belt  = mk(26000, r => [r(), r(), r()]);           // params, not positions
    this.dust  = mk(9000,  r => {
      const d = onSphere(r), k = Math.pow(r(), 0.4);
      return [d[0]*k, d[1]*k, d[2]*k];
    });
  }

  /* ── camera ─────────────────────────────────────────────── */

  _buildCamera(){
    /* Zoom is exponential. `alt` is altitude in body radii on a log
       scale, so one turn of the wheel covers the same *proportion* of
       the distance whether you are at the edge of the system or a
       hundred metres off the cloud tops — which is what makes the
       zoom feel endless rather than merely long. */
    this.cam = {
      yaw: 0.9, pitch: 0.28, yawV: 0, pitchV: 0,
      logAlt: Math.log(6), logAltTarget: Math.log(6),
      drift: 1, userDolly: false
    };
  }

  get altitude(){ return Math.exp(this.cam.logAlt); }   // in radii above centre

  orbit(dx, dy){
    this.cam.yawV   -= dx * 0.0038;
    this.cam.pitchV -= dy * 0.0032;
    this.cam.drift = 0;
  }
  dolly(dy){
    this.cam.userDolly = true;
    // A fixed step in log space — the same gesture at any scale.
    this.cam.logAltTarget = clamp(this.cam.logAltTarget + dy * 0.0016,
                                  Math.log(1.015), Math.log(4200));
  }
  setFocus(i){
    if(i === this.focus) return;
    this.focus = i;
    this.focusBlend = 0;
    this.cam.logAltTarget = Math.log(6);
    this.frameLit();
  }

  /* Park the camera off to one side of the sun-body line. Dead astern of
     the Sun the planet is flat-lit and flat-looking; a little to the side
     puts a terminator across it, which is what gives the sphere its form. */
  frameLit(offset = 1.32){
    const b = this.bodies[this.focus];
    if(!b || b.kind === 'star'){ this.cam.yaw = 0.9; this.cam.pitch = 0.22; return; }
    // Sun sits at the origin, so the lit side faces back toward it.
    const toSun = Math.atan2(-b.x, -b.z);
    this.cam.yaw = toSun + offset;
    this.cam.pitch = 0.20;
    this.cam.yawV = 0; this.cam.pitchV = 0;
    this.cam.drift = 0;
  }
  recentre(){
    this.cam.logAltTarget = Math.log(6);
    this.cam.userDolly = false;
    this.frameLit();
  }
  /** System-wide view: far enough out to hold the outermost orbit, and
      no further — a fixed number here is either short or absurd. */
  viewAll(){
    this.focus = 0;
    this.focusBlend = 0;
    const outer = Math.max(...this.bodies.map(b => b.orbit));
    const needed = outer * 1.45 / Math.tan(this.fov / 2) * 0.55;
    this.cam.logAltTarget = Math.log(clamp(needed / this.bodies[0].size, 4, 4200));
    this.cam.pitch = 0.62;
    this.cam.yawV = 0; this.cam.pitchV = 0; this.cam.drift = 1;
    this.cam.userDolly = false;
  }

  resize(w, h, aspect){
    this.rw = w; this.rh = h; this.aspect = aspect;
    const deg = aspect < 1 ? 45 + (1 - aspect) * 26 : 45;
    this.fov = deg * Math.PI / 180;
    this.pixelScale = h / (2 * Math.tan(this.fov / 2));
  }

  /* ── frame ──────────────────────────────────────────────── */

  _positions(){
    const t = this.time;
    for(const b of this.bodies){
      const a = b.phase + t * b.speed * 0.06;
      b.x = Math.cos(a) * b.orbit;
      b.y = Math.sin(a) * b.orbit * 0.035;      // a slight inclination
      b.z = Math.sin(a) * b.orbit;
      b.rot = t * b.spin;
    }
  }

  _spinMatrix(b, out){
    const tilt = b.tiltDeg * Math.PI / 180, r = b.rot;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const cr = Math.cos(r), sr = Math.sin(r);
    // tilt about Z, then spin about the tilted Y
    out[0] =  cr * ct;  out[1] = st;       out[2] = -sr * ct;
    out[3] = -cr * st;  out[4] = ct;       out[5] =  sr * st;
    out[6] =  sr;       out[7] = 0;        out[8] =  cr;
    return out;
  }

  render(dt, audio){
    const gl = this.gl;
    this.time += dt;
    this._positions();

    const c = this.cam;
    c.yaw   += c.yawV;   c.yawV   *= Math.pow(0.0025, dt);
    c.pitch += c.pitchV; c.pitchV *= Math.pow(0.0025, dt);
    c.pitch = clamp(c.pitch, -1.45, 1.45);
    c.drift = Math.min(1, c.drift + dt * 0.15);
    c.yaw  += dt * 0.008 * c.drift;
    c.logAlt += (c.logAltTarget - c.logAlt) * Math.min(1, dt * 4.0);
    this.focusBlend = Math.min(1, this.focusBlend + dt * 1.6);

    const f = this.bodies[this.focus];
    const alt = Math.exp(c.logAlt);
    const dist = f.size * alt;
    const target = [f.x, f.y, f.z];

    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    this.eye[0] = target[0] + Math.sin(c.yaw) * cp * dist;
    this.eye[1] = target[1] + sp * dist;
    this.eye[2] = target[2] + Math.cos(c.yaw) * cp * dist;

    /* The near and far planes ride the altitude. A fixed pair cannot
       hold both a cloud top and Neptune's orbit without the depth
       buffer collapsing into banding. */
    const near = Math.max(1e-4, f.size * (alt - 1) * 0.05 + f.size * 0.002);
    const far  = Math.max(dist * 12, 4000);
    mat4.perspective(this.proj, this.fov, this.aspect, near, far);
    mat4.lookAt(this.view, this.eye, target, [0, 1, 0]);
    mat4.multiply(this.viewProj, this.proj, this.view);

    /* ── sky first, with depth off so it sits behind everything ── */
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    {
      // The view ray is built from the camera basis rather than by
      // inverting the matrix — cheaper, and exact.
      const fwd = norm([target[0]-this.eye[0], target[1]-this.eye[1], target[2]-this.eye[2]]);
      const right = norm(cross(fwd, [0,1,0]));
      const up = cross(right, fwd);
      const K = this.progs.sky;
      K.use();
      gl.uniform3fv(K.u.uRight, right);
      gl.uniform3fv(K.u.uUp, up);
      gl.uniform3fv(K.u.uFwd, fwd);
      gl.uniform1f(K.u.uTanHalf, Math.tan(this.fov / 2));
      gl.uniform1f(K.u.uAspect, this.aspect);
      gl.uniform1f(K.u.uTime, this.time);
      gl.uniform1f(K.u.uLevel, audio.level);
      gl.bindVertexArray(this.skyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);

    // ── bodies
    const P = this.progs.body, spin = new Float32Array(9);
    P.use();
    gl.uniformMatrix4fv(P.u.uViewProj, false, this.viewProj);
    gl.uniform3fv(P.u.uCam, this.eye);
    gl.uniform3f(P.u.uSunPos, 0, 0, 0);
    gl.uniform1f(P.u.uTime, this.time);
    gl.uniform1f(P.u.uLevel, audio.level);
    gl.uniform1f(P.u.uBass, audio.bass);
    gl.bindVertexArray(this.sphere.vao);

    for(const b of this.bodies){
      const d = Math.hypot(this.eye[0]-b.x, this.eye[1]-b.y, this.eye[2]-b.z);
      if(d > far) continue;
      // Apparent size in pixels drives the octave count: detail is added
      // as a body approaches, never magnified out of what is already there.
      const apparent = (b.size / Math.max(1e-5, d)) * this.pixelScale;
      if(apparent < 0.6) continue;
      const detail = Math.round(clamp(4 + Math.log2(Math.max(1, apparent)) * 0.95, 4, 11));

      gl.uniform1i(P.u.uSurface, b.surface);
      gl.uniform3f(P.u.uCenter, b.x, b.y, b.z);
      gl.uniform1f(P.u.uRadius, b.size);
      gl.uniform3fv(P.u.uTint, b.tint);
      gl.uniform3fv(P.u.uAtmo, b.atmo);
      gl.uniform1f(P.u.uAtmoStrength, b.atmoStrength);
      gl.uniform1i(P.u.uDetail, detail);
      gl.uniform1f(P.u.uClose, clamp(apparent / this.rh, 0, 1));
      gl.uniformMatrix3fv(P.u.uSpin, false, this._spinMatrix(b, spin));
      gl.drawElements(gl.TRIANGLES, this.sphere.count, gl.UNSIGNED_INT, 0);
    }

    // ── rings, blended over the bodies
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
    gl.depthMask(false);
    const R = this.progs.ring;
    R.use();
    gl.uniformMatrix4fv(R.u.uViewProj, false, this.viewProj);
    gl.uniform3fv(R.u.uCam, this.eye);
    gl.uniform3f(R.u.uSunPos, 0, 0, 0);
    gl.bindVertexArray(this.ring.vao);
    for(const b of this.bodies){
      if(!b.ring) continue;
      const d = Math.hypot(this.eye[0]-b.x, this.eye[1]-b.y, this.eye[2]-b.z);
      const apparent = (b.size / Math.max(1e-5, d)) * this.pixelScale;
      if(apparent < 1.2) continue;
      gl.uniform3f(R.u.uCenter, b.x, b.y, b.z);
      gl.uniform1f(R.u.uInner, b.size * b.ring[0]);
      gl.uniform1f(R.u.uOuter, b.size * b.ring[1]);
      gl.uniform1f(R.u.uBodyRadius, b.size);
      gl.uniform3fv(R.u.uTint, b.tint);
      gl.uniform1i(R.u.uDetail, Math.round(clamp(5 + Math.log2(Math.max(1, apparent)) * 0.8, 5, 10)));
      gl.uniformMatrix3fv(R.u.uSpin, false, this._spinMatrix(b, spin));
      gl.drawElements(gl.TRIANGLES, this.ring.count, gl.UNSIGNED_INT, 0);
    }

    /* ── orbit paths. They clarify the system from outside and are
           clutter from close up, so they fade with altitude. */
    const outer = Math.max(...this.bodies.map(b => b.orbit));
    const wide = clamp((dist / outer - 0.22) * 2.4, 0, 1);
    if(wide > 0.01){
      gl.blendFunc(gl.ONE, gl.ONE);
      const O = this.progs.orbit;
      O.use();
      gl.uniformMatrix4fv(O.u.uViewProj, false, this.viewProj);
      gl.uniform1f(O.u.uTiltZ, 0.035);
      gl.uniform3f(O.u.uCol, 0.38, 0.52, 0.80);
      gl.bindVertexArray(this.orbitPath.vao);
      for(const b of this.bodies){
        if(!b.orbit) continue;
        gl.uniform1f(O.u.uRadius, b.orbit);
        gl.uniform1f(O.u.uAlpha, wide * (b.index === this.focus ? 0.13 : 0.055));
        gl.drawArrays(gl.LINE_STRIP, 0, this.orbitPath.count);
      }
    }

    // ── stars, belt, dust — additive, behind everything solid
    gl.blendFunc(gl.ONE, gl.ONE);
    const D = this.progs.dust;
    D.use();
    gl.uniformMatrix4fv(D.u.uViewProj, false, this.viewProj);
    gl.uniform3fv(D.u.uCam, this.eye);
    gl.uniform1f(D.u.uTime, this.time);
    gl.uniform1f(D.u.uPixelScale, this.pixelScale);
    gl.uniform1f(D.u.uLevel, audio.level);

    const belt = this.bodies[5].orbit * 0.62;
    const draw = (set, kind, span) => {
      gl.uniform1i(D.u.uKind, kind);
      gl.uniform1f(D.u.uSpan, span);
      gl.bindVertexArray(set.vao);
      gl.drawArrays(gl.POINTS, 0, set.count);
    };
    draw(this.stars, 0, far * 0.75);
    draw(this.belt,  1, belt);
    draw(this.dust,  2, dist * 3.0);

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  /** What the panel should say, and how close we are to it. */
  get focused(){ return this.bodies[this.focus]; }
  get altitudeLabel(){
    const b = this.focused;
    const kmAbove = (this.altitude - 1) * b.radiusKm;
    if(kmAbove < 1000) return `${Math.round(kmAbove)} km above the surface`;
    if(kmAbove < 1e6)  return `${(kmAbove / 1000).toFixed(1)} thousand km out`;
    return `${(kmAbove / 1e6).toFixed(2)} million km out`;
  }
}

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function norm(v){ const l = Math.hypot(v[0],v[1],v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
function cross(a, b){
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
