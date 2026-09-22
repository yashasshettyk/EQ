/* ============================================================
   shaders.js — GLSL ES 3.00 sources
   ============================================================ */

export const MAX_RIPPLES = 16;

/* Shared prelude: noise, palette, spectrum sampling, wave packets,
   and the sub-pixel sizing rule that keeps supersampled points crisp. */
export const COMMON = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;

#define PI  3.141592653589793
#define TAU 6.283185307179586
#define MAX_RIPPLES ${MAX_RIPPLES}

uniform mat4  uViewProj;
uniform vec3  uCam;
uniform float uTime;
uniform vec2  uRes;          // render-target size, in render pixels
uniform float uPixelScale;   // render pixels per world unit at unit depth
uniform float uMinPx;        // smallest point we allow before trading size for light

uniform sampler2D uSpec;     // row 0 spectrum, row 1 peaks, row 2 waveform
uniform float uLevel, uBass, uLowMid, uMid, uHigh, uAir, uCentroid, uBeat;
uniform float uIdle;   // 1 when silent, 0 when playing
uniform float uIntensity;

uniform vec3  uPal[5];
uniform vec4  uRipples[MAX_RIPPLES];   // xy origin, z birth time, w amplitude

uniform float uLoopW;      // TAU / loop period
uniform float uRadius;
uniform float uSpecAmp;
uniform int   uOctaves;
uniform int   uFamA;
uniform int   uFamB;
uniform vec4  uPA0, uPA1;  // design A's four-plus-four parameters
uniform vec4  uPB0, uPB1;  // design B's, during a cross-fade
uniform float uMorph;      // 0 = A, 1 = B

/* ── seamless clock ───────────────────────────────────────────
   uTime is wrapped to a fixed period so it never loses float
   precision, however long the page runs. Everything that moves
   is driven through pphase(): with an integer multiplier the
   phase lands exactly back on itself at the wrap, so the loop
   has no seam and the field can run for days.               */
float pphase(float n){ return uTime * uLoopW * n; }
vec3  pdrift(float a, float b, float c){
  return vec3(cos(pphase(a)), sin(pphase(b)), cos(pphase(c)));
}

/* ── simplex noise (Ashima / Gustavson, MIT) ─────────────── */
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j  = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x  = x_ * ns.x + ns.yyyy;
  vec4 y  = y_ * ns.x + ns.yyyy;
  vec4 h  = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

/* Curl of a noise potential — divergence-free, so the field swirls
   instead of clumping. This is what makes the motion feel alive.

   The full version costs twelve simplex evaluations per call, which a
   desktop GPU shrugs off and a phone absolutely does not. Under CHEAP we
   swap in a trig field: not divergence-free, but it swirls convincingly
   at a twentieth of the cost, and at these amplitudes the difference is
   not visible. */
#ifdef CHEAP
vec3 curl(vec3 p, float e){
  float a = sin(p.y * 1.7 + p.z * 1.1 + 0.7);
  float b = sin(p.z * 1.3 - p.x * 1.9 + 2.1);
  float c = sin(p.x * 1.5 + p.y * 0.9 + 4.2);
  return normalize(vec3(a - c, b - a, c - b) + 1e-6);
}
#else
vec3 curl(vec3 p, float e){
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  float x0 = snoise(p - dx), x1 = snoise(p + dx);
  float y0 = snoise(p - dy), y1 = snoise(p + dy);
  float z0 = snoise(p - dz), z1 = snoise(p + dz);
  vec3 q = p + vec3(31.4, 17.9, 53.1);
  float X0 = snoise(q - dx), X1 = snoise(q + dx);
  float Y0 = snoise(q - dy), Y1 = snoise(q + dy);
  float Z0 = snoise(q - dz), Z1 = snoise(q + dz);
  return normalize(vec3(
    (y1 - y0) - (Z1 - Z0),
    (z1 - z0) - (X1 - X0),
    (x1 - x0) - (Y1 - Y0)
  ) + 1e-6);
}
#endif

/* ── audio sampling (exact texel lerp: no filtering extension needed) ── */
float fetchRow(float x, int row){
  float fx = clamp(x, 0.0, 1.0) * 255.0;
  int  i0 = int(floor(fx));
  int  i1 = min(i0 + 1, 255);
  float f = fx - float(i0);
  float a = texelFetch(uSpec, ivec2(i0, row), 0).r;
  float b = texelFetch(uSpec, ivec2(i1, row), 0).r;
  return mix(a, b, f);
}
float spec(float x){ return fetchRow(x, 0); }
float peak(float x){ return fetchRow(x, 1); }
float wave(float x){ return fetchRow(x, 2) * 2.0 - 1.0; }

/* ── travelling wave packet: a ring that expands, oscillates and dies ── */
float rippleField(vec2 p, float speed, float width, float freq, float life){
  float h = 0.0;
  for(int i = 0; i < MAX_RIPPLES; i++){
    vec4 r = uRipples[i];
    float age = uTime - r.z;
    if(r.w <= 0.0 || age < 0.0 || age > life) continue;
    float d     = distance(p, r.xy);
    float x     = d - age * speed;
    float env   = exp(-x * x * width) * (1.0 - age / life);
    float atten = 1.0 / (1.0 + d * 0.42);
    h += r.w * env * atten * sin(x * freq);
  }
  return h;
}
float rippleRadial(float d, float speed, float width, float freq, float life){
  float h = 0.0;
  for(int i = 0; i < MAX_RIPPLES; i++){
    vec4 r = uRipples[i];
    float age = uTime - r.z;
    if(r.w <= 0.0 || age < 0.0 || age > life) continue;
    float x   = d - age * speed;
    float env = exp(-x * x * width) * (1.0 - age / life);
    h += r.w * env * sin(x * freq);
  }
  return h;
}

