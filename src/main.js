/* ============================================================
   main.js — boot, loop, interaction
   ============================================================ */

import { getContext, profileDevice } from './gl.js';
import { Field, PALETTES, TIERS, MODES } from './field.js';
import { Post } from './post.js';
import { Solar } from './solar.js';
import { BODIES } from './bodies.js';
import { AudioEngine, SCENES } from './audio.js';

const $ = id => document.getElementById(id);
const el = {
  canvas:$('stage'), gate:$('gate'), note:$('gateNote'),
  topbar:$('topbar'), dock:$('dock'), status:$('status'), statusTxt:$('statusTxt'),
  bars:document.querySelectorAll('.status__bars i'),
  meter:document.querySelectorAll('.meter i'),
  srcLabel:$('srcLabel'), palLabel:$('palLabel'), swatch:$('swatch'),
  qLabel:$('qLabel'), res:$('resReadout'),
  btnSource:$('btnSource'), btnPlay:$('btnPlay'), btnPalette:$('btnPalette'),
  btnQuality:$('btnQuality'), btnFull:$('btnFull'), btnHelp:$('btnHelp'),
  btnForm:$('btnForm'), formLabel:$('formLabel'),
  btnScene:$('btnScene'), sceneLabel:$('sceneLabel'), sceneChips:$('sceneChips'),
  gain:$('gainRange'), scrub:$('scrub'), scrubFill:$('scrubFill'),
  scrubKnob:$('scrubKnob'), scrubTime:$('scrubTime'),
  help:$('helpSheet'), toast:$('toast'), drop:$('drop'), picker:$('filePicker'),
  gainWrap:$('gainWrap'),
  np:$('nowPlaying'), npTitle:$('npTitle'), npGroup:$('npGroup'),
  npBlurb:$('npBlurb'), npBars:$('npBars'), npPrev:$('npPrev'),
  npPlay:$('npPlay'), npNext:$('npNext'), npExit:$('npExit'), npNote:$('npNote'),
  btnMusicOnly:$('btnMusicOnly'),
  solarUI:$('solarUI'), solarGhost:$('solarGhost'), solarNav:$('solarNav'),
  solarPrev:$('solarPrev'), solarNext:$('solarNext'), solarAlt:$('solarAlt'),
  solarDiscover:$('solarDiscover'), solarPanel:$('solarPanel'),
  solarClose:$('solarClose'), solarName:$('solarName'),
  solarBlurb:$('solarBlurb'), solarFacts:$('solarFacts'), solarOrd:$('solarOrd')
};

/* ── persisted preferences ───────────────────────────────── */
const store = {
  get(k, d){ try{ const v = localStorage.getItem('resonance.'+k); return v === null ? d : JSON.parse(v); }catch{ return d; } },
  set(k, v){ try{ localStorage.setItem('resonance.'+k, JSON.stringify(v)); }catch{} }
};

/* ── boot ────────────────────────────────────────────────── */

let gl, field, post, audio, profile, solar;
let view = 'field';          // 'field' | 'solar'

function fatal(err){
  console.error(err);
  el.gate.classList.remove('is-gone');
  el.note.classList.add('warn');
  el.note.textContent = /WebGL2/.test(err.message)
    ? 'This browser has no WebGL2. Try Chrome, Edge, Arc or Safari 15+.'
    : 'Could not start the renderer: ' + err.message;
}

/* ── quality ─────────────────────────────────────────────── */

// Desktop and phone run different tier ladders, so the preference is
// stored per profile — a tier chosen on a laptop must not follow you
// onto a handset.
let tierKey = 'tier';
let storedTier = null;
let tierIndex = 2;
if(tierIndex < 0) tierIndex = 2;

let sceneW = 0, sceneH = 0;

/* The top tiers allocate hundreds of megabytes of render target. If that
   takes the tab down, the stored preference would bring it straight back
   to the same tier on reload. So the choice is written as *pending* first
   and only confirmed once we have survived a few seconds at it; a boot
   that finds an unconfirmed tier steps down instead of retrying. */
let confirmTimer = 0;

function applyTier(i, { toast: announce = false } = {}){
  tierIndex = (i + TIERS.length) % TIERS.length;
  const t = TIERS[tierIndex];
  field.setTier(t);
  el.qLabel.textContent = t.name;

  clearTimeout(confirmTimer);
  store.set(tierKey + 'Pending', t.id);
  confirmTimer = setTimeout(() => {
    store.set(tierKey, t.id);
    store.set(tierKey + 'Pending', null);
  }, 4000);

  resize(true);
  if(announce) toast(`${t.name} · ${sceneW} × ${sceneH} · ${fmtCount(totalParticles())} particles`);
}

function totalParticles(){
  return Object.values(field.counts).reduce((a,b)=>a+b, 0);
}
function fmtCount(n){
  return n >= 1000 ? (n/1000).toFixed(0) + 'k' : String(n);
}

function resize(force){
  if(!field) return;
  const cssW = Math.max(1, window.innerWidth);
  const cssH = Math.max(1, window.innerHeight);
  const dpr  = Math.min(window.devicePixelRatio || 1, 2);

  // The canvas backing store stays at device resolution; the scene is
  // rendered separately (often far larger) and resolved down into it.
  const outW = Math.floor(cssW * dpr), outH = Math.floor(cssH * dpr);
  if(el.canvas.width !== outW || el.canvas.height !== outH){
    el.canvas.width = outW; el.canvas.height = outH;
    el.canvas.style.width = cssW + 'px';
    el.canvas.style.height = cssH + 'px';
  }
  out.w = outW; out.h = outH;

  const r = field.resolutionFor(TIERS[tierIndex], cssW, cssH);
  if(view === 'solar' && solar && solar.hole){
    const k = solar.holeScale;
    r.w = Math.max(2, Math.floor(r.w * k));
    r.h = Math.max(2, Math.floor(r.h * k));
  }
  if(force || r.w !== sceneW || r.h !== sceneH){
    sceneW = r.w; sceneH = r.h;
    post.resize(sceneW, sceneH);
    field.resize(sceneW, sceneH, cssW / cssH);
    solar?.resize(sceneW, sceneH, cssW / cssH);

    // If the driver refused the target, drop a tier rather than render black.
    gl.bindFramebuffer(gl.FRAMEBUFFER, post.scene.fbo);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if(!ok && tierIndex > 0){
      toast('That resolution was refused by the GPU — stepping down.');
      applyTier(tierIndex - 1);
      return;
    }
    perf.win.length = 0;
    el.res.textContent = field.load < 0.99
      ? `${sceneW} × ${sceneH} · ${Math.round(field.load * 100)}%`
      : `${sceneW} × ${sceneH}`;
    el.res.classList.toggle('is-max', sceneW * sceneH > 12e6);
  }
}
const out = { w:1, h:1 };

