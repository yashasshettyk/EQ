/* ============================================================
   solar-shaders.js — procedural worlds
   ------------------------------------------------------------
   No bitmaps. Every surface is evaluated per fragment from noise,
   and the octave count rises as the camera closes in, so detail
   keeps appearing instead of running out. A texture has a last
   mip; this does not.
   ============================================================ */

const NOISE = /* glsl */`
vec3 hash33(vec3 p){
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}
float gnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dot(hash33(i + vec3(0,0,0)), f - vec3(0,0,0)),
                     dot(hash33(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                 mix(dot(hash33(i + vec3(0,1,0)), f - vec3(0,1,0)),
                     dot(hash33(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
             mix(mix(dot(hash33(i + vec3(0,0,1)), f - vec3(0,0,1)),
                     dot(hash33(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                 mix(dot(hash33(i + vec3(0,1,1)), f - vec3(0,1,1)),
                     dot(hash33(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z) * 1.6;
}

/* Fractal sum. uDetail is driven by how much of the screen the body
   fills, so approaching one adds octaves rather than magnifying the
   last ones — this is the whole trick behind the endless zoom. */
float fbm(vec3 p, int oct, float lac, float gain){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i = 0; i < 12; i++){
    if(i >= oct) break;
    s += a * gnoise(p); n += a;
    p *= lac; a *= gain;
  }
  return s / max(n, 1e-4);
}

/* Ridged variant — mountains, canyon walls, storm filaments. */
float ridge(vec3 p, int oct, float lac, float gain){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i = 0; i < 12; i++){
    if(i >= oct) break;
    float v = 1.0 - abs(gnoise(p));
    s += a * v * v; n += a;
    p *= lac; a *= gain;
  }
  return s / max(n, 1e-4);
}

/* Cellular noise, for crater fields. */
float worley(vec3 p){
  vec3 i = floor(p), f = fract(p);
  float d = 1.0;
  for(int x = -1; x <= 1; x++)
  for(int y = -1; y <= 1; y++)
  for(int z = -1; z <= 1; z++){
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = hash33(i + g) * 0.5 + 0.5;
    d = min(d, length(g + o - f));
  }
  return d;
}
`;

export const BODY_VS = /* glsl */`#version 300 es
precision highp float;
in vec3 aPos;
uniform mat4  uViewProj;
uniform vec3  uCenter;
uniform float uRadius;
uniform mat3  uSpin;      // axial tilt and rotation
out vec3 vObj;            // position on the unit sphere, in body space
out vec3 vNrm;            // the same, rotated into world space
out vec3 vWorld;
void main(){
  vObj = normalize(aPos);
  vNrm = normalize(uSpin * vObj);
  vec3 w = uCenter + vNrm * uRadius;
  vWorld = w;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

export const BODY_FS = /* glsl */`#version 300 es
precision highp float;
${NOISE}

in vec3 vObj;
in vec3 vNrm;
in vec3 vWorld;

uniform int   uSurface;     // which world
uniform vec3  uTint;
uniform vec3  uAtmo;
uniform float uAtmoStrength;
uniform vec3  uCam;
uniform vec3  uSunPos;
uniform float uTime;
uniform int   uDetail;      // octaves, from apparent size
uniform float uClose;       // 0 far away, 1 filling the frame
uniform float uLevel, uBass;

out vec4 frag;

/* ── worlds ──────────────────────────────────────────────────
   Each surface is built from the features the body is actually
   known for, not just noise at different frequencies: ejecta rays
   on Mercury, the Y-cloud on Venus, Olympus Mons and Valles
   Marineris on Mars, festoons between Jupiter's belts, the
   hexagonal jet over Saturn's pole. A field of fractal noise
   reads as "a planet"; these read as *that* planet.
   ──────────────────────────────────────────────────────────── */

/* Angular distance from a fixed point on the sphere — how a named
   feature gets pinned to a place instead of floating. */
float feature(vec3 n, vec3 at, float size){
  return smoothstep(size, 0.0, length(n - normalize(at)));
}

