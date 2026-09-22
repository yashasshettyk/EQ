/* ============================================================
   bodies.js — the solar system, as data
   ------------------------------------------------------------
   Figures are NASA/JPL. The layout is not: at true scale the
   planets are invisible specks separated by emptiness, so both
   orbital radius and body radius are power-compressed for the
   system view and relaxed toward truth as you approach one.
   ============================================================ */

export const BODIES = [
  {
    id:'sun', name:'Sun', kind:'star', surface:0,
    radiusKm: 696340, auOrbit: 0, periodDays: 0, dayHours: 609.12, tiltDeg: 7.25,
    tint:[1.00, 0.72, 0.32], atmo:[1.0, 0.55, 0.18], atmoStrength: 1.0,
    blurb:'A G-type main-sequence star holding 99.86% of the system’s mass.',
    facts:[
      ['Diameter',       '1,392,700 km'],
      ['Mass',           '1.989 × 10³⁰ kg  ·  333,000 Earths'],
      ['Surface',        '5,500 °C  ·  core 15,000,000 °C'],
      ['Composition',    '73% hydrogen, 25% helium'],
      ['Rotation',       '25 days at the equator, 35 at the poles'],
      ['Age',            '4.6 billion years  ·  roughly half its life'],
      ['Luminosity',     '3.828 × 10²⁶ watts']
    ]
  },
  {
    id:'mercury', name:'Mercury', kind:'rocky', surface:1,
    radiusKm: 2439.7, auOrbit: 0.387, periodDays: 88, dayHours: 1407.6, tiltDeg: 0.03,
    tint:[0.62, 0.58, 0.54], atmo:[0,0,0], atmoStrength: 0,
    blurb:'The smallest planet, and the one whose year is shortest.',
    facts:[
      ['Diameter',       '4,879 km'],
      ['Distance',       '57.9 million km  ·  0.39 AU'],
      ['Year',           '88 Earth days'],
      ['Day',            '58.6 Earth days  ·  a day is two-thirds of its year'],
      ['Gravity',        '3.7 m/s²  ·  38% of Earth'],
      ['Temperature',    '−173 °C to 427 °C'],
      ['Moons',          'None'],
      ['Atmosphere',     'Effectively none — a thin exosphere']
    ]
  },
  {
    id:'venus', name:'Venus', kind:'rocky', surface:2,
    radiusKm: 6051.8, auOrbit: 0.723, periodDays: 224.7, dayHours: -5832.5, tiltDeg: 177.4,
    tint:[0.95, 0.85, 0.62], atmo:[1.0, 0.88, 0.62], atmoStrength: 0.85,
    blurb:'The hottest planet, wrapped in cloud that never breaks.',
    facts:[
      ['Diameter',       '12,104 km'],
      ['Distance',       '108.2 million km  ·  0.72 AU'],
      ['Year',           '224.7 Earth days'],
      ['Day',            '243 Earth days, retrograde — its day is longer than its year'],
      ['Gravity',        '8.87 m/s²  ·  90% of Earth'],
      ['Temperature',    '464 °C, near enough constant'],
      ['Moons',          'None'],
      ['Atmosphere',     '96% CO₂ at 92× Earth’s pressure']
    ]
  },
  {
    id:'earth', name:'Earth', kind:'rocky', surface:3,
    radiusKm: 6371, auOrbit: 1.0, periodDays: 365.256, dayHours: 23.934, tiltDeg: 23.44,
    tint:[0.22, 0.44, 0.72], atmo:[0.35, 0.60, 1.0], atmoStrength: 1.0,
    blurb:'The only place known to carry life, and the only one with liquid water on its surface.',
    facts:[
      ['Diameter',       '12,742 km'],
      ['Distance',       '149.6 million km  ·  1 AU, by definition'],
      ['Year',           '365.256 days'],
      ['Day',            '23 h 56 m 4 s'],
      ['Gravity',        '9.81 m/s²'],
      ['Temperature',    '−89 °C to 58 °C  ·  15 °C average'],
      ['Moons',          '1  ·  the Moon, 384,400 km out'],
      ['Atmosphere',     '78% nitrogen, 21% oxygen'],
      ['Surface',        '71% water']
    ]
  },
  {
    id:'mars', name:'Mars', kind:'rocky', surface:4,
    radiusKm: 3389.5, auOrbit: 1.524, periodDays: 687, dayHours: 24.62, tiltDeg: 25.19,
    tint:[0.78, 0.40, 0.24], atmo:[0.9, 0.55, 0.40], atmoStrength: 0.30,
    blurb:'Iron oxide dust, the tallest volcano in the system, and the deepest canyon.',
    facts:[
      ['Diameter',       '6,779 km'],
      ['Distance',       '227.9 million km  ·  1.52 AU'],
      ['Year',           '687 Earth days'],
      ['Day',            '24 h 37 m — close to Earth’s'],
      ['Gravity',        '3.72 m/s²  ·  38% of Earth'],
      ['Temperature',    '−153 °C to 20 °C'],
      ['Moons',          '2  ·  Phobos and Deimos'],
      ['Atmosphere',     '95% CO₂, under 1% of Earth’s pressure'],
      ['Olympus Mons',   '21.9 km tall — two and a half Everests'],
      ['Valles Marineris','4,000 km long, up to 7 km deep']
    ]
  },
  {
    id:'jupiter', name:'Jupiter', kind:'gas', surface:5,
    radiusKm: 69911, auOrbit: 5.204, periodDays: 4332.6, dayHours: 9.93, tiltDeg: 3.13,
    tint:[0.82, 0.68, 0.52], atmo:[1.0, 0.85, 0.65], atmoStrength: 0.55,
    blurb:'Twice the mass of every other planet combined, and a storm older than the telescope.',
    facts:[
      ['Diameter',       '139,820 km  ·  11 Earths across'],
      ['Distance',       '778.5 million km  ·  5.20 AU'],
      ['Year',           '11.86 Earth years'],
      ['Day',            '9 h 56 m — the fastest rotation in the system'],
      ['Gravity',        '24.79 m/s²  ·  2.5× Earth'],
      ['Temperature',    '−110 °C at the cloud tops'],
      ['Moons',          '95 confirmed  ·  Io, Europa, Ganymede, Callisto'],
      ['Great Red Spot', 'A storm wider than Earth, observed since 1831'],
      ['Composition',    'Hydrogen and helium; no solid surface']
    ]
  },
  {
    id:'saturn', name:'Saturn', kind:'gas', surface:6, ring:[1.24, 2.27],
    radiusKm: 58232, auOrbit: 9.583, periodDays: 10759, dayHours: 10.66, tiltDeg: 26.73,
    tint:[0.88, 0.80, 0.60], atmo:[1.0, 0.92, 0.70], atmoStrength: 0.45,
    blurb:'Less dense than water, and ringed with ice a few metres thick.',
    facts:[
      ['Diameter',       '116,460 km'],
      ['Distance',       '1.43 billion km  ·  9.58 AU'],
      ['Year',           '29.45 Earth years'],
      ['Day',            '10 h 42 m'],
      ['Gravity',        '10.44 m/s²'],
      ['Temperature',    '−140 °C'],
      ['Moons',          '146 confirmed  ·  Titan is larger than Mercury'],
      ['Rings',          '70,000–140,000 km out, often under 10 m thick'],
      ['Density',        '0.687 g/cm³ — it would float']
    ]
  },
  {
    id:'uranus', name:'Uranus', kind:'ice', surface:7, ring:[1.60, 2.00],
    radiusKm: 25362, auOrbit: 19.19, periodDays: 30687, dayHours: -17.24, tiltDeg: 97.77,
    tint:[0.55, 0.82, 0.86], atmo:[0.60, 0.90, 0.95], atmoStrength: 0.55,
    blurb:'Tipped on its side, so each pole spends 42 years in sunlight and 42 in dark.',
    facts:[
      ['Diameter',       '50,724 km'],
      ['Distance',       '2.87 billion km  ·  19.19 AU'],
      ['Year',           '84 Earth years'],
      ['Day',            '17 h 14 m, retrograde'],
      ['Gravity',        '8.87 m/s²'],
      ['Temperature',    '−195 °C  ·  the coldest atmosphere in the system'],
      ['Moons',          '28  ·  named for Shakespeare and Pope'],
      ['Axial tilt',     '97.8° — it orbits lying down'],
      ['Composition',    'Water, methane and ammonia ices over a rock core']
    ]
  },
  {
    id:'neptune', name:'Neptune', kind:'ice', surface:8,
    radiusKm: 24622, auOrbit: 30.07, periodDays: 60190, dayHours: 16.11, tiltDeg: 28.32,
    tint:[0.25, 0.42, 0.85], atmo:[0.35, 0.55, 1.0], atmoStrength: 0.60,
    blurb:'The windiest place known — 2,100 km/h — and the only planet found by mathematics first.',
    facts:[
      ['Diameter',       '49,244 km'],
      ['Distance',       '4.50 billion km  ·  30.07 AU'],
      ['Year',           '164.8 Earth years'],
      ['Day',            '16 h 6 m'],
      ['Gravity',        '11.15 m/s²'],
      ['Temperature',    '−200 °C'],
      ['Moons',          '16  ·  Triton orbits backwards'],
      ['Winds',          'Up to 2,100 km/h — supersonic'],
      ['Discovery',      '1846, predicted from Uranus’s orbit before it was seen']
    ]
  }
];