window.addEventListener('resize', () => {
  resize(false);
  if(gateOpen) field.setComposition(gateOffset());
}, { passive:true });

/* ── palette / intensity ─────────────────────────────────── */

function applyPalette(i, announce){
  const p = field.setPalette(i);
  el.palLabel.textContent = p.name;
  el.swatch.style.setProperty('--s1', p.stops[1]);
  el.swatch.style.setProperty('--s2', p.stops[2]);
  el.swatch.style.setProperty('--s3', p.stops[3]);
  el.swatch.style.color = p.stops[2];
  store.set('palette', i);
  if(announce) toast(p.name);
}

el.gain.addEventListener('input', () => {
  field.intensity = parseFloat(el.gain.value);
  store.set('intensity', field.intensity);
});

/* ── popover menu ─────────────────────────────────────────────
   Cycling is fine for five colours and unusable for twenty-one
   pieces, so the dock buttons open a list instead. One component
   serves all three: anchored above its button, clamped to the
   viewport, and closed by a pick, an outside click or Escape. */

let openMenuEl = null, menuAnchor = null;

function closeMenu(){
  if(!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  menuAnchor?.setAttribute('aria-expanded', 'false');
  menuAnchor = null;
}

/**
 * @param anchor  the dock button the list belongs to
 * @param items   [{ id, name, blurb, group, swatch }]
 * @param current id of the selected item
 * @param onPick  called with the chosen id
 */
function openMenu(anchor, items, current, onPick){
  const reopening = menuAnchor === anchor;
  closeMenu();
  if(reopening) return;

  const menu = document.createElement('div');
  menu.className = 'menu';

  // The caret belongs to the frame, not the list: inside a scrolling box it
  // would slide up the middle of the options as you scroll.
  const list = document.createElement('div');
  list.className = 'menu__list';
  list.setAttribute('role', 'menu');
  menu.appendChild(list);

  let lastGroup = null;
  for(const it of items){
    if(it.group && it.group !== lastGroup){
      lastGroup = it.group;
      const h = document.createElement('div');
      h.className = 'menu__group';
      h.textContent = it.group;
      list.appendChild(h);
    }

    const b = document.createElement('button');
    b.className = 'menu__item' + (it.id === current ? ' is-on' : '');
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(it.id === current));

    const tick = document.createElement('span');
    tick.className = 'menu__tick';
    tick.setAttribute('aria-hidden', 'true');

    // A colour gets its own column; stacking it under the check made the
    // selected row unreadable.
    let sw = null;
    if(it.swatch){
      sw = document.createElement('span');
      sw.className = 'menu__sw';
      sw.setAttribute('aria-hidden', 'true');
      sw.style.setProperty('--sw', it.swatch);
    }

    const txt = document.createElement('span');
    txt.className = 'menu__txt';
    const nm = document.createElement('b');
    nm.textContent = it.name;
    txt.appendChild(nm);
    if(it.blurb){
      const d = document.createElement('i');
      d.textContent = it.blurb;
      txt.appendChild(d);
    }

    b.append(tick, ...(sw ? [sw] : []), txt);
    b.addEventListener('click', () => { closeMenu(); onPick(it.id); });
    list.appendChild(b);
  }

  document.body.appendChild(menu);
  openMenuEl = menu;
  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');

  // Anchor above the button, centred on it, clamped inside the viewport.
  const a = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const left = Math.min(Math.max(12, a.left + a.width / 2 - w / 2),
                        window.innerWidth - w - 12);
  menu.style.left = left + 'px';
  menu.style.bottom = (window.innerHeight - a.top + 10) + 'px';
  menu.style.setProperty('--caret', (a.left + a.width / 2 - left) + 'px');

  const sel = list.querySelector('.is-on');
  if(sel) list.scrollTop = sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2;
  showChrome();
}

document.addEventListener('pointerdown', e => {
  if(openMenuEl && !openMenuEl.contains(e.target) && !menuAnchor?.contains(e.target))
    closeMenu();
}, true);
window.addEventListener('resize', closeMenu);

/* ── particle design ─────────────────────────────────────── */

function applyMode(i, announce){
  const m = field.setMode(i);
  el.formLabel.textContent = m.name;
  store.set('mode', field.modeB);
  if(announce) toast(m.name);
}

/* ── the solar system ─────────────────────────────────────── */

const HOLE_FACTS = [
  ['Horizon',      'The Schwarzschild radius — where escape velocity reaches light speed'],
  ['Photon ring',  '1.5 rs — the orbit light itself can hold, briefly'],
  ['Shadow',       'About 2.6 rs across, larger than the horizon because of the lensing'],
  ['Disc',         'Matter spiralling in, heated by friction to millions of degrees'],
  ['Beaming',      'The side rotating toward you is boosted; the far side dims'],
  ['Sagittarius A*','4.3 million solar masses, 26,000 light years away'],
  ['First image',  'Event Horizon Telescope, M87*, 2019']
];