vec3 surfSun(vec3 n){
  /* A star's photosphere is convection seen from above: granules about
     1,000 km across, each a rising cell with a cooler lane around it,
     sitting on supergranules some thirty times larger. Sunspots are
     where the magnetic field is strong enough to choke convection, so
     they are cooler and darker, ringed by faculae that are hotter. */
  float t = uTime * 0.05;

  // differential rotation: the equator laps the poles
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float shear = (1.0 - 0.22 * lat * lat) * t;
  vec3 q = vec3(n.x * cos(shear) - n.z * sin(shear), n.y,
                n.x * sin(shear) + n.z * cos(shear));

  float superg = 1.0 - worley(q * 7.0 + vec3(t * 0.3));
  float gran   = 1.0 - worley(q * 30.0 + vec3(t * 1.1));
  float fine   = uDetail > 7  ? (1.0 - worley(q *  78.0 - vec3(t * 1.9))) : 0.0;
  float finer  = uDetail > 9  ? (1.0 - worley(q * 190.0 + vec3(t * 3.0))) : 0.0;
  float finest = uDetail > 10 ? (1.0 - worley(q * 430.0 - vec3(t * 4.4))) : 0.0;

  /* Contrast matters more than amplitude here: the granules are only a
     few hundred kelvin hotter than the lanes between them, but that is
     the entire visible texture of a star. */
  float h = 0.18
          + superg * 0.20 + pow(gran, 1.7) * 0.62
          + fine * 0.30 + finer * 0.20 + finest * 0.14
          + fbm(q * 4.0 + t, min(uDetail, 6), 2.1, 0.55) * 0.16
          + uBass * 0.14;

  // The Planck curve moves from deep red through orange to white as the
  // gas gets hotter, so temperature reads directly as colour.
  vec3 col = mix(vec3(0.62, 0.11, 0.015), vec3(1.0, 0.44, 0.09), clamp(h * 1.7, 0.0, 1.0));
  col = mix(col, vec3(1.0, 0.80, 0.42), smoothstep(0.42, 0.78, h));
  col = mix(col, vec3(0.98, 0.93, 0.82), smoothstep(0.78, 1.15, h));

  // active regions: spots with an umbra, a penumbra, and bright faculae
  float mag = fbm(q * 2.6 + 19.0, 5, 2.0, 0.5) * 0.5 + 0.5;
  float spotArea = smoothstep(0.62, 0.78, mag);
  float umbra  = smoothstep(0.72, 0.86, mag);
  if(uDetail > 5){
    float fil = ridge(q * 34.0 + 5.0, min(uDetail, 9), 2.2, 0.5);
    col = mix(col, vec3(0.55, 0.21, 0.04), (spotArea - umbra) * (0.55 + fil * 0.4));  // penumbra
    col = mix(col, vec3(0.115, 0.030, 0.008), umbra * 0.92);                        // umbra
    // faculae: the bright magnetic network around the spots
    float net = smoothstep(0.50, 0.64, mag) * (1.0 - spotArea);
    col += vec3(0.50, 0.32, 0.12) * net * (0.4 + gran * 0.9);
  }

  vec3 V = normalize(uCam - vWorld);
  float mu = max(dot(normalize(vNrm), V), 0.0);

  // Limb darkening. A real one: you see less deep, so cooler gas, toward
  // the edge — and it reddens as it dims rather than simply fading.
  float limb = 0.32 + 0.68 * pow(mu, 0.58);
  col *= limb;
  col = mix(col * vec3(1.0, 0.72, 0.46), col, smoothstep(0.0, 0.55, mu));

  /* Chromosphere: the thin red rim just beyond the photosphere, with
     prominences arching off it. Only visible right at the edge. */
  float edge = pow(1.0 - mu, 7.0);
  float prom = ridge(n * 9.0 + vec3(t * 2.2), min(uDetail, 8), 2.2, 0.5);
  col += vec3(1.0, 0.16, 0.07) * edge * (0.75 + prom * 1.9) * 1.15;

  /* Held just under the bloom threshold across most of the disc. Above
     it the whole star blooms into a featureless white ball and every bit
     of granulation is lost. */
  return col * (0.80 + uLevel * 0.22);
}

