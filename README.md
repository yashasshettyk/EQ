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

A hundred of them. Twenty-one were written one at a time; the rest are
composed over the same engine from the axes that actually change how a piece
sounds — mode, register, tempo, percussion, and which harmonic engine drives
it. Spelling out a hundred complete definitions would have buried the handful
of numbers that differ between them, so they share a template.

Each is a parameter set over one engine — scale, register,
tempo, timbre, space, and a one-bar drum pattern on a sixteenth grid. Nothing
is sampled and nothing loops.

They group into **Calm** (26), **Uplifting** (23), **Rhythmic** (30),
**Texture** (12) and **Drone** (9). The menu derives the grouping from what a
piece actually uses, so a new entry lands in the right section without being
labelled by hand.

The calm set — `Solace`, `Theta`, `Meadow`, `Bowls`, `Sunrise`, `Stillwater`,
`Hush`, `Fathom`, `Vesper` and the rest — uses major-family modes, long decays
and no hard transients.



The calm set leans on consonance rather than atmosphere alone: major and
lydian scales, perfect fifths, and roots drawn from the solfeggio set (528 Hz
and friends). There is no physics behind that folklore, but they are pleasant
roots and sitting off concert pitch is part of why the set lands differently.

Three pieces of synthesis serve them:

**Singing bowls.** A real bowl's partials are inharmonic — not integer
multiples of the fundamental — and the high ones die away first. Each partial
is paired with a twin detuned by about three cents, and the slow beating
between them is what makes a bowl sound alive rather than like a struck bell
sample.

**Binaural pairs.** Two pure tones a few hertz apart, one hard to each ear.
The beat is perceived rather than present in either channel, so it only works
on headphones, which is why those pieces say so on the label. `Theta` runs at
6 Hz, `Stillwater` at 10.

**Breath.** A reverb send swelling on a 5.5 to 7 second cycle. Nothing clever
is happening — it is simply something steady to fall into step with.

The uplifting set needed its own three:

**Sidechain.** Everything harmonic runs through a duck bus that the kick
pulls down and lets breathe back over 200ms. This is most of what makes the
style feel like it is moving, and it is doing real work rather than being an
effect painted on top — without it the sub and the kick fight for the same
space and both lose. Drums bypass it.

**Supersaws.** Seven sawtooths spread a few cents apart, per chord note. One
saw is thin; seven is a wall. `Neon` bends its detune under itself across the
first half of each stab, which is the future-bass signature.

**Progressions.** Chords advance once a bar through `I–V–vi–IV` and its
rotations, with a ninth on every voicing — the ninth is most of the lushness,
and a bare triad sounds like a test tone by comparison. Sub bass follows the
chord root on its own pattern, kept short so it never masks the kick. Risers
sweep the bar before a section turns over.

A limiter sits on the output. The busier pieces stack a kick, a sub, a
supersaw chord and a hat on the same beat, and the sum clips well before any
one of them is too loud; catching the peaks is cheaper than keeping every
part quiet enough never to collide.

A calm piece has no drums, so nothing for the onset detector to find. The
sequencer instead reports a gentle cue every couple of seconds, which keeps
the ripples moving at a breathing cadence rather than a beat, and leaves the
field alive without anything ever striking.

Percussion is synthesised: a pitch-dropping sine kick with a filtered click
transient, band-passed noise snares with a tonal body, and high-passed hats.
When a piece is playing its own music, the sequencer hands the visuals the
exact hit times rather than relying on onset detection, so the ripples land on
the beat instead of near it.

## The particle designs

Fifty-three of them, over eight shader families. Writing fifty-three shader
functions would be fifty-three near-duplicates and a link time no phone would
forgive, so each design is a family plus eight numbers — the variety lives in
data and the shader stays small enough to compile quickly.

| Family | Parameters | Designs |
| --- | --- | --- |
| Shell | fold, crumple, thickness, radius | Orb, Quartz, Nebula, Pulsar |
| Corona | swirl, height, radius, spread | Corona, Geyser, Cyclone, Crown |
| Chladni | two (n, m) pairs | Cymatic + five plates |
| Knot | p, q, tube, turns | Torus, Trefoil, five knots, Coil, Ribbon, Braid, Helix |
| Rose | petals, rings, lift, petalled | five mandalas, four flowers |
| Curtain | sheets, sway, falling, width | three auroras, three rains |
| Lissajous | a, b, c, phase | six figures |
| Supershape | m, n1, n2, n3 | seven — star, bulb, cog, conch, seed, diatom, crystal |

`q < 0` in the Knot family selects an open helix instead of a closed knot,
which is how one function covers both a trefoil and a spring.