function enterSolar(which){
  if(!solar) return;
  view = 'solar';
  el.solarUI.hidden = false;
  document.body.classList.add('is-solar');

  if(which === 'hole'){
    solar.viewHole();
    el.solarGhost.textContent = 'Black Hole';
    el.solarOrd.textContent = 'Not of this system';
    el.solarName.textContent = 'Black Hole';
    el.solarBlurb.textContent =
      'A Schwarzschild horizon. The light you see around it is not painted on — '
      + 'each ray is integrated along its geodesic, which is what produces the '
      + 'photon ring and lifts the far side of the accretion disc over the top.';
    el.solarFacts.replaceChildren();
    for(const [k, v] of HOLE_FACTS){
      const row = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      row.append(dt, dd);
      el.solarFacts.appendChild(row);
    }
    [...el.solarNav.children].forEach(d => d.classList.remove('is-on'));
    el.formLabel.textContent = 'Black Hole';
    document.body.classList.add('is-hole');
    store.set('view', 'solar'); store.set('body', 'hole');
    resize(true);
    showChrome();
    return;
  }

  const wasHole = solar.hole;
  document.body.classList.remove('is-hole');
  solar.leaveHole();
  if(wasHole) resize(true);
  if(which === 'all'){ solar.viewAll(); }
  else {
    const i = BODIES.findIndex(b => b.id === which);
    const want = i < 0 ? 3 : i;
    if(want === solar.focus) solar.frameLit();     // re-entering the same body
    else solar.setFocus(want);
  }
  syncSolar();
  el.formLabel.textContent = which === 'all' ? 'The System' : solar.focused.name;
  store.set('view', 'solar');
  store.set('body', which);
  showChrome();
}

function leaveSolar(){
  if(view !== 'solar') return;
  const wasHole = solar && solar.hole;
  solar?.leaveHole();
  view = 'field';
  document.body.classList.remove('is-hole');
  if(wasHole) resize(true);
  el.solarUI.hidden = true;
  el.solarPanel.hidden = true;
  el.solarUI.classList.remove('is-open');
  document.body.classList.remove('is-solar');
  store.set('view', 'field');
}

function syncSolar(){
  const b = solar.focused;
  el.solarGhost.textContent = b.name;
  el.solarOrd.textContent = b.kind === 'star'
    ? 'The star'
    : `${['','First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth'][solar.focus]} planet from the Sun`;
  el.solarName.textContent = b.name;
  el.solarBlurb.textContent = b.blurb;
  el.formLabel.textContent = b.name;

  el.solarFacts.replaceChildren();
  for(const [k, v] of b.facts){
    const row = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    row.append(dt, dd);
    el.solarFacts.appendChild(row);
  }

  [...el.solarNav.children].forEach((d, i) =>
    d.classList.toggle('is-on', i === solar.focus));

  const n = BODIES.length;
  el.solarPrev.querySelector('span').textContent = BODIES[(solar.focus - 1 + n) % n].name;
  el.solarNext.querySelector('span').textContent = BODIES[(solar.focus + 1) % n].name;
}

function buildSolarNav(){
  el.solarNav.replaceChildren();
  BODIES.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.className = 'solar__dot';
    btn.title = b.name;
    const dot = document.createElement('i');
    // Sized by the cube root of radius, so Jupiter reads bigger than
    // Mercury without making Mercury invisible.
    dot.style.setProperty('--d',
      (3.5 + Math.pow(b.radiusKm / 6371, 0.33) * 3.4).toFixed(1) + 'px');
    const lab = document.createElement('span');
    lab.textContent = b.name;
    btn.append(dot, lab);
    btn.addEventListener('click', () => { solar.setFocus(i); syncSolar(); });
    el.solarNav.appendChild(btn);
  });
}

el.solarPrev.addEventListener('click', () => {
  solar.setFocus((solar.focus - 1 + BODIES.length) % BODIES.length); syncSolar();
});
el.solarNext.addEventListener('click', () => {
  solar.setFocus((solar.focus + 1) % BODIES.length); syncSolar();
});
el.solarDiscover.addEventListener('click', () => {
  const open = el.solarPanel.hidden;
  el.solarPanel.hidden = !open;
  el.solarUI.classList.toggle('is-open', open);
});
el.solarClose.addEventListener('click', () => {
  el.solarPanel.hidden = true;
  el.solarUI.classList.remove('is-open');
});

/* ── generative scene ────────────────────────────────────── */

function applyScene(id, announce){
  const s = audio.setScene(id);
  el.sceneLabel.textContent = s.name;
  store.set('scene', s.id);
  if(musicOnly) syncNowPlaying(); else setMediaSession();
  if(announce) toast(`${s.name} — ${s.blurb}`);
  return s;
}

function nextScene(){
  const i = SCENES.findIndex(x => x.id === audio.sceneId);
  return SCENES[(i + 1) % SCENES.length].id;
}

// launch-screen chips, one per piece
SCENES.forEach(sc => {
  const b = document.createElement('button');
  b.className = 'chip';
  b.innerHTML = `<b>${sc.name}</b><i>${sc.blurb}</i>`;
  b.addEventListener('click', () => { applyScene(sc.id); pick('ambient'); });
  el.sceneChips.appendChild(b);
});

/* ── source selection ────────────────────────────────────── */

let busy = false;

async function pick(kind){
  if(busy) return;
  busy = true;
  note('');
  try{
    if(kind === 'system'){
      note('Choose a tab or your screen, then switch on “Share audio”.');
      await audio.useSystem();
      label('System Audio');
    } else if(kind === 'mic'){
      await audio.useMic();
      label('Microphone');
    } else if(kind === 'file'){
      busy = false;
      el.picker.click();
      return;
    } else {
      await audio.useAmbient(audio.sceneId);
      el.sceneLabel.textContent = audio.scene.name;
      label('Ambient');
    }
    closeGate();
    if(musicOnly) syncNowPlaying(); else setMediaSession();
  }catch(err){
    console.warn(err);
    const msg = err?.name === 'NotAllowedError'
      ? 'Permission was declined. Pick another source, or try again.'
      : (err?.message || 'That source could not be opened.');
    note(msg, true);
    if(el.gate.classList.contains('is-gone')) toast(msg);
  }finally{
    busy = false;
    syncTransport();
  }
}