vec3 surfMercury(vec3 n){
  float base = fbm(n * 3.0, min(uDetail, 9), 2.0, 0.55) * 0.5 + 0.5;

  // Caloris: one enormous ancient impact basin, smoother than the rest
  float caloris = feature(n, vec3(0.55, 0.32, 0.77), 0.52);
  base = mix(base, base * 0.55 + 0.30, caloris);

  // crater fields at four scales, each dug in and rimmed
  float c = 0.0, rim = 0.0;
  float w1 = worley(n *  7.0); c += smoothstep(0.30, 0.0, w1) * 0.55;
  rim += smoothstep(0.38, 0.30, w1) * smoothstep(0.22, 0.30, w1) * 0.5;
  float w2 = worley(n * 17.0); c += smoothstep(0.24, 0.0, w2) * 0.35;
  rim += smoothstep(0.31, 0.24, w2) * smoothstep(0.17, 0.24, w2) * 0.35;
  if(uDetail > 7){ float w3 = worley(n * 41.0); c += smoothstep(0.20, 0.0, w3) * 0.25;
                   rim += smoothstep(0.26, 0.20, w3) * 0.22; }
  if(uDetail > 9)  c += smoothstep(0.18, 0.0, worley(n *  95.0)) * 0.18;
  if(uDetail > 10) c += smoothstep(0.16, 0.0, worley(n * 210.0)) * 0.12;

  // bright ejecta rays thrown out from the youngest craters
  float rays = 0.0;
  if(uDetail > 6){
    vec3 rc = normalize(vec3(-0.35, 0.62, 0.70));
    float d = length(n - rc);
    float ang = atan(dot(n, normalize(cross(rc, vec3(0,1,0)))),
                     dot(n, normalize(cross(cross(rc, vec3(0,1,0)), rc))));
    rays = smoothstep(0.85, 0.12, d) * smoothstep(0.35, 0.85, sin(ang * 13.0) * 0.5 + 0.5) * 0.30;
  }

  // scarps: long compression ridges from the planet's cooling
  float scarp = smoothstep(0.62, 0.80, ridge(n * 4.5 + 7.0, min(uDetail, 8), 2.2, 0.5)) * 0.18;

  float v = base * 0.7 + 0.3 - c * 0.42 + rim * 0.18 + rays + scarp;
  vec3 col = uTint * (0.40 + v * 0.80);
  col *= 1.0 - caloris * 0.10;
  return col;
}

vec3 surfVenus(vec3 n){
  float t = uTime * 0.012;
  vec3 q = n * 3.4;
  q += vec3(fbm(n * 2.0 + t, min(uDetail, 6), 2.0, 0.55)) * 1.3;

  // super-rotating deck: the cloud tops lap the planet every four days
  float bands = sin(n.y * 9.0 + fbm(q, min(uDetail, 8), 2.1, 0.55) * 5.0) * 0.5 + 0.5;
  float swirl = fbm(q * 2.2, min(uDetail, 9), 2.2, 0.52) * 0.5 + 0.5;
  float fine  = uDetail > 8 ? ridge(q * 5.5 - t * 3.0, min(uDetail, 10), 2.2, 0.5) : 0.0;
  float v = mix(bands, swirl, 0.6) + fine * 0.18;

  // the dark ultraviolet Y, the one feature the cloud deck really has
  float yArm = smoothstep(0.55, 0.95,
      sin(n.y * 4.0 + n.x * 2.2 + t * 4.0) * 0.5 + 0.5) * smoothstep(0.65, 0.1, abs(n.y));
  v -= yArm * 0.22;

  // polar vortices, one at each pole
  float polar = smoothstep(0.72, 0.97, abs(n.y));
  v = mix(v, 0.35 + ridge(n * 9.0 + t * 6.0, min(uDetail, 8), 2.2, 0.5) * 0.5, polar * 0.8);

  return mix(vec3(0.70, 0.58, 0.36), vec3(1.0, 0.95, 0.76), clamp(v, 0.0, 1.0));
}