/* ── layout ───────────────────────────────────────────────────
   True scale is unwatchable: at Earth-diameter = 1 pixel the Sun
   is 109 pixels and Neptune is four kilometres off-screen. Both
   axes are power-compressed so the whole system reads at once,
   and the compression relaxes as the camera closes on a body.  */

const ORBIT_POW = 0.62, ORBIT_K = 14.0;
const SIZE_POW  = 0.42, SIZE_K  = 0.55;
const EARTH_R   = 6371;

export function layout(){
  return BODIES.map((b, i) => ({
    ...b, index: i,
    orbit:  b.auOrbit === 0 ? 0 : ORBIT_K * Math.pow(b.auOrbit, ORBIT_POW),
    // The Sun is scaled down hard; at even compressed size it would
    // otherwise swallow the inner planets.
    size:   (b.kind === 'star' ? 2.6 : SIZE_K * Math.pow(b.radiusKm / EARTH_R, SIZE_POW)),
    spin:   b.dayHours === 0 ? 0 : (Math.sign(b.dayHours) * 0.35 / Math.max(0.4, Math.abs(b.dayHours) / 24)),
    // Start them spread out rather than in a line.
    phase:  (i * 2.39996) % (Math.PI * 2),
    speed:  b.periodDays === 0 ? 0 : 0.6 / Math.pow(b.periodDays / 365, 0.62)
  }));
}