async function playFile(file){
  if(!file) return;
  if(!/^audio\//.test(file.type) && !/\.(mp3|m4a|aac|wav|flac|ogg|opus|aiff?)$/i.test(file.name)){
    const m = 'That file does not look like audio.';
    note(m, true); toast(m); return;
  }
  try{
    await audio.useFile(file);
    label(audio.trackName || 'Audio File');
    closeGate();
    toast(audio.trackName || file.name);
  }catch(err){
    note('Could not decode that file.', true);
  }
  syncTransport();
}

el.picker.addEventListener('change', e => { playFile(e.target.files?.[0]); e.target.value = ''; });

document.querySelectorAll('[data-source]').forEach(b =>
  b.addEventListener('click', () => pick(b.dataset.source)));

// Say up front what this browser cannot do, rather than after a click.
if(!navigator.mediaDevices?.getDisplayMedia){
  document.querySelectorAll('[data-source="system"]').forEach(b => {
    b.classList.add('is-off');
    b.title = 'System audio capture needs a Chromium browser on desktop';
  });
}
if(!navigator.mediaDevices?.getUserMedia){
  document.querySelectorAll('[data-source="mic"]').forEach(b => b.classList.add('is-off'));
}

function onBeat(strength){
  // Only one ring per hit, and an off-centre companion just for the
  // strongest ones — more than that and the surface turns to noise.
  field.spawnRipple(0, 0, 0.30 + strength * 0.52);
  if(strength > 0.8 && Math.random() < 0.35){
    const a = Math.random() * Math.PI * 2, r = 1.2 + Math.random() * 2.4;
    field.spawnRipple(Math.cos(a)*r, Math.sin(a)*r, 0.14 + strength * 0.20);
  }
  const n = profile.mobile ? 40 + (strength * 90) | 0 : 90 + (strength * 260) | 0;
  field.emitSparks(n, strength, audio.centroid);
  field.cam.shake = Math.min(1, field.cam.shake + strength * 0.42);
}

function label(name){
  el.srcLabel.textContent = name;
  el.statusTxt.textContent = name;
  el.status.classList.add('is-live');
}
function note(msg, warn){
  el.note.textContent = msg || '';
  el.note.classList.toggle('warn', !!warn);
}

/* ── gate ────────────────────────────────────────────────── */

let gateOpen = true;
function closeGate(){
  if(!gateOpen) return;
  gateOpen = false;
  document.body.classList.remove('is-gate');
  el.gate.classList.add('is-gone');
  setTimeout(() => { el.gate.hidden = true; }, 850);
  field.setComposition(0);
  kick();
}
function openGate(){
  closeMenu();
  gateOpen = true;
  document.body.classList.add('is-gate');
  el.gate.hidden = false;
  field.setComposition(gateOffset());
  requestAnimationFrame(() => el.gate.classList.remove('is-gone'));
  note('');
  showChrome();
}
el.btnSource.addEventListener('click', openGate);

/* The launch copy occupies the left rail, so the form slides right to
   make room, then glides back to centre once a source is chosen. */
function gateOffset(){
  return window.innerWidth < 900 ? 0 : 0.34;
}

/* ── transport ───────────────────────────────────────────── */

function syncTransport(){
  if('mediaSession' in navigator)
    try{ navigator.mediaSession.playbackState = audio.playing ? 'playing' : 'paused'; }catch{}
  const isFile = audio.kind === 'file';
  el.scrub.classList.toggle('is-on', isFile);
  el.btnScene.style.display = audio.kind === 'ambient' ? '' : 'none';
  const canToggle = isFile || audio.kind === 'ambient';
  el.btnPlay.style.display = canToggle ? '' : 'none';
  el.btnPlay.classList.toggle('is-playing', audio.playing);
  document.body.classList.toggle('is-playing', audio.playing);
  if(!audio.ready){ el.status.classList.remove('is-live'); el.statusTxt.textContent = 'Idle'; }
}

el.btnPlay.addEventListener('click', () => { audio.toggle(); setTimeout(syncTransport, 30); });