/* ── palette: five stops, smoothstep-interpolated ─────────── */
vec3 palette(float t){
  t = clamp(t, 0.0, 0.9999) * 4.0;
  int  i = int(floor(t));
  float f = t - float(i);
  f = f * f * (3.0 - 2.0 * f);
  return mix(uPal[i], uPal[i + 1], f);
}

/* ── sizing rule ──────────────────────────────────────────────
   A point smaller than a pixel cannot be drawn smaller — it just
   flickers. So we floor the size and pay back the difference in
   brightness. Total energy is preserved, and the field stays
   razor-sharp no matter how far we supersample.               */
float sizeWithEnergy(float px, inout float bright){
  float s = max(px, uMinPx);
  bright *= (px * px) / (s * s);
  return s;
}

/* Deterministic per-particle randomness from a seed vector. */
float hash11(float p){
  p = fract(p * 0.1031); p *= p + 33.33; p *= p + p;
  return fract(p);
}
`;

/* ============================================================
   FORMS — the particle designs. Every mode maps the same
   (direction, seed) pair onto a different geometry, so one
   buffer serves them all and any two can be cross-faded.
   ============================================================ */
export const FORMS = /* glsl */`
struct Form {
  vec3  pos;
  vec3  nrm;
  float energy;
  float size;
  float tone;
  float gain;   // per-design exposure: concentrated forms need less
  float rim;    // how much silhouette weighting suits this geometry
  vec3  tng;    // curve tangent, for designs built from strands
  float aniso;  // 1 = compensate for projected density along that tangent
};

/* Frequency for a point, scattered slightly so a meridian of points
   doesn't collapse into a hard vertical stripe. */
float bandOf(vec3 dir, vec4 seed){
  float az = atan(dir.z, dir.x);
  float b  = pow(abs(az) / PI, 0.78);
  #ifdef CHEAP
  float scatter = sin(dir.x * 9.1 + dir.y * 5.3 + dir.z * 7.7) * 0.030;
  #else
  float scatter = snoise(dir * 2.6) * 0.030;
  #endif
  return clamp(b + (seed.w - 0.5) * 0.045 + scatter + dir.y * 0.020, 0.0, 1.0);
}

/* Silence still breathes — a slow travelling swell across the bands. */
float energyAt(float band, vec3 dir){
  return spec(band) + uIdle * (0.30 + 0.30 * sin(band * 13.0 - pphase(186.0)
              + snoise(dir * 1.1 + pdrift(14.0, 11.0, 17.0) * 0.6) * 2.2)) * 0.46;
}

Form baseForm(){
  Form f;
  f.pos = vec3(0.0); f.nrm = vec3(0.0, 1.0, 0.0);
  f.energy = 0.0; f.size = 1.0; f.tone = 0.0;
  f.gain = 1.0; f.rim = 1.0; f.tng = vec3(0.0, 1.0, 0.0); f.aniso = 0.0;
  return f;
}

/* ═══════════════════════════════════════════════════════════
   FAMILIES

   Fifty separate shader functions would be fifty near-duplicates
   and a compile time no phone would forgive. These eight are
   parameterised instead: every design is a family plus four
   numbers, so the variety lives in data and the shader stays
   small enough to link quickly.
   ═══════════════════════════════════════════════════════════ */

/* ── 0 · SHELL — a hollow crumpled sphere.
      p = [fold, crumple frequency, thickness, radius]        ── */
Form fShell(vec3 dir, vec4 seed, vec4 p, vec4 q){
  Form f = baseForm();
  float band = bandOf(dir, seed);
  band = fract(band * p.x);                       // fold: repeats the spectrum
  float a  = energyAt(band, dir);
  float pk = peak(band);

  vec3 tOff = pdrift(9.0, 7.0, 11.0) * 1.15;
  float n1 = snoise(dir * p.y + tOff);
  float n2 = (uOctaves > 1) ? snoise(dir * p.y * 2.5 - tOff * 1.4) : 0.0;
  float n3 = (uOctaves > 2) ? snoise(dir * p.y * 5.6 + tOff * 2.1) : 0.0;
  float crumple = (n1 * 0.105 + n2 * 0.038 + n3 * 0.013) * q.x;

  float lat = 1.0 - pow(abs(dir.y), 2.6) * 0.45;
  float sh  = seed.x * 2.0 - 1.0;
  float thick = sign(sh) * pow(abs(sh), 2.4) * p.z;

  float r = uRadius * p.w * (1.0 + crumple) + thick
          + a * uSpecAmp * lat * (0.60 + 0.55 * n1)
          + uBass * 0.19 + uBeat * 0.055;
  r += rippleRadial(r, 2.35, 5.0, 7.0, 2.6) * 0.16;

  vec3 pos = dir * r;
  pos += curl(dir * 1.25 + pdrift(13.0, 9.0, 15.0) * 0.5, 0.38)
       * (0.030 + a * 0.085 + uLevel * 0.030) * q.y;
  pos += dir * sin(pphase(80.0 + floor(seed.y * 60.0))) * (0.008 + a * 0.020);

  f.pos = pos; f.nrm = dir;
  f.energy = a * 0.75 + pk * 0.25;
  f.size = 0.8 + seed.y * 1.4;
  return f;
}