vec3 surfEarth(vec3 n, float night, out float spec){
  vec3 w = n * 1.9 + vec3(fbm(n * 1.1, 4, 2.0, 0.5)) * 0.6;
  float h = fbm(w, min(uDetail, 11), 2.05, 0.52);
  float land = smoothstep(0.015, 0.055, h);

  // continental shelf: the pale ring of shallow water round every coast
  float shelf = smoothstep(-0.03, 0.015, h) * (1.0 - land);

  float ice = smoothstep(0.76, 0.90, abs(n.y) + fbm(n * 6.0, 4, 2.0, 0.5) * 0.06);
  float relief = ridge(w * 4.0, min(uDetail, 11), 2.1, 0.5);

  // mountain chains: ridged noise, thresholded, only on land
  float range = smoothstep(0.70, 0.94, ridge(w * 7.0 + 3.0, min(uDetail, 11), 2.15, 0.5));

  // biomes by latitude and dryness rather than one flat green
  float lat  = abs(n.y);
  float arid = smoothstep(0.35, 0.65, fbm(w * 2.4 + 31.0, 6, 2.0, 0.5) * 0.5 + 0.5);
  arid = clamp(arid + smoothstep(0.10, 0.34, lat) * smoothstep(0.62, 0.30, lat) * 0.45, 0.0, 1.0);
  float boreal = smoothstep(0.50, 0.70, lat);

  vec3 ocean  = mix(vec3(0.005, 0.017, 0.048), vec3(0.018, 0.058, 0.120),
                    smoothstep(-0.30, 0.02, h));
  ocean = mix(ocean, vec3(0.045, 0.125, 0.180), shelf * 0.85);

  vec3 green  = mix(vec3(0.052, 0.098, 0.064), vec3(0.132, 0.172, 0.124), relief);
  vec3 desert = mix(vec3(0.268, 0.226, 0.166), vec3(0.392, 0.344, 0.270), relief);
  vec3 taiga  = mix(vec3(0.062, 0.088, 0.078), vec3(0.108, 0.128, 0.115), relief);
  vec3 ground = mix(mix(green, desert, arid), taiga, boreal);
  ground = mix(ground, vec3(0.40, 0.40, 0.42), range * 0.55);          // bare rock
  ground = mix(ground, vec3(0.86, 0.88, 0.92), range * range * 0.45);  // snow line

  vec3 col = mix(ocean, ground, land);
  col = mix(col, vec3(0.78, 0.83, 0.90), ice);
  spec = (1.0 - land) * (1.0 - ice);

  // two cloud layers at different scales and speeds, so the deck has depth
  float cl = fbm(n * 3.1 + vec3(uTime * 0.020, 0.0, uTime * 0.008),
                 min(uDetail, 9), 2.2, 0.55) * 0.5 + 0.5;
  float cl2 = fbm(n * 7.4 - vec3(uTime * 0.034, 0.0, 0.0),
                  min(uDetail, 10), 2.3, 0.52) * 0.5 + 0.5;
  cl = smoothstep(0.54, 0.84, cl * 0.72 + cl2 * 0.38);

  // storm systems: tight spirals in the mid latitudes
  float storm = smoothstep(0.80, 0.97,
      ridge(n * 5.0 + vec3(uTime * 0.03, 0.0, 0.0), min(uDetail, 9), 2.2, 0.5))
    * smoothstep(0.15, 0.45, lat) * smoothstep(0.75, 0.45, lat);
  cl = clamp(cl + storm * 0.55, 0.0, 1.0);

  col = mix(col, vec3(0.80, 0.84, 0.90), cl * 0.78);
  spec *= 1.0 - cl;

  float cities = smoothstep(0.62, 0.95, fbm(w * 9.0 + 7.0, 6, 2.2, 0.5) * 0.5 + 0.5);
  col += vec3(1.0, 0.78, 0.40) * cities * land * (1.0 - cl) * night * 0.42;
  return col;
}