function seekFromEvent(e){
  const r = el.scrub.querySelector('.scrub__rail').getBoundingClientRect();
  const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  if(audio.duration) audio.position = t * audio.duration;
}
el.scrub.addEventListener('pointerdown', e => {
  el.scrub.setPointerCapture(e.pointerId); seekFromEvent(e);
  const move = ev => seekFromEvent(ev);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

function fmtTime(s){
  if(!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2,'0')}`;
}

/* ── chrome auto-hide ────────────────────────────────────── */

const COARSE = matchMedia('(pointer: coarse)').matches;
const HIDE_AFTER = COARSE ? 7000 : 4200;
let hideAt = performance.now() + HIDE_AFTER, manualHide = false;

function showChrome(){
  manualHide = false;
  document.body.classList.remove('is-hidden-ui');
  hideAt = performance.now() + HIDE_AFTER;
}
function tickChrome(now){
  if(manualHide || gateOpen || openMenuEl) return;
  if(now > hideAt) document.body.classList.add('is-hidden-ui');
}
['pointermove','pointerdown','wheel','keydown','touchstart'].forEach(evt =>
  window.addEventListener(evt, showChrome, { passive:true }));

/* ── pointer: orbit + dolly ──────────────────────────────── */

const touches = new Map();
let dragging = false, lastX = 0, lastY = 0, pinchDist = 0;

el.canvas.addEventListener('pointerdown', e => {
  touches.set(e.pointerId, { x:e.clientX, y:e.clientY });
  el.canvas.setPointerCapture(e.pointerId);
  if(touches.size === 1){ dragging = true; lastX = e.clientX; lastY = e.clientY; }
  else if(touches.size === 2){ dragging = false; pinchDist = spread(); }
});

el.canvas.addEventListener('pointermove', e => {
  if(!field || !touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x:e.clientX, y:e.clientY });

  const R = (view === 'solar' && solar) ? solar : field;
  if(touches.size >= 2){
    // Two fingers dolly; one orbits. Same gesture vocabulary as a map.
    const d = spread();
    if(pinchDist > 0 && d > 0) R.dolly((pinchDist - d) * 1.9);
    pinchDist = d;
    return;
  }
  if(!dragging) return;
  R.orbit(e.clientX - lastX, e.clientY - lastY);
  lastX = e.clientX; lastY = e.clientY;
});

function spread(){
  const [a, b] = [...touches.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}
const endDrag = e => {
  touches.delete(e.pointerId);
  if(touches.size < 2) pinchDist = 0;
  if(touches.size === 0) dragging = false;
  else { const p = [...touches.values()][0]; lastX = p.x; lastY = p.y; dragging = true; }
};
el.canvas.addEventListener('pointerup', endDrag);
el.canvas.addEventListener('pointercancel', endDrag);
el.canvas.addEventListener('wheel', e => {
  if(!field) return;
  e.preventDefault();
  ((view === 'solar' && solar) ? solar : field).dolly(e.deltaY);
}, { passive:false });

// A resting pointer still nudges the camera — parallax keeps it alive.
let px = 0, py = 0;
window.addEventListener('pointermove', e => {
  px = (e.clientX / window.innerWidth) * 2 - 1;
  py = (e.clientY / window.innerHeight) * 2 - 1;
}, { passive:true });

/* ── drag & drop ─────────────────────────────────────────── */

let dragDepth = 0;
window.addEventListener('dragenter', e => {
  e.preventDefault();
  if(++dragDepth === 1) el.drop.hidden = false;
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', e => {
  e.preventDefault();
  if(--dragDepth <= 0){ dragDepth = 0; el.drop.hidden = true; }
});
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; el.drop.hidden = true;
  playFile(e.dataTransfer?.files?.[0]);
});

/* ── buttons ─────────────────────────────────────────────── */

el.btnForm.addEventListener('click', () => {
  const items = MODES.map(m => ({ id:m.id, name:m.name, blurb:m.blurb, group:m.group }));
  // The system is one more thing you can be looking at, so it belongs in
  // the same list rather than behind a separate switch.
  if(solar){
    items.push({ id:'solar:all', name:'The System', group:'Solar System',
                 blurb:'All nine bodies, seen from outside the orbits' });
    for(const b of BODIES)
      items.push({ id:'solar:' + b.id, name:b.name, group:'Solar System', blurb:b.blurb });
    items.push({ id:'solar:hole', name:'Black Hole', group:'Deep Field',
                 blurb:'Light bent around a Schwarzschild horizon' });
  }

  const current = view === 'solar' && solar
    ? (solar.hole ? 'solar:hole' : 'solar:' + solar.focused.id)
    : MODES[field.modeB].id;
  openMenu(el.btnForm, items, current, id => {
    if(id.startsWith('solar:')) enterSolar(id.slice(6));
    else { leaveSolar(); applyMode(MODES.findIndex(m => m.id === id), false); }
  });
});

el.btnScene.addEventListener('click', () => {
  // Grouping is derived from what the piece actually uses, so a new
  // entry lands in the right section without being labelled by hand.
  const groupOf = sc =>
      sc.prog                      ? 'Uplifting'
    : sc.drops || sc.noiseGain > .06 ? 'Texture'
    : sc.calm && !sc.drums         ? 'Calm'
    : sc.calm                      ? 'Calm'
    :                                'Rhythmic';
  openMenu(el.btnScene,
    SCENES.map(sc => ({ id:sc.id, name:sc.name, blurb:sc.blurb, group:groupOf(sc) })),
    audio.sceneId,
    id => applyScene(id, false));
});

el.btnPalette.addEventListener('click', () => {
  openMenu(el.btnPalette,
    PALETTES.map(p => ({ id:p.id, name:p.name, swatch:p.stops[2] })),
    PALETTES[field.paletteIndex].id,
    id => applyPalette(PALETTES.findIndex(p => p.id === id), false));
});
el.btnQuality.addEventListener('click', () => applyTier(tierIndex + 1, { toast:true }));
el.btnFull.addEventListener('click', toggleFullscreen);
el.btnHelp.addEventListener('click', () => { el.help.hidden = false; });

// The shortcut list is hidden on touch, so the footer carries the gestures.
if(COARSE){
  const foot = document.querySelector('.sheet__foot');
  if(foot) foot.textContent =
    'Drag to orbit · Pinch to zoom · Tap an icon to change it · Drop an audio file to play it';
}
el.help.addEventListener('click', e => {
  if(e.target === el.help || e.target.hasAttribute('data-close')) el.help.hidden = true;
});

function toggleFullscreen(){
  if(document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(()=>{});
}

/* ── chrome ──────────────────────────────────────────────────
   The dock holds every control on every screen. On a phone the
   labels drop away and it becomes a single row of icons — no
   drawer, no second layer to go looking in. Each tap toasts what
   it changed, which is what the label was doing anyway. */

/* The intensity slider has no room in the phone dock, so it moves into the
   Controls sheet there — the node itself moves, so its listener and value
   come with it and no second element claims the same id. */
const narrowUI = matchMedia('(max-width: 760px)');
const gainHome = { parent: el.gainWrap.parentNode, next: el.gainWrap.nextSibling };
const gainSlot = $('sheetIntensity');

function placeGain(){
  if(narrowUI.matches){
    if(el.gainWrap.parentNode !== gainSlot) gainSlot.appendChild(el.gainWrap);
  } else if(el.gainWrap.parentNode !== gainHome.parent){
    gainHome.parent.insertBefore(el.gainWrap, gainHome.next);
  }
}
narrowUI.addEventListener('change', placeGain);
placeGain();

// Full screen is not available to web pages on iOS Safari; do not offer it.
if(!document.documentElement.requestFullscreen && !document.documentElement.webkitRequestFullscreen){
  el.btnFull.style.display = 'none';
}

/* ── toast ───────────────────────────────────────────────── */

let toastTimer = 0;
function toast(msg){
  el.toast.hidden = false;
  el.toast.textContent = msg;
  requestAnimationFrame(() => el.toast.classList.add('is-on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('is-on');
    setTimeout(() => { el.toast.hidden = true; }, 420);
  }, 3400);
}

/* ── keyboard ────────────────────────────────────────────── */

window.addEventListener('keydown', e => {
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  if(!field) return;
  const k = e.key;
  if(k === 'Escape'){
    if(openMenuEl) closeMenu();
    else if(!el.help.hidden) el.help.hidden = true;
    else if(!gateOpen && document.fullscreenElement) document.exitFullscreen?.();
    return;
  }
  if(gateOpen && k !== '?') return;

  switch(k){
    case ' ': e.preventDefault(); audio.toggle(); setTimeout(syncTransport, 30); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'p': case 'P': applyPalette(field.paletteIndex + 1, true); break;
    case 'm': case 'M': applyMode(field.modeB + 1, true); break;
    case 'n': case 'N':
      if(audio.kind === 'ambient') applyScene(nextScene(), true);
      break;
    case 'q': case 'Q': applyTier(tierIndex + 1, { toast:true }); break;
    case 's': case 'S': openGate(); break;
    case 'r': case 'R': ((view === 'solar' && solar) ? solar : field).recentre(); break;
    case 'b': case 'B': setMusicOnly(!musicOnly); break;
    case 'h': case 'H':
      manualHide = !manualHide;
      document.body.classList.toggle('is-hidden-ui', manualHide);
      break;
    case '?': el.help.hidden = !el.help.hidden; break;
    default:
      if(k >= '1' && k <= '5') applyPalette(parseInt(k,10) - 1, true);
  }
});

/* ── music only ───────────────────────────────────────────────
   Stops the renderer outright: no canvas, no rAF, no per-frame
   work. A CSS gradient carries the screen, the browser composites
   it, and the phone is free to switch the display off — which is
   the entire point, and why this mode also *releases* the wake
   lock the visual modes hold. */

let musicOnly = false, rafId = 0, musicTimer = 0;

function setMusicOnly(on, { announce = true } = {}){
  musicOnly = !!on;
  document.body.classList.toggle('is-music', musicOnly);
  el.np.hidden = !musicOnly;
  el.btnMusicOnly.setAttribute('aria-checked', String(musicOnly));
  store.set('musicOnly', musicOnly);

  clearInterval(musicTimer);
  if(musicOnly){
    if(rafId){ cancelAnimationFrame(rafId); rafId = 0; }
    releaseScreen();                      // let the phone sleep
    syncNowPlaying();
    // A slow tick only while the screen is actually being looked at.
    musicTimer = setInterval(tickMusic, 200);
    if(announce) toast('Visuals off — audio keeps playing');
  } else {
    holdScreen();
    startLoop();
    if(announce) toast('Visuals on');
  }
  syncTransport();
}

function tickMusic(){
  if(document.visibilityState !== 'visible') return;   // nothing at all in the pocket
  audio.update(0.2);
  const spec = audio.spectrum;
  el.npBars.children.length && [...el.npBars.children].forEach((b, i) => {
    const v = spec[Math.round((i / (el.npBars.children.length - 1)) * 0.74 * spec.length) | 0] || 0;
    // Calm pieces sit low in the meter; a little gain keeps it alive
    // without ever pinning.
    b.style.setProperty('--h', Math.min(1, Math.pow(v, 0.72) * 1.45).toFixed(3));
  });
  el.npPlay.classList.toggle('is-playing', audio.playing);
  document.body.classList.toggle('is-playing', audio.playing);
}

function groupOfScene(sc){
  return sc.prog ? 'Uplifting'
       : (sc.drops || sc.noiseGain > 0.06) ? 'Texture'
       : sc.calm ? 'Calm' : 'Rhythmic';
}

function syncNowPlaying(){
  const ambient = audio.kind === 'ambient';
  const sc = ambient ? audio.scene : null;
  el.npTitle.textContent = ambient ? sc.name : (audio.trackName || sourceLabel());
  el.npGroup.textContent = ambient ? groupOfScene(sc) : sourceLabel();
  el.npBlurb.textContent = ambient ? sc.blurb : '';
  el.npPrev.style.display = el.npNext.style.display = ambient ? '' : 'none';
  el.npNote.textContent = BACKGROUND_NOTE;
  setMediaSession();
}

function sourceLabel(){
  return { system:'System Audio', mic:'Microphone', file:'Audio File', ambient:'Ambient' }[audio.kind] || 'Idle';
}

/* Honest about the platform. Safari suspends Web Audio when the screen
   locks, and synthesised audio has no media element for iOS to keep
   alive, so there is no way round it from a web page. */
const BACKGROUND_NOTE = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ? 'On iOS, Safari pauses synthesised audio when the screen locks. Keep the screen on, or play an audio file instead — files continue in the background.'
  : 'Safe to lock the screen — playback continues.';

/* Lock-screen and headphone controls. */
function setMediaSession(){
  if(!('mediaSession' in navigator)) return;
  const ambient = audio.kind === 'ambient';
  const sc = ambient ? audio.scene : null;
  try{
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  ambient ? sc.name : (audio.trackName || sourceLabel()),
      artist: 'Resonance',
      album:  ambient ? groupOfScene(sc) + ' · generative' : sourceLabel()
    });
    navigator.mediaSession.playbackState = audio.playing ? 'playing' : 'paused';
    navigator.mediaSession.setActionHandler('play',  () => { audio.toggle(); afterTransport(); });
    navigator.mediaSession.setActionHandler('pause', () => { audio.toggle(); afterTransport(); });
    navigator.mediaSession.setActionHandler('nexttrack',     ambient ? () => stepScene( 1) : null);
    navigator.mediaSession.setActionHandler('previoustrack', ambient ? () => stepScene(-1) : null);
  }catch{}
}

function stepScene(dir){
  const i = SCENES.findIndex(x => x.id === audio.sceneId);
  const next = SCENES[(i + dir + SCENES.length) % SCENES.length].id;
  applyScene(next, !musicOnly);
  syncNowPlaying();
}

function afterTransport(){
  setTimeout(() => { syncTransport(); if(musicOnly) syncNowPlaying(); }, 30);
}

el.btnMusicOnly.addEventListener('click', () => setMusicOnly(!musicOnly));
el.npExit.addEventListener('click', () => setMusicOnly(false));
el.npPlay.addEventListener('click', () => { audio.toggle(); afterTransport(); });
el.npPrev.addEventListener('click', () => stepScene(-1));
el.npNext.addEventListener('click', () => stepScene(1));

/* ── frame loop ──────────────────────────────────────────── */

let last = performance.now();
let fpsAcc = 0, fpsN = 0, governorAt = performance.now() + 9000;
let uiAcc = 0;

function frame(now){
  if(musicOnly){ rafId = 0; return; }
  rafId = requestAnimationFrame(frame);
  if(!field) return;

  let dt = (now - last) / 1000;
  last = now;
  if(dt > 0.1) dt = 0.1;           // a tab regaining focus must not teleport the field
  if(dt <= 0) return;

  audio.update(dt);

  // resting-pointer parallax, applied as a gentle pull on the camera
  field.cam.yawV   += (-px * 0.00035 - field.cam.yawV   * 0.0) * dt * 2.2;
  field.cam.pitchV += (-py * 0.00022 - field.cam.pitchV * 0.0) * dt * 2.2;

  post.beginScene();
  gl.viewport(0, 0, sceneW, sceneH);
  post.grade((view === 'solar' && solar) ? 'solar' : 'field', Math.min(1, dt * 3.5));
  // Outside the hole the dial tracks the field's load; inside it the
  // governor owns it directly, so it must not be overwritten here.
  if(solar && !solar.hole) solar.quality = field.load;
  if(view === 'solar' && solar) solar.render(dt, audio);
  else                          field.render(dt, audio);
  post.render(out.w, out.h, (view === 'solar' && solar) ? solar.time : field.time);

  tickChrome(now);

  uiAcc += dt;
  if(uiAcc > 1/30){
    updateUI(uiAcc);
    if(view === 'solar' && solar)
      el.solarAlt.textContent = solar.hole ? solar.holeAltitudeLabel : solar.altitudeLabel;
    uiAcc = 0;
  }

  // ── adaptive governor: protect the frame rate, never the ego
  govern(now, dt);
}

/* ── adaptive governor ───────────────────────────────────────
   No amount of sniffing tells you how fast a phone actually is, so
   the renderer measures itself. Load starts below the device's
   ceiling and climbs only while frames are cheap; a struggling
   device simply never gets promoted, and one that starts to
   struggle sheds work within about a second.

   The median is used rather than the mean: a single long frame from
   a GC pause or a scroll should not trigger a downgrade.          */

const perf = {
  win: [], warmUntil: 0, nextDown: 0, nextUp: 0, started: false
};

const SLOW_MS = 24.0;   // worse than ~42fps for a while: shed work
/* Must sit above a 60Hz vsync interval. A device holding a perfect 60fps
   reports 16.7ms, so a threshold below that would read "comfortable" as
   "struggling" and strand every 60Hz phone at its opening settings. */
const FAST_MS = 18.5;   // holding ~54fps or better: there is room to grow

function govern(now, dt){
  // A hidden or occluded tab throttles rAF to a crawl, and a long frame
  // after a stall is not the GPU's fault. Neither may count.
  if(document.visibilityState !== 'visible' || dt > 0.05){ perf.win.length = 0; return; }

  if(!perf.started){
    perf.started = true;
    perf.warmUntil = now + 1200;      // shaders warm, first frames are lies
    perf.nextDown = perf.warmUntil;
    perf.nextUp = now + 2500;     // reach full quality quickly when able
    return;
  }
  if(now < perf.warmUntil) return;

  perf.win.push(dt * 1000);
  if(perf.win.length < 24) return;

  const sorted = perf.win.slice().sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  perf.win.length = 0;

  /* The black hole has its own dial — integration steps — which costs
     nothing to change. Going through setLoad here would call resize(),
     and reallocating every framebuffer mid-flight is itself a visible
     hitch: the governor would then see the stutter it had just caused
     and react to it again, a loop that never settles. */
  if(view === 'solar' && solar && solar.hole){
    if(median > SLOW_MS && now > perf.nextDown){
      solar.quality = Math.max(0.35, solar.quality * 0.78);
      perf.nextDown = now + 900;
      perf.nextUp = now + 6000;
    } else if(median < FAST_MS && solar.quality < 1 && now > perf.nextUp){
      solar.quality = Math.min(1, solar.quality * 1.15);
      perf.nextUp = now + 1800;
    }
    return;
  }

  if(median > SLOW_MS && now > perf.nextDown){
    if(field.setLoad(field.load * 0.72)){
      resize(true);
      perf.nextDown = now + 1500;
      perf.nextUp = now + 12000;      // do not immediately undo it
    } else if(tierIndex > 0){
      // Already at the geometry floor, so drop a whole tier.
      applyTier(tierIndex - 1);
      toast(`Eased to ${TIERS[tierIndex].name} to hold the frame rate.`);
      perf.nextDown = now + 6000;
    }
  } else if(median < FAST_MS && field.load < 1 && now > perf.nextUp){
    if(field.setLoad(field.load * 1.25)){
      resize(true);
      perf.nextUp = now + 2500;
    }
  }
}
function updateUI(){
  // status spectrum bars
  const spec = audio.spectrum;
  el.bars.forEach((b, i) => {
    const v = spec[Math.round((i / (el.bars.length - 1)) * 0.72 * spec.length) | 0] || 0;
    b.style.height = (3 + Math.min(1, v) * 10).toFixed(1) + 'px';
  });

  // output meter
  const lvl = audio.level;
  el.meter.forEach((m, i) => {
    const t = i / (el.meter.length - 1);
    m.style.setProperty('--h', Math.max(0, Math.min(1, (lvl - t * 0.82) * 3.2)).toFixed(3));
  });

  // transport
  if(audio.kind === 'file' && audio.duration){
    const p = audio.position / audio.duration;
    el.scrubFill.style.width = (p * 100).toFixed(2) + '%';
    el.scrubKnob.style.left  = (p * 100).toFixed(2) + '%';
    el.scrubTime.textContent = fmtTime(audio.position);
    const playing = audio.playing;
    if(el.btnPlay.classList.contains('is-playing') !== playing){
      el.btnPlay.classList.toggle('is-playing', playing);
    }
  }
}

/* ── keep the screen awake ────────────────────────────────────
   This is meant to be left running. Without a wake lock the display
   sleeps and the piece is playing to a dark room. The lock is
   dropped by the browser whenever the tab is hidden, so it has to be
   taken again every time we come back. */
let wakeLock = null;

async function holdScreen(){
  // Music-only exists so the screen *can* sleep; never fight that.
  if(musicOnly) return;
  if(!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  if(wakeLock) return;
  try{
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  }catch{ wakeLock = null; }          // denied or unsupported: not fatal
}
function releaseScreen(){
  try{ wakeLock?.release(); }catch{}
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible'){
    if(audio.ready && !musicOnly) holdScreen();
    // Coming back from the background, the context may have been suspended.
    audio.resume();
  } else releaseScreen();
});

/* ── idle life before any source is chosen ───────────────── */

function kick(){ audio.resume(); holdScreen(); }

// Keep the field breathing behind the gate so the first frame is alive.
(function idlePulse(){
  setTimeout(() => {
    if(field && audio && !audio.ready){
      field.spawnRipple((Math.random()-0.5)*2.6, (Math.random()-0.5)*2.6, 0.22 + Math.random()*0.14);
      field.emitSparks(24, 0.3, 0.3);
    }
    idlePulse();
  }, 1500 + Math.random() * 1800);
})();

/* ── go ──────────────────────────────────────────────────── */

async function boot(){
  document.body.classList.add('is-gate', 'is-booting');
  try{
    gl      = getContext(el.canvas);
    profile = profileDevice(gl);
    post    = new Post(gl);
    audio   = new AudioEngine();

    // Build the field in chunks so the launch screen paints and stays
    // responsive while the shaders link and the buffers fill.
    field = await Field.create(gl, profile);

    /* The solar system is desktop-only. Not merely hidden — not built:
       skipping it avoids compiling six more shader programs, which is
       real time on a phone, and avoids the geodesic integrator entirely
       on the hardware least able to carry it. */
    solar = profile.mobile ? null : new Solar(gl, profile);
  }catch(err){
    fatal(err);
    return;
  }

  // On a handset the top tiers are not offered at all.
  TIERS.length = Math.min(TIERS.length, profile.maxTier + 1);

  tierKey = profile.mobile ? 'tier.m' : 'tier';
  storedTier = store.get(tierKey, null);
  const pending = store.get(tierKey + 'Pending', null);

  tierIndex = storedTier ? TIERS.findIndex(t => t.id === storedTier) : -1;
  if(tierIndex < 0) tierIndex = profile.defaultTier;
  if(pending){
    // An unconfirmed tier from last time means we did not survive it.
    const pi = TIERS.findIndex(t => t.id === pending);
    if(pi >= 0) tierIndex = Math.max(0, Math.min(tierIndex, pi - 1));
    store.set(tierKey + 'Pending', null);
  }
  tierIndex = Math.max(0, Math.min(tierIndex, profile.maxTier));

  document.body.classList.toggle('is-mobile', profile.mobile);

  audio.sceneId = store.get('scene', 'solace');
  el.sceneLabel.textContent = audio.scene.name;
  audio.onended = kind => { if(kind === 'file') syncTransport(); };
  audio.onbeat = onBeat;

  field.intensity = store.get('intensity', 1);
  el.gain.value = field.intensity;

  applyMode(store.get('mode', 0), false);
  field.morph = 0; field.morphRate = 0; field.modeA = field.modeB;
  applyPalette(store.get('palette', 0), false);
  applyTier(tierIndex);
  resize(true);
  field.setComposition(gateOffset(), true);
  syncTransport();

  if(solar){
    buildSolarNav();
    if(store.get('view', 'field') === 'solar') enterSolar(store.get('body', 'earth'));
  } else {
    // A view stored from a desktop session must not strand a phone.
    view = 'field';
    el.solarUI.hidden = true;
  }

  document.body.classList.remove('is-booting');
  window.__resonance = { gl, field, solar, post, audio, profile,
    enterSolar, leaveSolar, setMusicOnly,
    get view(){ return view; },
    get musicOnly(){ return musicOnly; },
    get wakeLockHeld(){ return !!wakeLock; },
    applyTier, applyMode, applyPalette, applyScene,
    get tier(){ return TIERS[tierIndex]; },
    get tierIndex(){ return tierIndex; },
    get scene(){ return [sceneW, sceneH]; } };

  setMusicOnly(store.get('musicOnly', false), { announce:false });
  startLoop();
}

function startLoop(){
  if(rafId || musicOnly) return;
  last = performance.now();
  rafId = requestAnimationFrame(frame);
}

boot();

document.addEventListener('visibilitychange', () => { if(!document.hidden) last = performance.now(); });