/* ── 1 · CORONA — a radial fountain.
      p = [swirl, height, base radius, spread]                ── */
Form fCorona(vec3 dir, vec4 seed, vec4 p, vec4 q){
  Form f = baseForm();
  float az = atan(dir.z, dir.x);
  float band = fract(bandOf(dir, seed) * q.x);
  float a = energyAt(band, dir);

  float u  = pow(seed.x, 1.7);
  float th = az + u * p.x + pphase(6.0);
  float r  = p.z + u * p.w + a * 0.95 + uBass * 0.10;
  float y  = -1.72 + pow(u, 1.35) * (0.50 + a * p.y + uLevel * 0.5);

  vec3 pos = vec3(cos(th) * r, y, sin(th) * r);
  pos += curl(pos * 0.6 + pdrift(11.0, 13.0, 7.0) * 0.6, 0.4)
       * (0.04 + u * 0.30 * (0.3 + a));
  pos.y += rippleRadial(r, 2.4, 4.0, 6.5, 3.0) * 0.30;

  f.pos = pos;
  f.nrm = normalize(vec3(cos(th), 0.35, sin(th)));
  f.energy = (a * 0.85 + peak(band) * 0.25) * (1.0 - u * 0.35);
  f.size = 0.7 + seed.y * 1.2 + (1.0 - u) * 0.6;
  f.tone = u * 0.18; f.gain = 0.92; f.rim = 0.50;
  return f;
}

/* ── 2 · CHLADNI — a vibrating plate. Particles relax onto the
      nodal lines, which is very nearly what sand does.
      p = [n1, m1, n2, m2]                                    ── */
float chladni(vec2 pt, float n, float m){
  return cos(n * PI * pt.x) * cos(m * PI * pt.y)
       - cos(m * PI * pt.x) * cos(n * PI * pt.y);
}
vec4 gPlate;
float plateH(vec2 pt){
  float lo = spec(0.07) + uIdle * 0.22, ml = spec(0.20) + uIdle * 0.15;
  float mh = spec(0.40) + uIdle * 0.10, hi = spec(0.64) + uIdle * 0.06;
  return chladni(pt, gPlate.x, gPlate.y) * (0.30 + lo * 1.5)
       + chladni(pt, gPlate.z, gPlate.w) * (0.20 + ml * 1.3)
       + chladni(pt, gPlate.x + 2.0, gPlate.w + 3.0) * (0.14 + mh * 1.1)
       + chladni(pt, gPlate.z + 3.0, gPlate.y + 5.0) * (0.09 + hi * 0.9);
}
Form fChladni(vec3 dir, vec4 seed, vec4 p, vec4 q){
  Form f = baseForm();
  gPlate = p;
  vec2 pt = vec2(seed.x, seed.y) * 2.0 - 1.0;

  const float e = 0.012;
  #ifdef CHEAP
  const int STEPS = 1;
  #else
  const int STEPS = 2;
  #endif
  for(int i = 0; i < STEPS; i++){
    float h = plateH(pt);
    vec2  g = vec2(plateH(pt + vec2(e,0.0)) - h, plateH(pt + vec2(0.0,e)) - h) / e;
    pt -= g * h / (dot(g, g) + 0.45) * 0.72;
  }
  pt = clamp(pt, -1.0, 1.0);

  float h = plateH(pt);
  float rot = pphase(4.0);
  vec2 qq = vec2(pt.x * cos(rot) - pt.y * sin(rot),
                 pt.x * sin(rot) + pt.y * cos(rot)) * q.x;

  vec3 pos = vec3(qq.x, -0.02 + h * 0.34 + uBass * 0.24, qq.y);
  pos.y += rippleField(qq, 2.85, 3.4, 6.0, 3.3) * 0.55;
  pos += curl(pos * 0.5 + pdrift(7.0, 5.0, 9.0) * 0.4, 0.45) * 0.035;

  float node = 1.0 - clamp(abs(h) * 1.6, 0.0, 1.0);
  f.pos = pos;
  f.nrm = normalize(vec3(qq.x * 0.30, 1.0, qq.y * 0.30));
  f.energy = node * (0.34 + uLevel * 0.85 + uBass * 0.40) + spec(0.3) * 0.16;
  f.size = 0.5 + seed.z * 0.7 + node * 0.8;
  f.tone = 0.04; f.gain = 0.42; f.rim = 0.20;
  return f;
}

/* ── 3 · KNOT — one curve wound through space. q = 0 gives an
      open helix, anything else a torus knot: (2,3) is a
      trefoil, (3,2) a different one, and so on for dozens.
      p = [p winding, q winding, tube radius, turns]          ── */
