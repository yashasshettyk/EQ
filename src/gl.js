/* ============================================================
   gl.js — minimal WebGL2 layer: programs, targets, mat4, RNG
   ============================================================ */

export function getContext(canvas){
  const gl = canvas.getContext('webgl2', {
    alpha:false, depth:false, stencil:false, antialias:false,
    premultipliedAlpha:false, preserveDrawingBuffer:false,
    powerPreference:'high-performance', desynchronized:true
  });
  if(!gl) throw new Error('WebGL2 unavailable');

  // Float render targets give us real HDR headroom for additive particles.
  const floatRT = gl.getExtension('EXT_color_buffer_float')
               || gl.getExtension('EXT_color_buffer_half_float');
  gl.getExtension('OES_texture_float_linear');

  gl.hdr = !!floatRT;
  return gl;
}

function compile(gl, type, src, label){
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l,i)=>String(i+1).padStart(4)+' | '+l).join('\n');
    throw new Error(`[${label}] shader compile failed\n${log}\n${numbered}`);
  }
  return sh;
}

export function program(gl, vsSrc, fsSrc, label='program'){
  const p  = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER,   vsSrc, label+':vs');
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, label+':fs');
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(`[${label}] link failed\n${gl.getProgramInfoLog(p)}`);
  gl.deleteShader(vs); gl.deleteShader(fs);

  // Cache every uniform and attribute location up front.
  const u = {}, a = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for(let i=0;i<nu;i++){
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/,'');
    u[name] = gl.getUniformLocation(p, name);
  }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for(let i=0;i<na;i++){
    const info = gl.getActiveAttrib(p, i);
    a[info.name] = gl.getAttribLocation(p, info.name);
  }
  return { prog:p, u, a, use(){ gl.useProgram(p); return this; } };
}

/* ── render targets ────────────────────────────────────────── */

export function createTarget(gl, w, h, { float = true, linear = true } = {}){
  const useF = float && gl.hdr;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0,
    useF ? gl.RGBA16F : gl.RGBA8, w, h, 0,
    gl.RGBA, useF ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
  const f = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return {
    tex, fbo, w, h,
    bind(){ gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0,0,w,h); },
    dispose(){ gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); }
  };
}

/** Fullscreen triangle — no vertex buffer needed, positions come from gl_VertexID. */
export function createQuad(gl){
  const vao = gl.createVertexArray();
  return { draw(){ gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3); } };
}

export const QUAD_VS = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* ── buffers ───────────────────────────────────────────────── */

export function buffer(gl, data, usage){
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW);
  return b;
}

export function attrib(gl, loc, buf, size, { stride = 0, offset = 0 } = {}){
  if(loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
}

/* ── mat4 (column-major, matching GLSL) ────────────────────── */

export const mat4 = {
  create(){ const m = new Float32Array(16); m[0]=m[5]=m[10]=m[15]=1; return m; },

  perspective(out, fovy, aspect, near, far){
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    out.fill(0);
    out[0]=f/aspect; out[5]=f; out[10]=(far+near)*nf; out[11]=-1; out[14]=2*far*near*nf;
    return out;
  },

  lookAt(out, eye, center, up){
    let z0=eye[0]-center[0], z1=eye[1]-center[1], z2=eye[2]-center[2];
    let l = 1/Math.hypot(z0,z1,z2); z0*=l; z1*=l; z2*=l;
    let x0=up[1]*z2-up[2]*z1, x1=up[2]*z0-up[0]*z2, x2=up[0]*z1-up[1]*z0;
    l = Math.hypot(x0,x1,x2); l = l ? 1/l : 0; x0*=l; x1*=l; x2*=l;
    const y0=z1*x2-z2*x1, y1=z2*x0-z0*x2, y2=z0*x1-z1*x0;
    out[0]=x0; out[1]=y0; out[2]=z0; out[3]=0;
    out[4]=x1; out[5]=y1; out[6]=z1; out[7]=0;
    out[8]=x2; out[9]=y2; out[10]=z2; out[11]=0;
    out[12]=-(x0*eye[0]+x1*eye[1]+x2*eye[2]);
    out[13]=-(y0*eye[0]+y1*eye[1]+y2*eye[2]);
    out[14]=-(z0*eye[0]+z1*eye[1]+z2*eye[2]);
    out[15]=1;
    return out;
  },

  multiply(out, a, b){
    for(let c=0;c<4;c++){
      const b0=b[c*4], b1=b[c*4+1], b2=b[c*4+2], b3=b[c*4+3];
      out[c*4+0]=a[0]*b0+a[4]*b1+a[8]*b2+a[12]*b3;
      out[c*4+1]=a[1]*b0+a[5]*b1+a[9]*b2+a[13]*b3;
      out[c*4+2]=a[2]*b0+a[6]*b1+a[10]*b2+a[14]*b3;
      out[c*4+3]=a[3]*b0+a[7]*b1+a[11]*b2+a[15]*b3;
    }
    return out;
  }
};

/* ── deterministic RNG so the field is identical every load ── */

export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