vec3 surfMars(vec3 n){
  float h = fbm(n * 2.4, min(uDetail, 11), 2.05, 0.52);
  float r = ridge(n * 5.0, min(uDetail, 11), 2.1, 0.5);

  /* The dichotomy: the northern lowlands are smooth and pale, the
     southern highlands old, dark and covered in craters. */
  float south = smoothstep(-0.10, -0.55, n.y);
  float craters = 0.0;
  craters += smoothstep(0.26, 0.0, worley(n * 11.0)) * 0.45;
  if(uDetail > 7)  craters += smoothstep(0.22, 0.0, worley(n * 27.0)) * 0.30;
  if(uDetail > 9)  craters += smoothstep(0.18, 0.0, worley(n * 64.0)) * 0.20;
  if(uDetail > 10) craters += smoothstep(0.16, 0.0, worley(n * 150.0)) * 0.14;
  craters *= south;

  vec3 col = mix(vec3(0.195, 0.082, 0.046), vec3(0.475, 0.245, 0.135), h * 0.5 + 0.5);
  col = mix(col, vec3(0.300, 0.150, 0.088), south * 0.42);
  col *= 1.0 - craters * 0.30;

  // Valles Marineris: a 4,000 km gash just south of the equator
  float vm = smoothstep(0.055, 0.0, abs(n.y + 0.14 + sin(n.x * 3.0) * 0.03))
           * smoothstep(0.95, 0.35, abs(n.z + 0.25))
           * smoothstep(-0.2, 0.35, n.x);
  col = mix(col, vec3(0.175, 0.075, 0.045), vm * 0.85);

  // Olympus Mons and the Tharsis shields
  float oly = feature(n, vec3(-0.62, 0.20, 0.55), 0.26);
  col = mix(col, vec3(0.395, 0.205, 0.115), oly * 0.55);
  col = mix(col, vec3(0.20, 0.10, 0.06), feature(n, vec3(-0.62, 0.20, 0.55), 0.045) * 0.8);
  for(int i = 0; i < 3; i++){
    vec3 at = vec3(-0.50 + float(i) * 0.04, 0.02 + float(i) * 0.14, 0.72);
    col = mix(col, vec3(0.350, 0.180, 0.102), feature(n, at, 0.12) * 0.40);
  }

  // Hellas: a deep bright basin in the south
  col = mix(col, vec3(0.545, 0.320, 0.190), feature(n, vec3(0.45, -0.72, -0.30), 0.34) * 0.45);

  // canyon shadowing and wind streaks
  col = mix(col, vec3(0.28, 0.12, 0.075), smoothstep(0.55, 0.85, r) * 0.55);
  if(uDetail > 7){
    float streak = smoothstep(0.55, 0.88, fbm(n * vec3(18.0, 3.0, 18.0) + 11.0, 5, 2.2, 0.5) * 0.5 + 0.5);
    col = mix(col, col * 0.72, streak * 0.35);
  }

  // layered polar deposits, with the spiral troughs
  float pole = smoothstep(0.84, 0.95, abs(n.y) + fbm(n * 7.0, 4, 2.0, 0.5) * 0.05);
  float layers = sin(abs(n.y) * 190.0 + fbm(n * 12.0, 4, 2.0, 0.5) * 8.0) * 0.5 + 0.5;
  col = mix(col, mix(vec3(0.70, 0.67, 0.64), vec3(0.90, 0.90, 0.88), layers), pole);

  // a global dust haze
  col += vec3(0.030, 0.014, 0.005) * (fbm(n * 1.4 + uTime * 0.01, 4, 2.0, 0.5) * 0.5 + 0.5);
  return col;
}

/* Gas giants: latitude bands, domain-warped so they shear and curl the
   way differential rotation makes them, with turbulence concentrated at
   the boundaries between belts — which is where it happens in life. */
vec3 bandedGiant(vec3 n, vec3 c1, vec3 c2, vec3 c3, float freq, float warp,
                 float spotAmt, float hexAmt){
  float t = uTime * 0.03;
  vec3 q = n * 2.2;
  float w  = fbm(q + vec3(t, 0.0, 0.0), min(uDetail, 8), 2.1, 0.55);
  float w2 = fbm(q * 2.6 - vec3(t * 1.7, 0.0, 0.0), min(uDetail, 9), 2.2, 0.52);
  float w3 = uDetail > 8
    ? fbm(q * 6.2 + vec3(t * 2.6, 0.0, 0.0), min(uDetail, 11), 2.3, 0.5) : 0.0;

  float y = n.y + w * warp + w2 * warp * 0.4 + w3 * warp * 0.18;
  float bands = sin(y * freq) * 0.5 + 0.5;
  bands = mix(bands, sin(y * freq * 2.7) * 0.5 + 0.5, 0.35);
  bands = mix(bands, sin(y * freq * 6.1) * 0.5 + 0.5, 0.18);

  float turb = ridge(q * 3.4 + vec3(t * 2.0, 0.0, 0.0), min(uDetail, 10), 2.2, 0.5);
  vec3 col = mix(c1, c2, bands);
  col = mix(col, c3, smoothstep(0.55, 0.95, turb) * 0.45);

  // festoons: the curling wisps that hang off a belt edge
  float edge = 1.0 - abs(sin(y * freq) );
  edge = smoothstep(0.72, 1.0, edge);
  float fest = ridge(q * 9.0 + vec3(t * 4.0, 0.0, 0.0), min(uDetail, 11), 2.2, 0.5);
  col = mix(col, c3 * 0.72, edge * smoothstep(0.55, 0.92, fest) * 0.55);

  // white ovals, long-lived storms riding the belts
  if(uDetail > 6){
    float ov = smoothstep(0.88, 0.99,
        fbm(vec3(n.x * 7.0 + t * 5.0, n.y * 26.0, n.z * 7.0), 4, 2.1, 0.5) * 0.5 + 0.5);
    col = mix(col, vec3(0.97, 0.95, 0.90), ov * 0.6);
  }

  // the storm
  if(spotAmt > 0.0){
    vec3 sc = normalize(vec3(0.62, -0.28, 0.73));
    float d = length((n - sc) * vec3(1.0, 2.3, 1.0));
    float spot = smoothstep(0.34, 0.06, d);
    float swirl = ridge(n * 12.0 + vec3(t * 3.0), min(uDetail, 9), 2.2, 0.5);
    // a bright collar round the vortex, as Jupiter's has
    float collar = smoothstep(0.40, 0.30, d) * smoothstep(0.24, 0.32, d);
    col = mix(col, mix(vec3(0.66, 0.22, 0.11), vec3(0.93, 0.56, 0.34), swirl),
              spot * spotAmt);
    col = mix(col, vec3(0.95, 0.90, 0.80), collar * spotAmt * 0.5);
  }

  // Saturn's hexagonal polar jet — a genuine six-sided standing wave
  if(hexAmt > 0.0){
    float pole = smoothstep(0.80, 0.995, n.y);
    float ang = atan(n.z, n.x);
    float hex = cos(ang * 6.0 + t * 2.0) * 0.5 + 0.5;
    float ring = smoothstep(0.80, 0.90, n.y) * (1.0 - smoothstep(0.93, 0.99, n.y));
    col = mix(col, c3 * 0.55, pole * 0.45);
    col = mix(col, vec3(0.55, 0.62, 0.68), ring * hex * hexAmt * 0.55);
  }
  return col;
}