The four originals still anchor it: **Orb**, a hollow noise-crumpled shell
with azimuth mapped to frequency and brightness Fresnel-weighted so the
silhouette densifies and the centre stays open; **Corona**, the literal
equalizer, angle for frequency and height for amplitude; **Cymatic**, a
Chladni plate where particles relax onto the nodal lines by Newton iteration,
very nearly what sand does on a vibrating sheet; and **Helix**, two strands
carrying the live waveform.

Anything built from a curve — knots, helices, Lissajous figures — carries a
tangent and a density correction. Where a curve runs away from the eye, a long
stretch of it lands on very few pixels and piles into a hot blob; the shader
divides that back out. The cross-section frame is anchored to the vertical
axis rather than to an arbitrary up-vector, because the latter flips wherever
the tangent passes vertical and the tube visibly twists at the flip.

Switching designs cross-fades the particles between the two geometries rather
than cutting, staggered per particle so the change sweeps through the field.

## The solar system

A second renderer, sharing the GL context, the post chain and the device
profile with the particle field. Pick it from the same design menu — the
system as a whole, or any of the nine bodies.

**Desktop only.** On a handset it is not built at all rather than merely
hidden: constructing it costs about 50 ms on an M4, which on a mid-range
phone is several hundred milliseconds of blocked startup, and it means six
more shader programs to link and the geodesic integrator sitting on the
hardware least able to carry it. A view stored from a desktop session falls
back to the particle field rather than stranding the phone.

**There are no texture files.** Every surface is evaluated per fragment from
noise, and the octave count is driven by how much of the screen the body
fills, so approaching one *adds* detail rather than magnifying what is
already there. A bitmap has a last mip and eventually shows you its pixels;
this does not, which is the only way "infinite zoom with a clean texture" is
actually true rather than merely a long zoom.

Each world is built from what it is actually known for, not generic noise at
different frequencies:

| | |
| --- | --- |
| **Sun** | Granulation over supergranulation, sunspots with umbra, penumbra and surrounding faculae, differential rotation (the equator laps the poles), true limb darkening that reddens as it dims, and a chromosphere rim with prominences arching off it |
| **Mercury** | Four scales of cratering with raised rims, the Caloris basin, bright ejecta rays from the youngest impacts, and the compression scarps left by the planet cooling |
| **Venus** | A super-rotating cloud deck, the dark ultraviolet Y, and a vortex over each pole |
| **Earth** | Continents with a shelf, mountain chains with a snow line, biomes by latitude and aridity, two cloud layers at different speeds, mid-latitude storm spirals, and city lights that appear only on the night side and only over land |
| **Mars** | The crustal dichotomy — smooth northern lowlands, ancient cratered southern highlands — plus Valles Marineris, Olympus Mons and the Tharsis shields, the Hellas basin, wind streaks, and layered polar deposits |
| **Jupiter** | Belts and zones warped by differential rotation, festoons curling off the belt edges, white ovals, and the Great Red Spot with its bright collar |
| **Saturn** | Softer banding, the hexagonal polar jet, and rings with the Cassini and Encke divisions and the planet's shadow falling across them |
| **Uranus** | Near-featureless methane cyan, lying on its side at 97.8° |
| **Neptune** | Deep blue banding and a dark spot |

Distances and sizes are power-compressed. At true scale the planets are
invisible specks separated by emptiness — Earth would be one pixel with
Neptune four kilometres off-screen — so both axes are compressed for the
system view. The figures in the panel are the real ones.

Zoom is exponential in log-altitude, so one turn of the wheel covers the same
*proportion* of the distance whether you are outside Neptune's orbit or a
hundred metres off the cloud tops. The near and far planes ride the altitude
with it; a fixed pair cannot hold both without the depth buffer collapsing.

The sky is procedural too: the galactic plane with its dust lanes, emission
and reflection nebulae, and a few distant galaxies, evaluated from the view
ray. No cube map, so it costs no memory and never repeats.

The post chain carries two grades. Additive particles want a low bloom
threshold so every point contributes a halo; a lit sphere is the opposite,
and the same settings smear it into a featureless white ball.

## The black hole

Not part of the solar system, so it is a separate destination rather than a
tenth body — and it is integrated, not faked. Light near a mass follows a
geodesic; in the plane containing the camera, the hole and the ray, that
reduces to

```
d²u/dφ² = −u + (3/2)·rs·u²        where u = 1/r
```

Marching that equation per pixel bends each ray properly, which is what
produces the photon ring, the Einstein ring, and the view of the *far* side
of the accretion disc lifted over the top of the hole. None of those can be
painted on; they fall out of the integration. The disc carries a temperature
gradient (roughly r^−3/4, as a thin disc does) and relativistic beaming, so
the side rotating toward you is markedly brighter.

