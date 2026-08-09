// Phaser-independent plain-data game rules for the 2-player "online" mode.
// Used as the single source of truth on the PartyKit server; the client
// only ever reads the resulting state, never mutates these fields itself
// in online mode (movement is the one exception — see GameScene's online
// branch — since position isn't part of the fairness-critical shared state).
import { NEST_SITE, VOLCANO, ROCK_TYPES, ROCK_NODES, BALANCE, HYBRID_DRAGON } from '../gameConfig.js';

const ROCK_ORDER = Object.keys(ROCK_TYPES);

export function createInitialState() {
  return {
    inventory: { ember: 0, frost: 0, storm: 0 },
    totalCollected: { ember: 0, frost: 0, storm: 0 },
    nestLevel: 0,
    eggMaxHp: BALANCE.nestLevels[0].maxHp,
    eggHp: BALANCE.nestLevels[0].maxHp,
    carrying: true,
    nodes: ROCK_NODES.map((cfg, id) => ({ id, type: cfg.type, x: cfg.x, y: cfg.y, reserve: BALANCE.nodeReserve })),
    raiderHp: BALANCE.raiderPvp.hp,
    raiderMaxHp: BALANCE.raiderPvp.hp,
    raiderDead: false,
    raidersDefeated: 0,
    guardianLastAttack: 0,
    raiderLastAttack: 0,
    gameOver: false,
    gameWon: false,
    winnerRole: null,
    dragon: null,
  };
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function totalRocks(state) {
  return state.inventory.ember + state.inventory.frost + state.inventory.storm;
}

function spendRocks(state, amount) {
  let remaining = amount;
  for (const type of ROCK_ORDER) {
    const take = Math.min(state.inventory[type], remaining);
    state.inventory[type] -= take;
    remaining -= take;
    if (remaining <= 0) break;
  }
}

function nestDefenseMultiplier(state) {
  const level = BALANCE.nestLevels[state.nestLevel];
  return level ? level.defenseMultiplier : 1;
}

export function eggWorldPosition(state, guardianPos) {
  return state.carrying ? guardianPos : { x: NEST_SITE.x, y: NEST_SITE.y };
}

export function determineDragon(state) {
  const max = Math.max(state.totalCollected.ember, state.totalCollected.frost, state.totalCollected.storm);
  if (max === 0) return HYBRID_DRAGON;
  const winners = ROCK_ORDER.filter((type) => state.totalCollected[type] === max);
  if (winners.length > 1) return HYBRID_DRAGON;
  return ROCK_TYPES[winners[0]].dragon;
}

// Each apply* function validates against the authoritative state and the
// position the caller reports for itself, mutates state in place, and
// returns { ok, ...extra } describing what happened (so the server knows
// whether to broadcast, and whether to schedule a respawn timer — timers
// themselves are environment-specific, so they live in the party server).

export function applyHarvest(state, { nodeId, x, y }) {
  if (state.gameOver || state.gameWon) return { ok: false };
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node || node.reserve <= 0) return { ok: false };
  if (distance(x, y, node.x, node.y) > BALANCE.interactRange) return { ok: false };

  node.reserve -= 1;
  state.inventory[node.type] += BALANCE.nodeYield;
  state.totalCollected[node.type] += BALANCE.nodeYield;

  return { ok: true, depleted: node.reserve <= 0, nodeId: node.id };
}

export function applyBuild(state, { x, y }) {
  if (state.gameOver || state.gameWon) return { ok: false };
  if (distance(x, y, NEST_SITE.x, NEST_SITE.y) > BALANCE.interactRange) return { ok: false };

  const nextLevel = state.nestLevel + 1;
  const levelConfig = BALANCE.nestLevels[nextLevel];
  if (!levelConfig || totalRocks(state) < levelConfig.cost) return { ok: false };

  spendRocks(state, levelConfig.cost);
  state.nestLevel = nextLevel;
  state.eggMaxHp = levelConfig.maxHp;
  state.eggHp = state.eggMaxHp;
  if (state.nestLevel === 1) state.carrying = false;

  return { ok: true, nestLevel: state.nestLevel };
}

export function applyEggPickup(state, { x, y }) {
  if (state.gameOver || state.gameWon) return { ok: false };
  if (state.carrying || state.nestLevel < 1) return { ok: false };
  if (distance(x, y, NEST_SITE.x, NEST_SITE.y) > BALANCE.interactRange) return { ok: false };
  state.carrying = true;
  return { ok: true };
}

export function applyEggPlace(state, { x, y }) {
  if (state.gameOver || state.gameWon) return { ok: false };
  if (!state.carrying || state.nestLevel < 1) return { ok: false };
  if (distance(x, y, NEST_SITE.x, NEST_SITE.y) > BALANCE.interactRange) return { ok: false };
  state.carrying = false;
  return { ok: true };
}

export function applyEggDrop(state, { x, y }) {
  if (state.gameOver || state.gameWon) return { ok: false };
  if (!state.carrying) return { ok: false };
  if (distance(x, y, VOLCANO.x, VOLCANO.y) > BALANCE.volcanoRange) return { ok: false };

  state.gameWon = true;
  state.winnerRole = 'guardian';
  state.dragon = determineDragon(state);
  return { ok: true, dragon: state.dragon };
}

export function applyGuardianAttack(state, { guardianX, guardianY, raiderX, raiderY }) {
  const now = Date.now();
  if (state.gameOver || state.gameWon || state.raiderDead) return { ok: false };
  if (now - state.guardianLastAttack < BALANCE.attack.cooldownMs) return { ok: false };
  if (distance(guardianX, guardianY, raiderX, raiderY) > BALANCE.attack.range) return { ok: false };

  state.guardianLastAttack = now;
  state.raiderHp -= BALANCE.attack.damage;
  if (state.raiderHp <= 0) {
    state.raiderHp = 0;
    state.raiderDead = true;
    state.raidersDefeated += 1;
    return { ok: true, killed: true };
  }
  return { ok: true, killed: false };
}

export function respawnRaider(state) {
  state.raiderHp = state.raiderMaxHp;
  state.raiderDead = false;
}

export function applyRaiderAttack(state, { raiderX, raiderY, guardianX, guardianY }) {
  const now = Date.now();
  if (state.gameOver || state.gameWon || state.raiderDead) return { ok: false };
  if (now - state.raiderLastAttack < BALANCE.attack.cooldownMs) return { ok: false };

  const eggPos = eggWorldPosition(state, { x: guardianX, y: guardianY });
  if (distance(raiderX, raiderY, eggPos.x, eggPos.y) > BALANCE.attack.range) return { ok: false };

  state.raiderLastAttack = now;
  const multiplier = state.carrying ? 1 : nestDefenseMultiplier(state);
  state.eggHp = Math.max(0, state.eggHp - BALANCE.raiderPvp.eggDamage * multiplier);
  if (state.eggHp <= 0) {
    state.gameOver = true;
    state.winnerRole = 'raider';
  }
  return { ok: true };
}
