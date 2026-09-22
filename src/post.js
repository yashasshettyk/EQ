/* ============================================================
   post.js — HDR bloom, filmic tonemap, supersample resolve
   ------------------------------------------------------------
   The scene renders into a high-resolution HDR target. Bloom runs
   on a bounded mip chain (glow is low-frequency — it gains nothing
   from 8K), then the composite resolves the full-resolution buffer
   down to the screen with a tent filter. That last step is what
   turns supersampling into visible sharpness instead of aliasing.
   ============================================================ */

import { program, createTarget, createQuad, QUAD_VS } from './gl.js';

const BRIGHT_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform float uThreshold, uSoftKnee;
out vec4 frag;

void main(){
  // 4-tap box while downsampling — kills firefly aliasing in the glow
  vec3 c = texture(uTex, vUv + uTexel * vec2(-1.0,-1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2( 1.0,-1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2( 1.0, 1.0)).rgb;
  c *= 0.25;

  float lum  = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(lum - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float w = max(soft, lum - uThreshold) / max(lum, 1e-5);
  frag = vec4(c * w, 1.0);
}`;

const BLUR_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;          // texel-sized step along one axis
out vec4 frag;

void main(){
  // 9-tap gaussian folded into 5 linearly-interpolated fetches
  const float o1 = 1.3846153846, o2 = 3.2307692308;
  const float w0 = 0.2270270270, w1 = 0.3162162162, w2 = 0.0702702703;
  vec3 c = texture(uTex, vUv).rgb * w0;
  c += texture(uTex, vUv + uDir * o1).rgb * w1;
  c += texture(uTex, vUv - uDir * o1).rgb * w1;
  c += texture(uTex, vUv + uDir * o2).rgb * w2;
  c += texture(uTex, vUv - uDir * o2).rgb * w2;
  frag = vec4(c, 1.0);
}`;

const UP_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uPrev;
uniform vec2  uTexel;
uniform float uMix;
out vec4 frag;

void main(){
  // 3x3 tent upsample — the standard trick for bloom without banding
  vec3 c =
      texture(uTex, vUv + uTexel * vec2(-1.0,-1.0)).rgb * 1.0
    + texture(uTex, vUv + uTexel * vec2( 0.0,-1.0)).rgb * 2.0
    + texture(uTex, vUv + uTexel * vec2( 1.0,-1.0)).rgb * 1.0
    + texture(uTex, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0
    + texture(uTex, vUv                          ).rgb * 4.0
    + texture(uTex, vUv + uTexel * vec2( 1.0, 0.0)).rgb * 2.0
    + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb * 1.0
    + texture(uTex, vUv + uTexel * vec2( 0.0, 1.0)).rgb * 2.0
    + texture(uTex, vUv + uTexel * vec2( 1.0, 1.0)).rgb * 1.0;
  c *= 1.0 / 16.0;
  frag = vec4(texture(uPrev, vUv).rgb + c * uMix, 1.0);
}`;

const COMPOSITE_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2  uSceneTexel;   // 1 / scene resolution
uniform float uSS;           // supersample ratio (scene px per output px)
uniform float uBloomAmt, uExposure, uVignette, uAberration, uGrain, uTime;
out vec4 frag;

/* ACES filmic approximation (Narkowicz) — holds highlight colour
   instead of clipping straight to white. */
vec3 aces(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

/* Tent-filtered resolve. When the scene is rendered above output
   resolution we average a small neighbourhood, which is what makes
   the points read as clean sub-pixel detail. */
vec3 resolveScene(vec2 uv){
  if(uSS <= 1.05) return texture(uScene, uv).rgb;
  vec2 o = uSceneTexel * (uSS * 0.5);
  vec3 c = texture(uScene, uv).rgb * 4.0;
  c += texture(uScene, uv + vec2( o.x, 0.0)).rgb * 2.0;
  c += texture(uScene, uv + vec2(-o.x, 0.0)).rgb * 2.0;
  c += texture(uScene, uv + vec2( 0.0, o.y)).rgb * 2.0;
  c += texture(uScene, uv + vec2( 0.0,-o.y)).rgb * 2.0;
  c += texture(uScene, uv + o).rgb;
  c += texture(uScene, uv - o).rgb;
  c += texture(uScene, uv + vec2( o.x,-o.y)).rgb;
  c += texture(uScene, uv + vec2(-o.x, o.y)).rgb;
  return c * (1.0 / 16.0);
}

float hash(vec2 p){
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main(){
  vec2 uv = vUv;
  vec2 d  = uv - 0.5;
  float r2 = dot(d, d);

  // Lateral chromatic aberration, strictly at the edges.
  vec3 scene;
  if(uAberration > 0.0005){
    float k = uAberration * r2;
    scene.r = resolveScene(uv - d * k).r;
    scene.g = resolveScene(uv).g;
    scene.b = resolveScene(uv + d * k).b;
  } else {
    scene = resolveScene(uv);
  }

  vec3 bloom = texture(uBloom, uv).rgb;
  vec3 col   = scene + bloom * uBloomAmt;

  col *= uExposure;
  col  = aces(col);

  // optical vignette
  col *= 1.0 - uVignette * smoothstep(0.18, 0.86, r2);

  // linear → sRGB
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));

  // Ordered-ish dither. Without this, a black background with a
  // soft glow bands badly on 8-bit displays.
  float n = hash(gl_FragCoord.xy + fract(uTime) * 91.7);
  col += (n - 0.5) * (uGrain + 1.6 / 255.0);

  frag = vec4(col, 1.0);
}`;

export class Post {
  constructor(gl){
    this.gl = gl;
    this.quad   = createQuad(gl);
    this.pBright = program(gl, QUAD_VS, BRIGHT_FS,    'bright');
    this.pBlur   = program(gl, QUAD_VS, BLUR_FS,      'blur');
    this.pUp     = program(gl, QUAD_VS, UP_FS,        'upsample');
    this.pComp   = program(gl, QUAD_VS, COMPOSITE_FS, 'composite');

    this.levels = [];
    this.scene  = null;

    this.settings = {
      threshold: 0.74, softKnee: 0.52, bloom: 1.22,
      exposure: 1.12, vignette: 0.44, aberration: 0.0022, grain: 0.012
    };
  }

  /** @param w,h scene resolution in render pixels (may be far above screen) */
  resize(w, h){
    const gl = this.gl;
    this.dispose();

    this.scene = createTarget(gl, w, h, { float:true, linear:true });

    // Bloom chain is capped so memory stays bounded at any scene resolution.
    const CAP = 1280;
    let bw = Math.max(2, Math.min(CAP, w >> 1));
    let bh = Math.max(2, Math.round(bw * h / w));

    this.levels = [];
    for(let i = 0; i < 5 && bw > 8 && bh > 8; i++){
      this.levels.push({
        a: createTarget(gl, bw, bh, { float:true, linear:true }),
        b: createTarget(gl, bw, bh, { float:true, linear:true }),
        w: bw, h: bh
      });
      bw = Math.max(2, bw >> 1);
      bh = Math.max(2, bh >> 1);
    }
    this.w = w; this.h = h;
  }

  dispose(){
    this.scene?.dispose();
    for(const l of this.levels){ l.a.dispose(); l.b.dispose(); }
    this.levels = []; this.scene = null;
  }

  beginScene(){
    const gl = this.gl;
    this.scene.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** @param outW,outH the drawing-buffer size we resolve down to */
  render(outW, outH, time){
    const gl = this.gl, s = this.settings, L = this.levels;
    gl.disable(gl.BLEND);

    // 1 ── threshold + downsample into the first bloom level
    let src = this.scene;
    {
      const l = L[0];
      l.a.bind();
      this.pBright.use();
      gl.uniform1i(this.pBright.u.uTex, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.pBright.u.uTexel, 1 / src.w, 1 / src.h);
      gl.uniform1f(this.pBright.u.uThreshold, s.threshold);
      gl.uniform1f(this.pBright.u.uSoftKnee,  s.softKnee);
      this.quad.draw();
    }

    // 2 ── progressive downsample, blurring separably at each level
    for(let i = 0; i < L.length; i++){
      const l = L[i];
      if(i > 0){
        l.a.bind();
        this.pBright.use();
        gl.uniform1i(this.pBright.u.uTex, 0);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, L[i-1].a.tex);
        gl.uniform2f(this.pBright.u.uTexel, 1 / L[i-1].w, 1 / L[i-1].h);
        gl.uniform1f(this.pBright.u.uThreshold, 0.0);
        gl.uniform1f(this.pBright.u.uSoftKnee, 1.0);
        this.quad.draw();
      }
      this.pBlur.use();
      gl.uniform1i(this.pBlur.u.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);

      l.b.bind();
      gl.bindTexture(gl.TEXTURE_2D, l.a.tex);
      gl.uniform2f(this.pBlur.u.uDir, 1 / l.w, 0);
      this.quad.draw();

      l.a.bind();
      gl.bindTexture(gl.TEXTURE_2D, l.b.tex);
      gl.uniform2f(this.pBlur.u.uDir, 0, 1 / l.h);
      this.quad.draw();
    }

    // 3 ── upsample back up the chain, accumulating
    for(let i = L.length - 2; i >= 0; i--){
      const dst = L[i], srcL = L[i + 1];
      dst.b.bind();
      this.pUp.use();
      gl.uniform1i(this.pUp.u.uTex, 0);
      gl.uniform1i(this.pUp.u.uPrev, 1);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcL.a.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, dst.a.tex);
      gl.uniform2f(this.pUp.u.uTexel, 1 / srcL.w, 1 / srcL.h);
      gl.uniform1f(this.pUp.u.uMix, 0.82);
      this.quad.draw();
      // the accumulated result becomes this level's source
      const t = dst.a; dst.a = dst.b; dst.b = t;
    }

    // 4 ── composite to the screen, resolving the supersampled scene
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    this.pComp.use();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, L[0].a.tex);
    gl.uniform1i(this.pComp.u.uScene, 0);
    gl.uniform1i(this.pComp.u.uBloom, 1);
    gl.uniform2f(this.pComp.u.uSceneTexel, 1 / this.scene.w, 1 / this.scene.h);
    gl.uniform1f(this.pComp.u.uSS, this.scene.w / outW);
    gl.uniform1f(this.pComp.u.uBloomAmt,   s.bloom);
    gl.uniform1f(this.pComp.u.uExposure,   s.exposure);
    gl.uniform1f(this.pComp.u.uVignette,   s.vignette);
    gl.uniform1f(this.pComp.u.uAberration, s.aberration);
    gl.uniform1f(this.pComp.u.uGrain,      s.grain);
    gl.uniform1f(this.pComp.u.uTime,       time);
    this.quad.draw();
  }
}