Form fKnot(vec3 dir, vec4 seed, vec4 pr, vec4 q){
  Form f = baseForm();
  float t = seed.x;
  float a = spec(t) + uIdle * 0.12;
  float w = wave(t);
  float strand = step(0.5, seed.w) * q.y;          // optional second strand

  vec3 c, tang;
  float spin = pphase(12.0);

  if(pr.y < -0.5){
    // open helix
    float ang = t * TAU * pr.w + strand * PI + spin;
    float rad = 1.20 + w * 0.40 + a * 0.52;
    c = vec3(cos(ang) * rad, (t - 0.5) * 3.0 + w * 0.16, sin(ang) * rad);
    tang = normalize(vec3(-sin(ang), 3.0 / (TAU * pr.w), cos(ang)));
  } else {
    // torus knot
    float u = t * TAU * pr.w + spin;
    float cq = cos(pr.y * u), sq = sin(pr.y * u);
    float R  = 1.05 + a * 0.30;
    c = vec3((2.0 + cq) * cos(pr.x * u), sq * 1.15, (2.0 + cq) * sin(pr.x * u)) * R * 0.52;
    float d = 0.01;
    float u2 = u + d;
    vec3 c2 = vec3((2.0 + cos(pr.y*u2)) * cos(pr.x*u2), sin(pr.y*u2) * 1.15,
                   (2.0 + cos(pr.y*u2)) * sin(pr.x*u2)) * R * 0.52;
    tang = normalize(c2 - c + 1e-5);
  }

  /* Cross-section frame. Picking an up-vector and crossing with it flips
     wherever the tangent passes vertical, and the tube visibly twists and
     clumps at the flip. Anchoring the frame to the axis instead — one
     Gram-Schmidt step against the radial direction — keeps it stable all
     the way round. */
  vec3 radial = normalize(vec3(c.x, 0.0, c.z) + vec3(1e-4, 0.0, 1e-4));
  vec3 n1 = normalize(radial - tang * dot(radial, tang) + 1e-5);
  vec3 n2 = cross(tang, n1);

  float ct = seed.y * TAU + q.z * pphase(9.0);   // q.z spins the tube
  float cr = pow(seed.z, 0.6) * (pr.z + a * 0.15);
  vec3 pos = c + (n1 * cos(ct) + n2 * sin(ct)) * cr;

  // A share of the points bridge the two strands, so a pair reads as one
  // structure rather than two unrelated springs.
  if(q.w > 0.5 && seed.w > 0.80){
    float ang2 = t * TAU * pr.w + spin;
    float rr = 1.20 + wave(t) * 0.40 + spec(t) * 0.52;
    vec3 ra = vec3(cos(ang2), 0.0, sin(ang2));
    pos = mix(ra * rr, -ra * rr, fract(seed.z * 7.13))
        + vec3(0.0, (t - 0.5) * 3.0 + (seed.y - 0.5) * 0.045, 0.0);
    a *= 0.7;
  }

  pos += curl(pos * 0.7 + pdrift(9.0, 15.0, 11.0) * 0.5, 0.42) * (0.02 + a * 0.10);

  float endFade = pr.y < -0.5
    ? smoothstep(0.0, 0.07, t) * (1.0 - smoothstep(0.93, 1.0, t))
    : 1.0;

  f.pos = pos; f.nrm = n1;
  f.tng = tang; f.aniso = 1.0;
  f.energy = (abs(w) * 1.00 + a * 0.85) * endFade;
  f.size = (0.70 + seed.y * 1.0 + abs(w) * 1.2) * (0.45 + endFade * 0.55);
  f.tone = 0.02 + abs(w) * 0.24;
  f.gain = q.x * endFade; f.rim = 0.14;
  return f;
}

/* ── 4 · ROSE — concentric rose curves, or petals that open.
      p = [petals, rings, lift, mode 0=flat 1=petalled]       ── */