vec3 surfaceOf(vec3 n, float night, out float spec){
  spec = 0.0;
  if(uSurface == 0) return surfSun(n);
  if(uSurface == 1) return surfMercury(n);
  if(uSurface == 2) return surfVenus(n);
  if(uSurface == 3) return surfEarth(n, night, spec);
  if(uSurface == 4) return surfMars(n);
  /* Belt-and-zone contrast is the whole look of a gas giant. Pushed too
     pale they all converge on the same cream ball. */
  if(uSurface == 5) return bandedGiant(n, vec3(0.335,0.200,0.105), vec3(0.760,0.660,0.505),
                                          vec3(0.560,0.345,0.180), 16.0, 0.10, 1.0, 0.0);
  if(uSurface == 6) return bandedGiant(n, vec3(0.455,0.360,0.195), vec3(0.815,0.740,0.560),
                                          vec3(0.640,0.535,0.340), 13.0, 0.06, 0.0, 1.0);
  if(uSurface == 7) return bandedGiant(n, vec3(0.255,0.545,0.585), vec3(0.560,0.790,0.815),
                                          vec3(0.375,0.665,0.700), 7.0, 0.03, 0.0, 0.0);
  return bandedGiant(n, vec3(0.045,0.125,0.430), vec3(0.310,0.505,0.850),
                        vec3(0.110,0.250,0.660), 10.0, 0.07, 0.45, 0.0);
}

