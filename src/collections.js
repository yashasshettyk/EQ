/* ============================================================
   collections.js — curated presets
   ------------------------------------------------------------
   A hundred pieces and fifty-three designs is a lot of surface
   to explore one control at a time. Each collection is a pairing
   somebody would otherwise have to find by hand: a piece, a
   design and a palette that belong together.
   ============================================================ */

export const COLLECTIONS = [
  /* ── Stillness ── */
  { id:'meditation', name:'Meditation', group:'Stillness',
    blurb:'Singing bowls over a slow mandala',
    scene:'solace', mode:'mandala', palette:'abyss' },
  { id:'deep-focus', name:'Deep Focus', group:'Stillness',
    blurb:'Almost nothing, falling quietly',
    scene:'stillwater', mode:'veil', palette:'platinum' },
  { id:'dreamstate', name:'Dreamstate', group:'Stillness',
    blurb:'Six-hertz binaural under drifting sheets · headphones',
    scene:'theta', mode:'aurora-still', palette:'nocturne' },
  { id:'sanctuary', name:'Sanctuary', group:'Stillness',
    blurb:'Formant voices in a twelve-fold rosette',
    scene:'choir', mode:'mandala-xii', palette:'nocturne' },
  { id:'rainfall', name:'Rainfall', group:'Stillness',
    blurb:'Granular droplets and fine rain',
    scene:'rain', mode:'drizzle', palette:'abyss' },
  { id:'lotus-pool', name:'Lotus Pool', group:'Stillness',
    blurb:'Petals opening on still water',
    scene:'bowls', mode:'lotus-wide', palette:'abyss' },

  /* ── Depth ── */
  { id:'undertow', name:'Undertow', group:'Depth',
    blurb:'The lowest drone, circulating',
    scene:'abyssal', mode:'torus', palette:'abyss' },
  { id:'monolith', name:'Monolith', group:'Depth',
    blurb:'One chord held against a hard shell',
    scene:'monolith', mode:'quartz', palette:'platinum' },
  { id:'tidal', name:'Tidal', group:'Depth',
    blurb:'Oceanic, one deep beat a bar',
    scene:'tide', mode:'aurora-deep', palette:'abyss' },
  { id:'stargazer', name:'Stargazer', group:'Depth',
    blurb:'Distant bells beneath a standing curtain',
    scene:'vesper', mode:'aurora', palette:'signal' },

  /* ── Motion ── */
  { id:'night-drive', name:'Night Drive', group:'Motion',
    blurb:'Club beat through a radial fountain',
    scene:'kinetic', mode:'corona', palette:'signal' },
  { id:'euphoria', name:'Euphoria', group:'Motion',
    blurb:'Supersaw trance and a breathing shell',
    scene:'uplift', mode:'orb', palette:'signal' },
  { id:'circuitry', name:'Circuitry', group:'Motion',
    blurb:'Sixteenth arpeggio drawing a vibrating plate',
    scene:'circuit', mode:'cymatic', palette:'signal' },
  { id:'lattice', name:'Lattice', group:'Motion',
    blurb:'Syncopated and dubby, wound into a knot',
    scene:'lattice', mode:'trefoil', palette:'nocturne' },
  { id:'momentum', name:'Momentum', group:'Motion',
    blurb:'Forward, never resting',
    scene:'momentum', mode:'knot-53', palette:'signal' },
  { id:'voltage', name:'Voltage', group:'Motion',
    blurb:'Hypnotic techno through a double helix',
    scene:'voltage', mode:'helix', palette:'signal' },

  /* ── Light ── */
  { id:'sunrise', name:'Sunrise', group:'Light',
    blurb:'Major swells opening upward',
    scene:'sunrise', mode:'bloom', palette:'ember' },
  { id:'meadow', name:'Meadow', group:'Light',
    blurb:'Bright lydian air over opening petals',
    scene:'meadow', mode:'anemone', palette:'abyss' },
  { id:'glasshouse', name:'Glasshouse', group:'Light',
    blurb:'Whole-tone shimmer woven into a figure',
    scene:'glass', mode:'lissa-35', palette:'platinum' },
  { id:'daybreak', name:'Daybreak', group:'Light',
    blurb:'Warm house gathering behind a supershape',
    scene:'daybreak', mode:'diatom', palette:'ember' },
  { id:'prism', name:'Prism', group:'Light',
    blurb:'Splitting into colours',
    scene:'prism', mode:'star', palette:'signal' },

  /* ── Texture ── */
  { id:'frostwork', name:'Frostwork', group:'Texture',
    blurb:'Crystalline and thin, on a nodal web',
    scene:'frost', mode:'plate-iii', palette:'platinum' },
  { id:'sediment', name:'Sediment', group:'Texture',
    blurb:'Settling slowly through a wide field',
    scene:'sediment', mode:'downpour', palette:'abyss' },
  { id:'emberfall', name:'Emberfall', group:'Texture',
    blurb:'Warm embers, occasional sparks',
    scene:'cinder', mode:'geyser', palette:'ember' },
  { id:'spindrift', name:'Spindrift', group:'Texture',
    blurb:'Spray off the top of a wave',
    scene:'spindrift', mode:'halo', palette:'abyss' }
];

/** Drop anything pointing at a piece, design or palette that is not
    there. A typo in this table would otherwise be a silent no-op at
    the far end, which is a miserable thing to track down. */
export function validate(COLLECTIONS, sceneIds, modeIds, paletteIds){
  const bad = [];
  const ok = COLLECTIONS.filter(c => {
    const miss = [];
    if(!sceneIds.has(c.scene))     miss.push('scene ' + c.scene);
    if(!modeIds.has(c.mode))       miss.push('design ' + c.mode);
    if(!paletteIds.has(c.palette)) miss.push('palette ' + c.palette);
    if(miss.length){ bad.push(`${c.id}: ${miss.join(', ')}`); return false; }
    return true;
  });
  if(bad.length) console.warn('[collections] dropped —\n  ' + bad.join('\n  '));
  return ok;
}