Form fRose(vec3 dir, vec4 seed, vec4 p, vec4 q){
  Form f = baseForm();
  float rings = p.y;
  float ringI = floor(seed.x * rings);
  float ring  = ringI / max(1.0, rings - 1.0);
  float a     = energyAt(ring, dir);

  if(p.w < 0.5){
    // flat mandala
    float petals = p.x + ringI * 2.0;
    float th = seed.y * TAU + pphase(3.0) * (1.0 + ringI * 0.10);
    float rose = 0.5 + 0.5 * cos(petals * th);
    float r = 0.45 + ring * q.x + rose * (0.18 + a * 0.85);
    float y = (rose - 0.5) * (0.10 + a * 0.45) * p.z + (seed.z - 0.5) * 0.05;

    vec3 pos = vec3(cos(th) * r, y, sin(th) * r);
    pos.y += rippleField(pos.xz, 2.85, 3.4, 6.0, 3.3) * 0.30;
    f.pos = pos;
    f.nrm = normalize(vec3(cos(th) * 0.3, 1.0, sin(th) * 0.3));
    f.energy = a * (0.45 + rose * 0.85);
    f.size = 0.5 + seed.z * 0.75 + rose * 0.9;
    f.tone = 0.03 + ring * 0.22;
    f.gain = 0.60; f.rim = 0.18;
  } else {
    // petals that open
    float petals = p.x + ringI * 4.0;
    float th    = seed.y * TAU + ringI * 0.35 + pphase(2.0);
    float idx   = floor(th / TAU * petals);
    float local = fract(th / TAU * petals) * 2.0 - 1.0;

    float open  = 0.35 + a * 0.95 + uLevel * 0.30;
    float along = pow(seed.z, 0.7);
    float width = (1.0 - local * local) * (1.0 - along * 0.72);

    float baseA = (idx + 0.5) / petals * TAU;
    float curve = sin(along * PI * 0.86);
    float r     = (0.30 + ring * 0.45) + curve * (0.62 + ring * 0.62) * q.x;
    float lift  = (1.0 - cos(along * PI * 0.80)) * open * (0.85 - ring * 0.34) * p.z;

    vec3 tangent = vec3(-sin(baseA), 0.0, cos(baseA));
    vec3 pos = vec3(cos(baseA) * r, lift - 0.45 + ring * 0.15, sin(baseA) * r)
             + tangent * local * width * (0.16 + ring * 0.20);

    f.pos = pos;
    f.nrm = normalize(vec3(cos(baseA) * 0.6, 0.8, sin(baseA) * 0.6));
    f.energy = a * (0.35 + width);
    f.size = 0.48 + seed.w * 0.75 + width * 0.95;
    f.tone = 0.05 + ring * 0.26;
    f.tng = normalize(vec3(cos(baseA), 0.55, sin(baseA)));
    f.aniso = 0.85; f.gain = 0.92; f.rim = 0.14;
  }
  return f;
}

/* ── 5 · CURTAIN — sheets of light, swaying or falling.
      p = [sheets, sway, fall 0..1, width]                    ── */
Form fCurtain(vec3 dir, vec4 seed, vec4 p, vec4 q){
  Form f = baseForm();
  float sheet = floor(seed.w * p.x);
  float u     = seed.x * 2.0 - 1.0;
  float band  = clamp(abs(u) * 0.92 + 0.04, 0.0, 1.0);
  float a     = energyAt(band, dir);
  float t     = pphase(7.0);

  if(p.z < 0.5){
    // aurora: standing sheets that sway
    float sway = sin(u * 2.3 + t + sheet * 1.7) * p.y
               + sin(u * 5.1 - t * 1.3 + sheet) * p.y * 0.36;
    float h = pow(seed.y, 1.35);
    float height = 1.5 + a * 2.7 + uLevel * 0.7;
    f.pos = vec3(u * p.w + sin(h * 3.0 + t * 1.2 + sheet) * 0.30 * h,
                 -1.6 + h * height,
                 sway + (sheet - p.x * 0.5 + 0.5) * 0.85);
    f.nrm = vec3(0.0, 0.0, 1.0);
    f.energy = a * (1.0 - h * 0.5);
    f.size = 0.55 + seed.z * 0.85;
    f.tone = 0.04 + h * 0.34;
    f.gain = 0.66; f.rim = 0.10;
    f.tng = vec3(1.0, 0.0, 0.0);
  } else {
    // veil: rain. Lifetimes are quantised so the fall stays seamless
    // across the clock wrap, exactly as the wisps are.
    const float LIFE = 6.0;
    float rate = 1.0 + floor(seed.w * 3.0) * 0.5;
    float age  = mod(uTime * rate + seed.z * LIFE, LIFE);
    float uu   = age / LIFE;

    float x = u * p.w + sin(pphase(5.0) + seed.y * TAU) * 0.22;
    float z = (seed.y * 2.0 - 1.0) * p.w * 0.72;
    float y = mix(2.9, -2.5, uu) + a * 0.35 * sin(uu * PI);

    float fade = smoothstep(0.0, 0.08, uu) * (1.0 - smoothstep(0.86, 1.0, uu));
    float edge = exp(-x * x * 0.058) * exp(-z * z * 0.10);
    float streak = 0.55 + (rate - 1.0) * 0.9;

    f.pos = vec3(x, y, z);
    f.nrm = vec3(0.0, 1.0, 0.0);
    f.energy = a * fade * edge * (0.45 + 0.55 * sin(uu * PI));
    f.size = (0.45 + seed.z * 0.8 + a * 1.0) * fade * streak;
    f.tone = 0.06 + uu * 0.20;
    f.gain = 1.15 * fade * edge; f.rim = 0.12;
    f.tng = vec3(0.0, 1.0, 0.0);
  }
  return f;
}

/* ── 6 · LISSAJOUS — three sine ratios traced in space. Small
      whole-number ratios give the classic woven figures.
      p = [a, b, c, phase]                                    ── */