void main(){
  vec3 n = normalize(vObj);
  vec3 N = normalize(vNrm);
  vec3 L = normalize(uSunPos - vWorld);
  vec3 V = normalize(uCam - vWorld);

  float lam  = dot(N, L);
  float day  = smoothstep(-0.09, 0.20, lam);      // tight, but not a cut
  float night = 1.0 - day;

  float spec = 0.0;
  vec3 albedo = surfaceOf(n, night, spec);

  vec3 col;
  if(uSurface == 0){
    col = albedo;                                  // the star lights itself
  } else {
    /* Lighting is deliberately dark. A planet in space is lit by one
       source and nothing else, so the night side falls to almost
       nothing and the image lives on the lit limb. */
    float wrap = clamp((lam + 0.26) / 1.26, 0.0, 1.0);
    wrap = pow(wrap, 1.40);
    col = albedo * (0.015 + wrap * 1.55);

    // specular, only where there is something to reflect from
    if(spec > 0.001){
      vec3 H = normalize(L + V);
      /* Very tight. A broad exponent puts a soft white disc the size of an
         ocean on the planet, which the bloom then makes worse. */
      col += vec3(0.72, 0.84, 1.0) * pow(max(dot(N, H), 0.0), 620.0) * spec * 0.55 * day;
    }

    /* The atmosphere is the hero. A tight Fresnel concentrated on the lit
       side gives the brilliant arc that hugs the limb; the bloom in the
       post chain turns it into the halo. */
    if(uAtmoStrength > 0.0){
      /* Kept deliberately modest. Pushed harder it looks spectacular in
         isolation and then the bloom chain smears it across the whole
         disc, and the planet becomes a featureless white ball. */
      float fres = pow(1.0 - max(dot(N, V), 0.0), 4.6);
      float lit  = smoothstep(-0.40, 0.30, lam);
      col += uAtmo * fres * uAtmoStrength * (0.025 + lit * 1.05);

      // forward-scattered haze sitting just inside the limb
      float inner = pow(1.0 - max(dot(N, V), 0.0), 2.0);
      col += uAtmo * inner * uAtmoStrength * day * 0.055;
    }
  }

  frag = vec4(col, 1.0);
}
`;


/* ── the sky ──────────────────────────────────────────────────
   A procedural celestial sphere: the galactic plane with its dust
   lanes, emission and reflection nebulae, and a handful of distant
   galaxies. Drawn first, behind everything, from the view ray —
   no cube map, so it costs no memory and never repeats.
   ──────────────────────────────────────────────────────────── */
export const SKY_VS = /* glsl */`#version 300 es
precision highp float;
out vec2 vNdc;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 1.0, 1.0);
}`;

export const SKY_FS = /* glsl */`#version 300 es
precision highp float;
${NOISE}
in vec2 vNdc;
uniform vec3  uRight, uUp, uFwd;
uniform float uTanHalf, uAspect, uTime, uLevel;
out vec4 frag;

/* The galactic plane, tilted so it crosses the frame at an angle
   rather than sitting flat across the middle. */
const vec3 GAL = vec3(0.34, 0.86, -0.38);

