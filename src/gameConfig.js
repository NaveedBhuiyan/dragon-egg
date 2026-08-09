export const WORLD = {
  width: 2000,
  height: 1500,
};

export const NEST_SITE = { x: 250, y: 750 };
export const VOLCANO = { x: 1750, y: 750, radius: 120 };

export const ROCK_TYPES = {
  ember: { key: 'ember', label: 'Ember', color: 0xff6b35, dragon: 'Fire Dragon' },
  frost: { key: 'frost', label: 'Frost', color: 0x38bdf8, dragon: 'Ice Dragon' },
  storm: { key: 'storm', label: 'Storm', color: 0xa78bfa, dragon: 'Storm Dragon' },
};

export const HYBRID_DRAGON = 'Prismatic Dragon';

export const DRAGON_TINTS = {
  'Fire Dragon': ROCK_TYPES.ember.color,
  'Ice Dragon': ROCK_TYPES.frost.color,
  'Storm Dragon': ROCK_TYPES.storm.color,
};

export const SPRITE_SCALE = {
  player: 0.42,
  raider: 0.4,
  eggCarried: 0.32,
  eggNest: 0.5,
  portrait: 1.9,
};

export const ROCK_NODES = [
  { x: 1400, y: 300, type: 'ember' },
  { x: 1500, y: 1200, type: 'ember' },
  { x: 1100, y: 750, type: 'ember' },
  { x: 1300, y: 980, type: 'ember' },

  { x: 700, y: 250, type: 'frost' },
  { x: 600, y: 1280, type: 'frost' },
  { x: 900, y: 500, type: 'frost' },
  { x: 950, y: 1050, type: 'frost' },

  { x: 400, y: 400, type: 'storm' },
  { x: 450, y: 1150, type: 'storm' },
  { x: 1050, y: 280, type: 'storm' },
  { x: 1080, y: 1250, type: 'storm' },
];

export const BALANCE = {
  playerSpeed: 190,
  carrySpeedMultiplier: 0.78,
  interactRange: 60,
  volcanoRange: 140,

  nodeReserve: 5,
  nodeRespawnMs: 20000,
  nodeYield: 1,

  nestLevels: [
    { cost: 0, maxHp: 100, defenseMultiplier: 1 }, // level 0: not built
    { cost: 6, maxHp: 100, defenseMultiplier: 0.5 }, // level 1
    { cost: 8, maxHp: 120, defenseMultiplier: 0.3 }, // level 2
    { cost: 10, maxHp: 140, defenseMultiplier: 0.15 }, // level 3
  ],

  raider: {
    baseHp: 60,
    hpPerTier: 15,
    baseSpeed: 68,
    speedPerTier: 8,
    attackRange: 34,
    attackIntervalMs: 1000,
    attackDamage: 8,
    maxConcurrent: 10,
    baseSpawnMs: 4500,
    spawnDecayPerTier: 150,
    minSpawnMs: 1300,
    tierIntervalMs: 45000,
  },

  attack: {
    range: 64,
    damage: 55,
    cooldownMs: 350,
  },
};