Form fLissa(vec3 dir, vec4 seed, vec4 p, vec4 q){
  Form f = baseForm();
  float t = seed.x * TAU;
  float a = spec(seed.x) + uIdle * 0.12;
  float w = wave(seed.x);
  float ph = p.w + pphase(2.0);

  vec3 c = vec3(sin(p.x * t + ph), sin(p.y * t), sin(p.z * t + ph * 0.5))
         * (1.45 + a * 0.45 + uBass * 0.12);

  float d = 0.008;
  vec3 c2 = vec3(sin(p.x*(t+d) + ph), sin(p.y*(t+d)), sin(p.z*(t+d) + ph*0.5))
          * (1.45 + a * 0.45 + uBass * 0.12);
  vec3 tang = normalize(c2 - c + 1e-5);

  float ct = seed.y * TAU, cr = pow(seed.z, 0.6) * (q.x + a * 0.12);
  vec3 radial = normalize(vec3(c.x, 0.0, c.z) + vec3(1e-4, 0.0, 1e-4));
  vec3 n1 = normalize(radial - tang * dot(radial, tang) + 1e-5);
  vec3 n2 = cross(tang, n1);
  vec3 pos = c + (n1 * cos(ct) + n2 * sin(ct)) * cr;

  f.pos = pos; f.nrm = n1;
  f.tng = tang; f.aniso = 1.0;
  f.energy = abs(w) * 0.8 + a * 0.9;
  f.size = 0.65 + seed.y * 0.9 + abs(w) * 1.1;
  f.tone = 0.03 + abs(w) * 0.22;
  f.gain = 1.05; f.rim = 0.14;
  return f;
}

/* ── 7 · SUPERSHAPE — Gielis's superformula on a sphere. Four
      numbers walk it from a star to a flower to a bulb; this
      one family carries most of the organic designs.
      p = [m, n1, n2, n3]                                     ── */
float superR(float phi, vec4 p){
  float t = p.x * phi * 0.25;
  float a = pow(abs(cos(t)), p.z);
  float b = pow(abs(sin(t)), p.w);
  return pow(a + b, -1.0 / max(0.15, p.y));
}
Form fSuper(vec3 dir, vec4 seed, vec4 p, vec4 q){
  Form f = baseForm();
  float band = bandOf(dir, seed);
  float amp  = energyAt(band, dir);

  float theta = atan(dir.z, dir.x);
  float phi   = asin(clamp(dir.y, -1.0, 1.0));

  float r1 = superR(theta, p);
  float r2 = superR(phi, vec4(q.y, p.y, p.z, p.w));

  vec3 pos = vec3(r1 * cos(theta) * r2 * cos(phi),
                  r2 * sin(phi),
                  r1 * sin(theta) * r2 * cos(phi));
  pos *= q.x * (1.0 + amp * 0.55 + uBass * 0.14);

  float sh = seed.x * 2.0 - 1.0;
  pos += normalize(pos + 1e-5) * sign(sh) * pow(abs(sh), 2.4) * 0.18;
  pos += curl(pos * 0.9 + pdrift(13.0, 9.0, 15.0) * 0.5, 0.40) * (0.03 + amp * 0.08);

  f.pos = pos;
  f.nrm = normalize(pos + 1e-5);
  f.energy = amp * 0.8 + peak(band) * 0.2;
  f.size = 0.7 + seed.y * 1.2;
  f.tone = 0.02;
  f.gain = 0.85; f.rim = 0.75;
  return f;
}

Form formOf(int fam, vec3 dir, vec4 seed, vec4 p, vec4 q){
  if(fam == 1) return fCorona(dir, seed, p, q);
  if(fam == 2) return fChladni(dir, seed, p, q);
  if(fam == 3) return fKnot(dir, seed, p, q);
  if(fam == 4) return fRose(dir, seed, p, q);
  if(fam == 5) return fCurtain(dir, seed, p, q);
  if(fam == 6) return fLissa(dir, seed, p, q);
  if(fam == 7) return fSuper(dir, seed, p, q);
  return fShell(dir, seed, p, q);
}

Form formBlend(vec3 dir, vec4 seed){
  if(uMorph <= 0.002) return formOf(uFamA, dir, seed, uPA0, uPA1);
  if(uMorph >= 0.998) return formOf(uFamB, dir, seed, uPB0, uPB1);
  Form a = formOf(uFamA, dir, seed, uPA0, uPA1);
  Form b = formOf(uFamB, dir, seed, uPB0, uPB1);
  float k = uMorph * uMorph * (3.0 - 2.0 * uMorph);
  // Stagger each particle slightly so the change sweeps through the field
  // instead of every point snapping at once.
  k = clamp((k - seed.z * 0.28) / 0.72, 0.0, 1.0);
  k = k * k * (3.0 - 2.0 * k);
  Form f;
  f.pos    = mix(a.pos, b.pos, k);
  f.nrm    = normalize(mix(a.nrm, b.nrm, k) + 1e-5);
  f.energy = mix(a.energy, b.energy, k);
  f.size   = mix(a.size, b.size, k);
  f.tone   = mix(a.tone, b.tone, k);
  f.gain   = mix(a.gain, b.gain, k);
  f.rim    = mix(a.rim, b.rim, k);
  f.tng    = normalize(mix(a.tng, b.tng, k) + 1e-5);
  f.aniso  = mix(a.aniso, b.aniso, k);
  return f;
}
`;

/* ── shared particle fragment shader ─────────────────────────
   A tight gaussian core inside a soft halo. The core keeps every
   point crisp at 8K; the halo gives the field its glow.        */
export const POINT_FS = /* glsl */`#version 300 es
precision highp float;
in vec3  vCol;
in float vAlpha;
in float vCore;
out vec4 frag;