Three things it took to make it behave:

**Adaptive stepping.** A fixed step is the source of concentric ring
artefacts: far out it wastes iterations and close in the path turns faster
than the step can follow, so rays with slightly different impact parameters
run out of budget at different points and the discontinuity shows up as a
ring. Scaling the step by how sharply the path is bending spends the budget
where it matters.

**Counting exhausted rays as captured.** A ray that simply runs out of
iterations while still deep in the strong field never got out — it was
spiralling. Letting it sample the sky instead paints a grey halo exactly
where the shadow belongs.

**Keeping the governor away from it.** Integrating a geodesic per pixel is
the most expensive thing in this project, so the governor reacts. But going
through `setLoad` calls `resize()`, and reallocating every framebuffer
mid-flight is itself a visible hitch — the governor then sees the stutter it
just caused and reacts again, a loop that never settles. In this view it
adjusts the step count instead, which costs nothing to change.

The hole also renders at a fraction of the scene resolution and ramps its
step count in over the first second. The image is smooth curves and
gradients, which is exactly what survives the composite's tent filter.

## Stock

A hundred pieces, fifty-three designs and twenty-five pairings is more surface
than a popover can carry, so there is a browser for it — reached from the
launch screen as a fourth source beside System Audio, Microphone and Audio
File, or from *Browse all* at the top of the Collections menu.

Three tabs — **Collections**, **Sounds**, **Particles** — with a search across
names and descriptions. One tap applies and starts playing.

**Collections** are curated pairings: a piece, a design and a palette chosen
to go together, so the pieces that suit a given form are not something you
have to find by hand. `Meditation` is singing bowls over a slow mandala;
`Night Drive` is a club beat through a radial fountain; `Undertow` is the
lowest drone in the library circulating through a torus. Each card shows the
palette and the two parts it will set.

The table is validated against the real piece, design and palette ids at
startup and anything that does not resolve is dropped with a warning. A typo
there would otherwise be a silent no-op at the far end, which is a miserable
thing to track down.

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
| Solar system | yes | not built |

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

## Music only

A switch in Controls (`B`) that stops the renderer outright — no canvas, no
`requestAnimationFrame`, no per-frame JavaScript. Measured: **zero animation
frames scheduled over two seconds** while the audio kept playing and the
sequencer kept advancing. A single CSS gradient carries the screen, which the
browser composites without waking the page.

It also *releases* the screen wake lock that the visual modes hold. That lock
exists so an unattended display does not sleep, and it is exactly wrong here:
the point of this mode is that the phone can switch the screen off and keep
playing.

Media Session is wired up, so the piece name, play/pause and previous/next
appear on the lock screen and on headphone controls.

**On iOS this has a limit worth stating.** Safari suspends Web Audio when the
screen locks, and synthesised audio has no media element for iOS to keep
alive, so there is no way around it from a web page. The mode says so on
screen rather than pretending otherwise. Android and desktop keep playing with
the screen off; on iOS, a dropped-in audio file will continue where the
generative pieces will not, because that is a real `<audio>` element.

## Running it for days

The clock is wrapped at a fixed 1020-second period, and every animated term is
driven through a phase that lands exactly back on itself at that boundary, so
the loop has no seam and `float` never loses the precision it would if time
counted up for a day. Absolute timestamps — ripples, sparks — are rebased in
the same frame the clock rolls over.

Particle lifetimes are quantised so that `rate × 1020` is always a whole number
of lifetimes, which keeps the birth-and-death cycle continuous across the wrap.

### The scheduler, and a sleeping screen

The audio scheduler runs on a look-ahead against the audio clock. Getting that
to survive a phone going to sleep took three things, and the first version of
it stuttered badly.

**The clock lives in a worker.** `setInterval` on the main thread is clamped
hard once the page is hidden — on a phone with the screen off it can drop to
roughly once a second or worse. A look-ahead scheduler fed that slowly
schedules notes into the past, and you hear it as stuttering. A worker's timer
is throttled far less and is not competing with rendering.

**The look-ahead grows when hidden**, from 0.3 seconds to 3. Short while
visible so a change of piece takes effect at once; long while hidden because
everything between now and whenever the clock next gets to run has to already
be committed. Measured: a 2.5-second stall while hidden leaves the scheduler
still half a second *ahead*, so there is no discontinuity at all — where at
0.3s it would have been two and a half seconds behind.

**Catching up re-enters on a bar line.** Past 3 seconds the buffer does run
dry, and jumping to wherever the clock happens to be lands mid-pattern and is
audible as a lurch. Advancing by a whole number of bars keeps the phase. A
nine-second stall jumps exactly four bars and recovers.

Every synthesised voice disconnects itself on `ended`.

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