void main(){
  vec3 rd = normalize(uFwd
          + uRight * vNdc.x * uTanHalf * uAspect
          + uUp    * vNdc.y * uTanHalf);

  vec3 col = vec3(0.0);
  vec3 g = normalize(GAL);
  float band = abs(dot(rd, g));

  /* Milky Way. Brightest along the plane, and much brighter toward the
     galactic centre, which is where the bulge is. */
  float toCore = max(dot(rd, normalize(vec3(-0.62, -0.30, 0.72))), 0.0);
  float plane = exp(-band * band * 34.0);
  float bulge = pow(toCore, 5.0) * 0.55 + pow(toCore, 22.0) * 1.1;

  float stars3 = fbm(rd * 22.0, 4, 2.3, 0.55) * 0.5 + 0.5;
  float milk = plane * (0.30 + stars3 * 0.85) * (0.55 + bulge);

  /* Dust lanes: dark filaments cutting through the band. Without them
     the galaxy reads as a smear of light rather than a structure. */
  float lanes = fbm(rd * 9.0 + 13.0, 4, 2.4, 0.55) * 0.5 + 0.5;
  lanes = smoothstep(0.38, 0.66, lanes);
  milk *= mix(1.0, 0.18, lanes * plane);

  vec3 milkCol = mix(vec3(0.34, 0.40, 0.62), vec3(0.92, 0.86, 0.72), bulge * 0.7);
  col += milkCol * milk * 0.155;

  float halo = exp(-band * band * 4.0);
  col += vec3(0.16, 0.19, 0.30) * halo * (0.25 + stars3 * 0.6) * 0.045;

  /* Emission nebulae — hydrogen alpha, so red — and the cooler blue
     reflection nebulae that sit beside them. */
  float n1 = fbm(rd * 3.1 + 41.0, 4, 2.3, 0.55) * 0.5 + 0.5;
  float neb = smoothstep(0.58, 0.88, n1) * plane;
  col += vec3(0.55, 0.12, 0.18) * neb * 0.125;

  float n2 = fbm(rd * 4.4 - 27.0, 4, 2.3, 0.55) * 0.5 + 0.5;
  float refl = smoothstep(0.62, 0.90, n2) * plane;
  col += vec3(0.14, 0.24, 0.62) * refl * 0.115;

  // a cold wash off the plane, so the sky is never quite black
  col += vec3(0.022, 0.030, 0.060) * (0.30 + 0.70 * plane) * 0.85;

  /* Distant galaxies: small inclined discs at fixed directions. Each is
     a flattened gaussian with a brighter core. */
  for(int i = 0; i < 3; i++){
    vec3 at = normalize(vec3(
      sin(float(i) * 2.1 + 0.7), cos(float(i) * 1.7 + 1.3), sin(float(i) * 3.3)));
    vec3 axis = normalize(vec3(cos(float(i) * 2.9), 0.6, sin(float(i) * 1.1)));
    vec3 d = rd - at;
    float across = dot(d, axis);
    float along  = length(d - axis * across);
    float disc = exp(-(along * along) * 900.0 - (across * across) * 26000.0);
    float core = exp(-dot(d, d) * 9000.0);
    col += mix(vec3(0.62, 0.66, 0.85), vec3(1.0, 0.92, 0.78), core)
         * (disc * 0.30 + core * 0.9) * 0.22;
  }

  frag = vec4(col, 1.0);
}`;

/* ── orbit paths ──────────────────────────────────────────── */

export const ORBIT_VS = /* glsl */`#version 300 es
precision highp float;
in float aT;
uniform mat4 uViewProj;
uniform float uRadius, uTiltZ;
out float vT;
void main(){
  float a = aT * 6.2831853;
  vec3 p = vec3(cos(a) * uRadius, sin(a) * uRadius * uTiltZ, sin(a) * uRadius);
  vT = aT;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

export const ORBIT_FS = /* glsl */`#version 300 es
precision highp float;
in float vT;
uniform float uAlpha;
uniform vec3 uCol;
out vec4 frag;
void main(){ frag = vec4(uCol * uAlpha, 1.0); }`;

/* ── rings ─────────────────────────────────────────────────── */

export const RING_VS = /* glsl */`#version 300 es
precision highp float;
in vec2 aXY;                 // unit disc coordinates
uniform mat4  uViewProj;
uniform vec3  uCenter;
uniform float uInner, uOuter;
uniform mat3  uSpin;
out vec2 vXY;
out vec3 vWorld;
void main(){
  vXY = aXY;
  vec3 local = vec3(aXY.x, 0.0, aXY.y) * uOuter;
  vec3 w = uCenter + uSpin * local;
  vWorld = w;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

export const RING_FS = /* glsl */`#version 300 es
precision highp float;
${NOISE}
in vec2 vXY;
in vec3 vWorld;
uniform vec3  uCenter;
uniform float uInner, uOuter, uBodyRadius;
uniform vec3  uSunPos, uCam, uTint;
uniform int   uDetail;
out vec4 frag;

void main(){
  float r = length(vXY);                       // 0..1 across the outer edge
  float t = (r * uOuter - uInner) / max(1e-4, uOuter - uInner);
  if(t < 0.0 || t > 1.0) discard;

  /* Banding: several octaves of one-dimensional noise, plus the two
     big gaps. The Cassini Division is at roughly 0.62 of the way out. */
  float band = fbm(vec3(t * 26.0, 0.0, 0.0), min(uDetail, 8), 2.3, 0.55) * 0.5 + 0.5;
  band *= fbm(vec3(t * 120.0, 5.0, 0.0), min(uDetail, 9), 2.1, 0.5) * 0.4 + 0.75;

  float cassini = smoothstep(0.015, 0.045, abs(t - 0.62));
  float encke   = smoothstep(0.004, 0.014, abs(t - 0.88));
  float inner   = smoothstep(0.0, 0.06, t);
  float outer   = 1.0 - smoothstep(0.92, 1.0, t);

  float a = band * cassini * encke * inner * outer;
  a = clamp(a * 0.85, 0.0, 1.0);
  if(a < 0.004) discard;

  // the planet's shadow falling across the ring
  vec3 L = normalize(uSunPos - vWorld);
  vec3 toC = uCenter - vWorld;
  float along = dot(toC, L);
  float shadow = 1.0;
  if(along > 0.0){
    float d = length(toC - L * along);
    shadow = smoothstep(uBodyRadius * 0.92, uBodyRadius * 1.10, d);
  }

  // Warm where the ice is dense, cooler and darker where it thins.
  vec3 dense = uTint * 1.05;
  vec3 thin  = uTint * vec3(0.72, 0.76, 0.86) * 0.45;
  vec3 col = mix(thin, dense, band) * (0.35 + band * 0.55) * (0.14 + shadow * 1.15);
  frag = vec4(col * a, a);
}`;