void main(){
  vec2  d  = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if(r2 > 1.0) discard;

  float core = exp(-r2 * 11.0);
  float halo = exp(-r2 * 2.35);
  float a    = core * vCore + halo * (1.0 - vCore * 0.5);
  a *= smoothstep(1.0, 0.68, sqrt(r2));

  frag = vec4(vCol * (a * vAlpha), 1.0);
}`;

/* ============================================================
   FORM PASS — the hero geometry, whichever design is active.
   Brightness is Fresnel-weighted so the silhouette densifies and
   the centre stays open. A second, mirrored pass draws its
   reflection in the water plane.
   ============================================================ */
export const SHELL_VS = /* glsl */`#version 300 es
${COMMON}
${FORMS}
in vec3 aDir;
in vec4 aSeed;

uniform float uMirror;    // 0 normal pass, 1 reflected
uniform float uMirrorY;

out vec3  vCol;
out float vAlpha;
out float vCore;

void main(){
  vec3 dir = normalize(aDir);
  Form f = formBlend(dir, aSeed);
  vec3 pos = f.pos;

  float mirrorFade = 1.0;
  if(uMirror > 0.5){
    pos.y = 2.0 * uMirrorY - pos.y;
    pos.xz += vec2(snoise(vec3(pos.xz * 1.4, pphase(510.0)))) * 0.045;
    mirrorFade = 0.26 * exp(-max(0.0, uMirrorY - pos.y) * 0.55);
  }

  vec4 view = uViewProj * vec4(pos, 1.0);

  vec3  V    = normalize(uCam - pos);
  float fres = 1.0 - abs(dot(f.nrm, V));
  float rim  = pow(clamp(fres, 0.0, 1.0), 1.45) * f.rim;

  float energy = f.energy;
  float bright = (0.155 + rim * 0.54 + energy * 0.92 + uBeat * 0.12)
               * (0.45 + aSeed.z * 0.95) * uIntensity * f.gain;

  if(f.aniso > 0.0){
    float along = abs(dot(f.tng, V));
    bright *= mix(1.0, 1.0 - along * 0.70, f.aniso);
  }

  float tone = 0.02 + f.tone + pow(max(energy, 0.0), 1.30) * 0.54 + rim * 0.29
             + uCentroid * 0.14 + (aSeed.w - 0.5) * 0.24;
  vCol  = palette(clamp(tone, 0.0, 1.0));
  vCore = clamp(0.35 + energy * 0.5 + rim * 0.25, 0.0, 1.0);

  float px = (f.size + energy * 2.4) * uPixelScale / max(0.35, view.w);
  if(uMirror > 0.5){ px *= 2.1; vCore *= 0.30; bright *= mirrorFade; }

  gl_PointSize = sizeWithEnergy(px, bright);
  vAlpha = bright;
  gl_Position = view;
}`;

/* ============================================================
   WISPS — tendrils peeling off whatever form is active, born and
   dying continuously so the image never sets.
   Lifetimes are quantised so the cycle stays seamless across the
   clock wrap: rate * loopPeriod is always a whole number of lives.
   ============================================================ */
export const WISP_VS = /* glsl */`#version 300 es
${COMMON}
${FORMS}
in vec3 aDir;
in vec4 aSeed;

out vec3  vCol;
out float vAlpha;
out float vCore;

void main(){
  vec3 dir = normalize(aDir);
  Form f = formBlend(dir, aSeed);

  const float LIFE = 6.0;
  float rate = 1.0 + floor(aSeed.y * 3.0) * 0.5;      // 1.0, 1.5 or 2.0
  float age  = mod(uTime * rate + aSeed.z * LIFE, LIFE);
  float u    = age / LIFE;

  float a = f.energy;
  vec3 pos  = f.pos;
  vec3 flow = curl(dir * 0.95 + pdrift(7.0, 11.0, 5.0) * 0.55, 0.42);

  float reach = (0.35 + aSeed.w * 1.15) * (0.45 + a * 1.5 + uLevel * 0.8);
  pos += flow  * reach * u * 1.35;
  pos += f.nrm * reach * u * 0.75;

  vec4 view = uViewProj * vec4(pos, 1.0);

  float fade = smoothstep(0.0, 0.10, u) * (1.0 - smoothstep(0.35, 1.0, u));
  float bright = fade * (0.26 + a * 0.90 + uBeat * 0.16)
               * (0.35 + aSeed.z * 0.85) * uIntensity * 0.70 * f.gain;

  vCol  = palette(clamp(0.24 + a * 0.44 + u * 0.28 + uCentroid * 0.18, 0.0, 1.0));
  vCore = 0.28 + a * 0.35;

  float px = (0.55 + aSeed.y * 0.9 + a * 1.4) * uPixelScale / max(0.35, view.w);
  gl_PointSize = sizeWithEnergy(px, bright);
  vAlpha = bright;
  gl_Position = view;
}`;

/* ============================================================
   RIPPLE PLANE — the surface the sound falls on. Concentric wave
   packets spawn on every onset and travel outward; particles ride
   the crests and brighten with the slope.
   ============================================================ */
export const RIPPLE_VS = /* glsl */`#version 300 es
${COMMON}
in vec2 aXZ;
in vec4 aSeed;

uniform float uPlaneY;
uniform float uRippleAmp;

out vec3  vCol;
out float vAlpha;
out float vCore;

