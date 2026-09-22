# Resonance

A real-time particle equalizer. Two hundred and seventy thousand points of
light, displaced by the frequency, transient and phase of whatever you play.

No build step, no dependencies, no framework — WebGL2 and the Web Audio API.

---

## Run it locally

```bash
python3 scripts/dev-server.py 8777
```

(`python3 -m http.server` works too, but it sends no cache headers, so browsers
hold on to ES modules across edits and you end up debugging code you already
replaced. The script above serves the same files with `no-store`.)

Then open <http://localhost:8777>. Any static server works; it must be served
over `http://` or `https://`, not opened as a `file://` URL, because the code
is loaded as ES modules.

## Deploy to Vercel

It is a static site, so there is nothing to build.

```bash
npx vercel deploy --prod
```

Or push the folder to a Git repository and import it at
[vercel.com/new](https://vercel.com/new) — accept the defaults, leaving the
build command empty and the output directory as the project root.

`vercel.json` already sets the `Permissions-Policy` header that microphone and
system-audio capture need. Both are gated behind a secure origin, which Vercel
provides automatically.

---

## Sources

| Source | Notes |
| --- | --- |
| **System audio** | Anything playing on the machine. Chromium only. Pick a **Tab** or **Entire Screen** and switch on *Share audio* — Chrome does not offer audio for a single window. |
| **Microphone** | The room, live. Never monitored back to the speakers. |
| **Audio file** | Drop a track anywhere on the page, or browse. Loops by default. |
| **Generative** | Ten pieces, synthesised live. They never end and never repeat. |

Safari supports microphone and file playback; it does not implement
`getDisplayMedia` with audio, so system capture is Chromium-only.

## The generative pieces

Each is a parameter set over one engine — scale, register, tempo, timbre,
space, and a one-bar drum pattern on a sixteenth grid. Nothing is sampled and
nothing loops.

`Drift` · `Pulse` · `Tide` · `Bloom` · `Glass` · `Rain` · `Choir` · `Circuit`
· `Kinetic` · `Lattice`

Percussion is synthesised: a pitch-dropping sine kick with a filtered click
transient, band-passed noise snares with a tonal body, and high-passed hats.
When a piece is playing its own music, the sequencer hands the visuals the
exact hit times rather than relying on onset detection, so the ripples land on
the beat instead of near it.

## The particle designs

| Design | What it is |
| --- | --- |
| **Orb** | A hollow, noise-crumpled shell. Azimuth maps to frequency, mirrored, so the form stays symmetric. Brightness is Fresnel-weighted, which densifies the silhouette and leaves the centre open. |
| **Corona** | A radial fountain — the literal equalizer. Angle is frequency, height is amplitude. |
| **Cymatic** | A Chladni plate. Particles relax onto the nodal lines of a standing wave by Newton iteration, which is very nearly what sand does on a vibrating sheet. |
| **Helix** | Two strands carrying the live waveform, bridged by rungs. |

Switching designs cross-fades the particles between the two geometries rather
than cutting, staggered per particle so the change sweeps through the field.

## Controls

| Key | |
| --- | --- |
| `Space` | Play / pause |
| `M` | Particle design |
| `N` | Generative piece |
| `P` · `1`–`5` | Colour |
| `Q` | Render quality |
| `S` | Change source |
| `F` | Full screen |
| `H` | Hide interface |
| `R` | Recentre camera |
| `?` | Shortcuts |

Drag to orbit, scroll to dolly.

---

## How it renders

The scene is drawn into a high-resolution HDR buffer, bloomed, tonemapped and
then resolved down to the display with a tent filter. Rendering above display
resolution is what makes the points read as fine grain rather than as fuzz.

**Quality tiers** (scene resolution on a 1920 × 1080 display):

| Tier | Resolution | Scene buffer |
| --- | --- | --- |
| Balanced | 2400 × 1350 | 26 MB |
| High | 3840 × 2160 | 66 MB |
| Ultra | 5568 × 3132 | 140 MB |
| 8K | 7680 × 4320 | 265 MB |

The tier is clamped by the driver's maximum texture size and by a pixel budget,
and the achieved resolution is shown in the top right. If a target is refused
the renderer steps down a tier rather than rendering black, and a sustained
frame rate below ~34 fps eases it back a tier as well. Because the top tiers
allocate hundreds of megabytes, a tier is written to local storage as *pending*
first and only confirmed after it has survived a few seconds — a reload that
finds an unconfirmed tier steps down instead of retrying the one that failed.

A point smaller than a pixel cannot be drawn smaller; it just flickers. So the
size is floored and the difference is paid back in brightness. Total energy is
preserved and the field stays sharp however far it is supersampled.

Bloom runs on a bounded mip chain rather than at scene resolution — glow is
low-frequency and gains nothing from 8K, and this keeps memory flat as the
scene resolution rises.

## Phones

A handset is not a small desktop: a fraction of the fill rate, a fraction of
the memory bandwidth, and a battery. The renderer profiles the device at boot
and sizes everything from that.

| | Desktop | Phone |
| --- | --- | --- |
| Particles | 278,000 | 72,000 |
| Scene buffer | up to 7680 × 4320 | the panel's own pixels, capped at 2.4 MP |
| Tiers offered | four, to 8K | two |
| Reflection pass | yes | no |
| Noise field | 12 simplex evaluations per curl | a trig field, ~20× cheaper |
| Starting load | 100% | 72%, or 40% on a low-memory device |

That last row is the one that matters. The full curl costs twelve simplex
evaluations per call and runs roughly sixteen times per shell particle — over
four million noise evaluations a frame at desktop counts, which no phone GPU
will do. Under `CHEAP` the shader compiles against a trig field instead: not
divergence-free, but it swirls convincingly and at these amplitudes the
difference is not visible.

### It measures itself

No amount of sniffing tells you how fast a phone actually is — a renderer
string is often masked, and core count says little about the GPU. So the
renderer measures its own frames and adapts.

Load is a continuous multiplier over both particle count and scene
resolution, quantised to six steps so tuning it does not reallocate render
targets on every nudge. It spans a 3.4× range:

| Load | Scene (on a 390pt phone) | Particles |
| --- | --- | --- |
| 100% | 546 × 1181 | 43,500 |
| 56% | 408 × 884 | 24,400 |
| 30% | 299 × 647 | 13,100 |

A phone *starts below its ceiling* and climbs only while frames stay cheap.
A slow device therefore never has to be recognised in advance — it simply
never gets promoted, and it never spends the first ten seconds stuttering
while a governor works out what it is. One that starts to struggle sheds
work within about a second.

The window uses the median frame time, not the mean, so a single long frame
from a GC pause or a scroll cannot trigger a downgrade. Frames from a hidden
tab, or any frame over 50ms, are discarded rather than counted — rAF is
throttled when the tab is backgrounded, and that is not the GPU's fault.

The promotion threshold sits at 18.5ms, deliberately above a 60Hz vsync
interval. A device holding a perfect 60fps reports 16.7ms; a threshold below
that would read *comfortable* as *struggling* and strand every 60Hz phone at
its opening settings forever.

Resolution targets the panel's real pixels rather than a supersample factor.
Anything below native reads as a blurred upscale on a dense display, and
anything above it is wasted when the memory budget caps you anyway.

Startup is chunked. Building the field is a few hundred milliseconds of array
maths and shader linking; done in one go it freezes the page, which on a phone
reads as a crash. Programs are linked without blocking on `LINK_STATUS` — that
query stalls until the driver finishes, and it is most of the cost — and the
browser is let through between each stage. The yield is a macrotask, never
`requestAnimationFrame`: a hidden or backgrounded tab throttles rAF to about
one frame a second, which would turn the build into a stall that never ends.

The interface follows. Below 1040px the dock drops its labels rather than
wrapping; on a phone it becomes a single row of icons that share the width and
shrink together, so no number of controls can push one onto a second line. Each
tap toasts what it changed, which is what the label was doing. Tier preference
is stored per profile, so a tier chosen on a laptop never follows you onto a
handset. Two fingers dolly, one orbits. Safe-area insets are respected, and
full screen is hidden where the browser has no such thing.

## Running it for days

The clock is wrapped at a fixed 1020-second period, and every animated term is
driven through a phase that lands exactly back on itself at that boundary, so
the loop has no seam and `float` never loses the precision it would if time
counted up for a day. Absolute timestamps — ripples, sparks — are rebased in
the same frame the clock rolls over.

Particle lifetimes are quantised so that `rate × 1020` is always a whole number
of lifetimes, which keeps the birth-and-death cycle continuous across the wrap.

The audio scheduler runs on a look-ahead against the audio clock rather than on
timer callbacks, and catches up rather than flooding if the tab has been
suspended. Every synthesised voice disconnects itself on `ended`.

A screen wake lock is held while a source is playing, and re-acquired whenever
the tab becomes visible again — the browser drops it on hide.

## Layout

```
index.html          markup
styles/app.css      interface
src/main.js         boot, frame loop, interaction
src/field.js        particle field, camera, quality tiers
src/shaders.js      GLSL: noise, palettes, the four designs
src/post.js         bloom, tonemap, supersample resolve
src/audio.js        capture, analysis, the generative engine
src/gl.js           WebGL2 helpers, device profile, mat4
scripts/dev-server  static server that refuses to be cached
```