void main(){
  vec2  p = aXZ;
  float d = length(p);

  float h  = rippleField(p, 2.85, 3.4, 6.0, 3.3);
  float hx = rippleField(p + vec2(0.07, 0.0), 2.85, 3.4, 6.0, 3.3);
  float hz = rippleField(p + vec2(0.0, 0.07), 2.85, 3.4, 6.0, 3.3);
  float slope = length(vec2(hx - h, hz - h)) / 0.07;

  // A whisper of swell keeps the surface alive between onsets. Any more and
  // it stops reading as water and starts reading as terrain.
  float swell = sin(d * 1.05 - pphase(114.0)) * 0.016 * (0.3 + uLevel * 0.8);

  float y = uPlaneY + (h * uRippleAmp + swell) * (0.62 + uLevel * 0.8);

  vec3 pos = vec3(p.x, y, p.y);
  vec4 view = uViewProj * vec4(pos, 1.0);

  float falloff = exp(-d * 0.098) * smoothstep(0.0, 0.9, d);
  // Sharpen the response so troughs stay dark and only the wavefronts light
  // up — that is what makes an expanding ring legible as a ring.
  float crest   = pow(clamp(abs(h) * 2.35 + slope * 0.30, 0.0, 1.0), 1.7);
  float bright  = (0.010 + crest * 1.45 + uLevel * 0.022)
                * falloff * (0.4 + aSeed.x * 0.85) * uIntensity * 0.9;

  vCol  = palette(clamp(0.02 + crest * 0.70 + uCentroid * 0.10
                        + (aSeed.w - 0.5) * 0.12, 0.0, 1.0));
  vCore = 0.26 + crest * 0.5;

  float px = (0.5 + aSeed.y * 0.8 + crest * 1.3) * uPixelScale / max(0.35, view.w);
  gl_PointSize = sizeWithEnergy(px, bright);
  vAlpha = bright;
  gl_Position = view;
}`;

/* ============================================================
   DUST — sparse volumetric depth. Barely visible, entirely
   responsible for the image feeling like a space rather than a
   flat graphic.
   ============================================================ */
export const DUST_VS = /* glsl */`#version 300 es
${COMMON}
in vec3 aPos;
in vec4 aSeed;

out vec3  vCol;
out float vAlpha;
out float vCore;

void main(){
  vec3 pos = aPos;
  vec3 flow = curl(pos * 0.16 + pdrift(4.0, 3.0, 5.0) * 0.9, 0.5);
  pos += flow * (0.55 + uLevel * 0.85);
  pos.y += sin(pphase(26.0) + aSeed.x * TAU) * 0.22;

  vec4 view = uViewProj * vec4(pos, 1.0);

  float d    = length(pos);
  float twk  = 0.55 + 0.45 * sin(pphase(114.0 + floor(aSeed.y * 292.0)) + aSeed.z * TAU);
  float bright = (0.030 + uLevel * 0.045 + uBeat * 0.022)
               * twk * (0.25 + aSeed.w) * exp(-d * 0.055) * uIntensity;

  vCol  = palette(clamp(0.06 + aSeed.z * 0.22 + uCentroid * 0.12, 0.0, 1.0));
  vCore = 0.5;

  float px = (0.45 + aSeed.y * 0.7) * uPixelScale / max(0.35, view.w);
  gl_PointSize = sizeWithEnergy(px, bright);
  vAlpha = bright;
  gl_Position = view;
}`;

/* ============================================================
   SPARKS — transient bursts. Motion is integrated analytically
   from the launch state, so emitting costs one small buffer write
   and the GPU does the rest.
   ============================================================ */
export const SPARK_VS = /* glsl */`#version 300 es
${COMMON}
in vec3  aPos0;
in vec3  aVel0;
in vec4  aMeta;   // x birth, y life, z hue, w size

out vec3  vCol;
out float vAlpha;
out float vCore;

void main(){
  float age = uTime - aMeta.x;
  if(aMeta.y <= 0.0 || age < 0.0 || age > aMeta.y){
    gl_Position  = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vCol = vec3(0.0); vAlpha = 0.0; vCore = 0.0;
    return;
  }

  // closed-form drag: p = p0 + v0 * (1 - e^-kt) / k
  const float k = 1.35;
  float damp = (1.0 - exp(-k * age)) / k;
  vec3 pos = aPos0 + aVel0 * damp;
  pos.y   -= 0.30 * age * age;                        // a little gravity
  pos += curl(pos * 0.55 + pdrift(19.0, 23.0, 17.0) * 0.8, 0.45) * age * 0.16;

  vec4 view = uViewProj * vec4(pos, 1.0);

  float u    = age / aMeta.y;
  float fade = (1.0 - u) * (1.0 - u) * smoothstep(0.0, 0.04, u);
  float bright = fade * (1.35 + aMeta.w * 0.9) * uIntensity;

  vCol  = palette(clamp(0.55 + aMeta.z * 0.42 - u * 0.22, 0.0, 1.0));
  vCore = 0.85;

  float px = (1.0 + aMeta.w * 2.2) * (1.0 - u * 0.45) * uPixelScale / max(0.35, view.w);
  gl_PointSize = sizeWithEnergy(px, bright);
  vAlpha = bright;
  gl_Position = view;
}`;
