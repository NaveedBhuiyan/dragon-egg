import Phaser from 'phaser';
import {
  WORLD,
  NEST_SITE,
  VOLCANO,
  ROCK_TYPES,
  ROCK_NODES,
  BALANCE,
  HYBRID_DRAGON,
  DRAGON_TINTS,
  SPRITE_SCALE,
} from '../gameConfig.js';
import backgroundUrl from '../assets/background.jpg';

const ROCK_ORDER = Object.keys(ROCK_TYPES);

const SPRITE_MODULES = import.meta.glob('../assets/sprites/*.png', { eager: true, import: 'default' });
const SPRITES = Object.fromEntries(
  Object.entries(SPRITE_MODULES).map(([path, url]) => [path.split('/').pop().replace('.png', ''), url])
);

const EGG_IDLE_FRAMES = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ key: `egg_idle_${String(n).padStart(2, '0')}` }));
const EGG_HATCH_FRAMES = [1, 2, 3, 4].map((n) => ({ key: `egg_hatch_${String(n).padStart(2, '0')}` }));
const DRAGON_IDLE_FRAMES = [1, 2, 3, 4].map((n) => ({ key: `dragon_front_${String(n).padStart(2, '0')}` }));
const DRAGON_WALK_FRAMES = [1, 2, 3, 4].map((n) => ({ key: `dragon_walk_${String(n).padStart(2, '0')}` }));

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  preload() {
    this.load.image('background', backgroundUrl);
    for (const [key, url] of Object.entries(SPRITES)) {
      this.load.image(key, url);
    }
  }

  create() {
    this.inventory = { ember: 0, frost: 0, storm: 0 };
    this.totalCollected = { ember: 0, frost: 0, storm: 0 };
    this.nestLevel = 0;
    this.carrying = true;
    this.eggMaxHp = BALANCE.nestLevels[0].maxHp;
    this.eggHp = this.eggMaxHp;
    this.difficultyTier = 0;
    this.raidersDefeated = 0;
    this.gameOver = false;
    this.gameWon = false;
    this.lastAttackTime = -Infinity;
    this.startTime = this.time.now;
    this.transientMessage = '';
    this.transientMessageUntil = 0;
    this.raiders = [];

    this.createAnimations();
    this.buildWorld();
    this.buildNestVisuals();
    this.buildVolcanoVisuals();
    this.buildNodes();
    this.buildPlayer();
    this.buildHud();
    this.buildInput();

    this.cameras.main.setBounds(0, 0, WORLD.width, WORLD.height);
    this.cameras.main.startFollow(this.playerContainer, true, 0.09, 0.09);

    this.scale.on('resize', (gameSize) => {
      this.cameras.main.setViewport(0, 0, gameSize.width, gameSize.height);
      this.layoutHud(gameSize.width, gameSize.height);
    });

    this.scheduleTierIncrease();
    this.scheduleNextSpawn();
  }

  // ---------- animations ----------

  createAnimations() {
    const define = (key, frames, frameRate, repeat) => {
      if (!this.anims.exists(key)) {
        this.anims.create({ key, frames, frameRate, repeat });
      }
    };

    define('dragon-idle', DRAGON_IDLE_FRAMES, 4, -1);
    define('dragon-walk', DRAGON_WALK_FRAMES, 9, -1);
    define('egg-idle', EGG_IDLE_FRAMES, 3, -1);
    define('egg-hatch', EGG_HATCH_FRAMES, 6, 0);
  }

  // ---------- world ----------

  buildWorld() {
    const bg = this.add.image(WORLD.width / 2, WORLD.height / 2, 'background');
    const coverScale = Math.max(WORLD.width / bg.width, WORLD.height / bg.height);
    bg.setDisplaySize(bg.width * coverScale, bg.height * coverScale);
  }

  buildNestVisuals() {
    this.nestSiteRing = this.add.circle(NEST_SITE.x, NEST_SITE.y, 70, 0x8b5e3c, 0);
    this.nestSiteRing.setStrokeStyle(3, 0x8b5e3c, 0.7);
    this.nestLabel = this.add
      .text(NEST_SITE.x, NEST_SITE.y - 100, 'Nest Site', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#d8c39a',
      })
      .setOrigin(0.5);

    this.nestOuter = this.add.circle(NEST_SITE.x, NEST_SITE.y, 80, 0x6b4423, 1).setVisible(false);
    this.nestInner = this.add.circle(NEST_SITE.x, NEST_SITE.y, 55, 0x2d1a10, 1).setVisible(false);

    this.eggShape = this.add
      .sprite(NEST_SITE.x, NEST_SITE.y, 'egg_idle_01')
      .setScale(SPRITE_SCALE.eggNest)
      .setVisible(false);
    this.eggShape.play('egg-idle');

    this.eggNestHpBarBg = this.add.rectangle(NEST_SITE.x, NEST_SITE.y - 60, 70, 8, 0x000000, 0.4).setVisible(false);
    this.eggNestHpBarFill = this.add.rectangle(NEST_SITE.x - 35, NEST_SITE.y - 60, 70, 8, 0x4ade80).setOrigin(0, 0.5).setVisible(false);
  }

  buildVolcanoVisuals() {
    this.add.circle(VOLCANO.x, VOLCANO.y, 140, 0x3f1d1d);
    this.add.circle(VOLCANO.x, VOLCANO.y, 100, 0x7c2d12);
    this.volcanoGlow = this.add.circle(VOLCANO.x, VOLCANO.y, 55, 0xf97316);
    this.tweens.add({
      targets: this.volcanoGlow,
      alpha: { from: 1, to: 0.55 },
      scale: { from: 1, to: 1.12 },
      duration: 1400,
      yoyo: true,
      repeat: -1,
    });
    this.add
      .text(VOLCANO.x, VOLCANO.y - 175, 'Volcano', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: '#fca5a5',
      })
      .setOrigin(0.5);
  }

  buildNodes() {
    this.nodes = ROCK_NODES.map((cfg) => {
      const type = ROCK_TYPES[cfg.type];
      const circle = this.add.circle(cfg.x, cfg.y, 16, type.color);
      circle.setStrokeStyle(2, 0xffffff, 0.4);
      const text = this.add
        .text(cfg.x, cfg.y + 26, `${BALANCE.nodeReserve}`, {
          fontFamily: 'monospace',
          fontSize: '13px',
          color: '#e5e7eb',
        })
        .setOrigin(0.5);
      return { cfg, reserve: BALANCE.nodeReserve, circle, text };
    });
  }

  buildPlayer() {
    this.playerBody = this.add.sprite(0, 6, 'dragon_front_01').setScale(SPRITE_SCALE.player).setOrigin(0.5, 0.75);
    this.playerBody.play('dragon-idle');
    this.playerFacing = 1;

    this.playerEgg = this.add
      .sprite(0, -54, 'egg_idle_01')
      .setScale(SPRITE_SCALE.eggCarried);
    this.playerEgg.play('egg-idle');

    this.playerContainer = this.add.container(NEST_SITE.x + 60, NEST_SITE.y, [this.playerBody, this.playerEgg]);
  }

  // ---------- HUD ----------

  buildHud() {
    const style = { fontFamily: 'monospace', fontSize: '15px', color: '#e5e7eb' };
    const panelColor = 0x000000;
    const panelAlpha = 0.5;

    this.topLeftPanelBg = this.add.rectangle(0, 0, 250, 146, panelColor, panelAlpha).setOrigin(0, 0).setDepth(999).setScrollFactor(0);
    this.resourceText = this.add.text(16, 16, '', style).setDepth(1000).setScrollFactor(0);
    this.nestText = this.add.text(16, 96, '', style).setDepth(1000).setScrollFactor(0);

    this.topRightPanelBg = this.add.rectangle(0, 0, 170, 50, panelColor, panelAlpha).setOrigin(1, 0).setDepth(999).setScrollFactor(0);
    this.tierText = this.add.text(0, 16, '', style).setDepth(1000).setScrollFactor(0).setOrigin(1, 0);

    this.eggHpBarBg = this.add.rectangle(0, 16, 240, 18, 0x000000, 0.45).setDepth(1000).setScrollFactor(0);
    this.eggHpBarFill = this.add.rectangle(0, 16, 240, 18, 0x4ade80).setOrigin(0, 0.5).setDepth(1000).setScrollFactor(0);
    this.eggHpLabel = this.add
      .text(0, 16, '', { fontFamily: 'monospace', fontSize: '13px', color: '#111827' })
      .setDepth(1001)
      .setScrollFactor(0)
      .setOrigin(0.5);

    this.promptPanelBg = this.add.rectangle(0, 0, 10, 34, panelColor, panelAlpha).setOrigin(0.5).setDepth(999).setScrollFactor(0).setVisible(false);
    this.promptText = this.add
      .text(0, 0, '', { fontFamily: 'monospace', fontSize: '17px', color: '#fde68a' })
      .setDepth(1000)
      .setScrollFactor(0)
      .setOrigin(0.5);

    this.bottomLeftPanelBg = this.add.rectangle(0, 0, 560, 30, panelColor, panelAlpha).setOrigin(0, 0.5).setDepth(999).setScrollFactor(0);
    this.instructionsText = this.add
      .text(16, 0, 'Move: WASD/Arrows   Attack: SPACE   Interact/Build: E   Egg: Q', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#9ca3af',
      })
      .setDepth(1000)
      .setScrollFactor(0)
      .setOrigin(0, 0.5);

    this.messagePanelBg = this.add.rectangle(0, 0, 10, 30, panelColor, panelAlpha).setOrigin(0.5).setDepth(999).setScrollFactor(0).setVisible(false);
    this.messageText = this.add
      .text(0, 0, '', { fontFamily: 'monospace', fontSize: '15px', color: '#fca5a5' })
      .setDepth(1000)
      .setScrollFactor(0)
      .setOrigin(0.5);

    this.centerPanelBg = this.add.rectangle(0, 0, 560, 460, 0x000000, 0.75).setDepth(2000).setScrollFactor(0).setVisible(false);
    this.centerPortrait = this.add
      .sprite(0, 0, 'dragon_front_01')
      .setDepth(2001)
      .setScrollFactor(0)
      .setVisible(false);
    this.centerTitle = this.add
      .text(0, 0, '', { fontFamily: 'monospace', fontSize: '30px', color: '#fef3c7' })
      .setDepth(2001)
      .setScrollFactor(0)
      .setOrigin(0.5)
      .setVisible(false);
    this.centerBody = this.add
      .text(0, 0, '', { fontFamily: 'monospace', fontSize: '16px', color: '#e5e7eb', align: 'center' })
      .setDepth(2001)
      .setScrollFactor(0)
      .setOrigin(0.5)
      .setVisible(false);

    this.layoutHud(this.scale.width, this.scale.height);
  }

  layoutHud(width, height) {
    this.topRightPanelBg.setPosition(width - 16, 6);
    this.tierText.setPosition(width - 16, 16);
    this.eggHpBarBg.setPosition(width / 2, 16);
    this.eggHpBarFill.setPosition(width / 2 - 120, 16);
    this.eggHpLabel.setPosition(width / 2, 16);
    this.promptText.setPosition(width / 2, height - 90);
    this.promptPanelBg.setPosition(width / 2, height - 90);
    this.bottomLeftPanelBg.setPosition(0, height - 28);
    this.instructionsText.setPosition(16, height - 28);
    this.messageText.setPosition(width / 2, height - 130);
    this.messagePanelBg.setPosition(width / 2, height - 130);
    this.centerPanelBg.setPosition(width / 2, height / 2);
    this.centerPortrait.setPosition(width / 2, height / 2 - 110);
    this.centerTitle.setPosition(width / 2, height / 2 + 60);
    this.centerBody.setPosition(width / 2, height / 2 + 140);
  }

  // ---------- input ----------

  buildInput() {
    this.keys = this.input.keyboard.addKeys({
      up: 'W',
      down: 'S',
      left: 'A',
      right: 'D',
      up2: 'UP',
      down2: 'DOWN',
      left2: 'LEFT',
      right2: 'RIGHT',
    });

    this.input.keyboard.on('keydown-E', () => this.handleInteract());
    this.input.keyboard.on('keydown-Q', () => this.handleEggAction());
    this.input.keyboard.on('keydown-SPACE', () => this.handleAttack());
    this.input.keyboard.on('keydown-R', () => {
      if (this.gameOver || this.gameWon) this.scene.restart();
    });
  }

  // ---------- update ----------

  update(time, delta) {
    if (this.gameOver || this.gameWon) return;

    this.updatePlayerMovement(delta);
    this.updateRaiders(time, delta);
    this.updateNodesVisuals();
    this.updateHud(time);
  }

  updatePlayerMovement(delta) {
    let dx = 0;
    let dy = 0;
    if (this.keys.left.isDown || this.keys.left2.isDown) dx -= 1;
    if (this.keys.right.isDown || this.keys.right2.isDown) dx += 1;
    if (this.keys.up.isDown || this.keys.up2.isDown) dy -= 1;
    if (this.keys.down.isDown || this.keys.down2.isDown) dy += 1;

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
      const speed = BALANCE.playerSpeed * (this.carrying ? BALANCE.carrySpeedMultiplier : 1);
      const dist = (speed * delta) / 1000;
      this.playerContainer.x = Phaser.Math.Clamp(this.playerContainer.x + dx * dist, 20, WORLD.width - 20);
      this.playerContainer.y = Phaser.Math.Clamp(this.playerContainer.y + dy * dist, 20, WORLD.height - 20);

      if (dx !== 0) {
        this.playerFacing = dx < 0 ? -1 : 1;
      }
      this.playerBody.setFlipX(this.playerFacing < 0);
      this.playerBody.play('dragon-walk', true);
    } else {
      this.playerBody.play('dragon-idle', true);
    }

    this.playerEgg.setVisible(this.carrying);
  }

  // ---------- resources ----------

  totalRocks() {
    return this.inventory.ember + this.inventory.frost + this.inventory.storm;
  }

  spendRocks(amount) {
    let remaining = amount;
    for (const type of ROCK_ORDER) {
      const take = Math.min(this.inventory[type], remaining);
      this.inventory[type] -= take;
      remaining -= take;
      if (remaining <= 0) break;
    }
  }

  distanceTo(x, y) {
    return Phaser.Math.Distance.Between(this.playerContainer.x, this.playerContainer.y, x, y);
  }

  nearestHarvestableNode() {
    let best = null;
    let bestDist = Infinity;
    for (const node of this.nodes) {
      if (node.reserve <= 0) continue;
      const d = this.distanceTo(node.cfg.x, node.cfg.y);
      if (d <= BALANCE.interactRange && d < bestDist) {
        best = node;
        bestDist = d;
      }
    }
    return best;
  }

  nearNestSite() {
    return this.distanceTo(NEST_SITE.x, NEST_SITE.y) <= BALANCE.interactRange;
  }

  nearVolcano() {
    return this.distanceTo(VOLCANO.x, VOLCANO.y) <= BALANCE.volcanoRange;
  }

  showMessage(text) {
    this.transientMessage = text;
    this.transientMessageUntil = this.time.now + 2200;
  }

  handleInteract() {
    if (this.gameOver || this.gameWon) return;

    const node = this.nearestHarvestableNode();
    if (node) {
      node.reserve -= 1;
      this.inventory[node.cfg.type] += BALANCE.nodeYield;
      this.totalCollected[node.cfg.type] += BALANCE.nodeYield;
      if (node.reserve <= 0) {
        this.time.delayedCall(BALANCE.nodeRespawnMs, () => {
          node.reserve = BALANCE.nodeReserve;
        });
      }
      return;
    }

    if (this.nearNestSite()) {
      const nextLevel = this.nestLevel + 1;
      const levelConfig = BALANCE.nestLevels[nextLevel];
      if (!levelConfig) {
        this.showMessage('Nest is fully fortified.');
        return;
      }
      if (this.totalRocks() < levelConfig.cost) {
        this.showMessage(`Need ${levelConfig.cost} rocks (have ${this.totalRocks()}).`);
        return;
      }
      this.spendRocks(levelConfig.cost);
      this.nestLevel = nextLevel;
      this.eggMaxHp = levelConfig.maxHp;
      this.eggHp = this.eggMaxHp;
      if (this.nestLevel === 1) {
        this.carrying = false;
        this.showMessage('Nest built! The egg is safe inside... for now.');
      } else {
        this.showMessage(`Nest upgraded to level ${this.nestLevel}.`);
      }
      this.refreshNestVisuals();
    }
  }

  handleEggAction() {
    if (this.gameOver || this.gameWon) return;

    if (this.carrying) {
      if (this.nearVolcano()) {
        this.winGame();
        return;
      }
      if (this.nestLevel >= 1 && this.nearNestSite()) {
        this.carrying = false;
        this.showMessage('Egg placed back in the nest.');
        this.refreshNestVisuals();
      }
      return;
    }

    if (this.nestLevel >= 1 && this.nearNestSite()) {
      this.carrying = true;
      this.showMessage('Carrying the egg. Move carefully!');
      this.refreshNestVisuals();
    }
  }

  handleAttack() {
    if (this.gameOver || this.gameWon) return;
    if (this.time.now - this.lastAttackTime < BALANCE.attack.cooldownMs) return;
    this.lastAttackTime = this.time.now;

    const ring = this.add.circle(this.playerContainer.x, this.playerContainer.y, BALANCE.attack.range, 0xfef08a, 0.25);
    this.tweens.add({
      targets: ring,
      alpha: 0,
      scale: 1.3,
      duration: 220,
      onComplete: () => ring.destroy(),
    });

    for (const raider of this.raiders) {
      if (raider.dead) continue;
      const d = Phaser.Math.Distance.Between(this.playerContainer.x, this.playerContainer.y, raider.container.x, raider.container.y);
      if (d <= BALANCE.attack.range) {
        raider.hp -= BALANCE.attack.damage;
        if (raider.hp <= 0) {
          this.killRaider(raider);
        }
      }
    }
  }

  killRaider(raider) {
    raider.dead = true;
    this.raidersDefeated += 1;
    raider.container.destroy();
    raider.hpBarGfx.destroy();
  }

  // ---------- nest ----------

  refreshNestVisuals() {
    const built = this.nestLevel >= 1;
    this.nestSiteRing.setVisible(!built);
    this.nestLabel.setVisible(!built);
    this.nestOuter.setVisible(built);
    this.nestInner.setVisible(built);

    const eggInNest = built && !this.carrying;
    this.eggShape.setVisible(eggInNest);
    this.eggNestHpBarBg.setVisible(eggInNest);
    this.eggNestHpBarFill.setVisible(eggInNest);
  }

  // ---------- nodes ----------

  updateNodesVisuals() {
    for (const node of this.nodes) {
      if (node.reserve <= 0) {
        node.circle.setAlpha(0.25);
        node.text.setText('respawning');
      } else {
        node.circle.setAlpha(1);
        node.text.setText(`${node.reserve}`);
      }
    }
  }

  // ---------- raiders ----------

  scheduleTierIncrease() {
    this.time.addEvent({
      delay: BALANCE.raider.tierIntervalMs,
      loop: true,
      callback: () => {
        this.difficultyTier += 1;
      },
    });
  }

  scheduleNextSpawn() {
    const delay = Math.max(
      BALANCE.raider.minSpawnMs,
      BALANCE.raider.baseSpawnMs - this.difficultyTier * BALANCE.raider.spawnDecayPerTier
    );
    this.spawnTimer = this.time.delayedCall(delay, () => {
      if (!this.gameOver && !this.gameWon) {
        this.spawnRaider();
        this.scheduleNextSpawn();
      }
    });
  }

  randomEdgePoint() {
    const margin = 40;
    const side = Phaser.Math.Between(0, 3);
    if (side === 0) return { x: Phaser.Math.Between(margin, WORLD.width - margin), y: margin };
    if (side === 1) return { x: Phaser.Math.Between(margin, WORLD.width - margin), y: WORLD.height - margin };
    if (side === 2) return { x: margin, y: Phaser.Math.Between(margin, WORLD.height - margin) };
    return { x: WORLD.width - margin, y: Phaser.Math.Between(margin, WORLD.height - margin) };
  }

  spawnRaider() {
    const alive = this.raiders.filter((r) => !r.dead).length;
    if (alive >= BALANCE.raider.maxConcurrent) return;

    const { x, y } = this.randomEdgePoint();
    const hp = BALANCE.raider.baseHp + this.difficultyTier * BALANCE.raider.hpPerTier;
    const speed = BALANCE.raider.baseSpeed + this.difficultyTier * BALANCE.raider.speedPerTier;

    const body = this.add
      .sprite(0, 6, 'dragon_walk_01')
      .setScale(SPRITE_SCALE.raider)
      .setOrigin(0.5, 0.75)
      .setTint(0xdc2626);
    body.play('dragon-walk');
    const container = this.add.container(x, y, [body]);
    const hpBarGfx = this.add.graphics();

    this.raiders = this.raiders.filter((r) => !r.dead);
    this.raiders.push({
      container,
      body,
      hpBarGfx,
      hp,
      maxHp: hp,
      speed,
      facing: 1,
      attackElapsed: 0,
      dead: false,
    });
  }

  eggWorldPosition() {
    return this.carrying
      ? { x: this.playerContainer.x, y: this.playerContainer.y }
      : { x: NEST_SITE.x, y: NEST_SITE.y };
  }

  updateRaiders(time, delta) {
    const target = this.eggWorldPosition();
    const nestDefense = BALANCE.nestLevels[this.nestLevel]
      ? BALANCE.nestLevels[this.nestLevel].defenseMultiplier
      : 1;

    for (const raider of this.raiders) {
      if (raider.dead) continue;

      const d = Phaser.Math.Distance.Between(raider.container.x, raider.container.y, target.x, target.y);
      if (d > BALANCE.raider.attackRange) {
        const angle = Phaser.Math.Angle.Between(raider.container.x, raider.container.y, target.x, target.y);
        const move = (raider.speed * delta) / 1000;
        raider.container.x += Math.cos(angle) * move;
        raider.container.y += Math.sin(angle) * move;
        raider.attackElapsed = 0;

        const dx = Math.cos(angle);
        if (Math.abs(dx) > 0.05) {
          raider.facing = dx < 0 ? -1 : 1;
          raider.body.setFlipX(raider.facing < 0);
        }
      } else {
        raider.attackElapsed += delta;
        if (raider.attackElapsed >= BALANCE.raider.attackIntervalMs) {
          raider.attackElapsed = 0;
          const multiplier = this.carrying ? 1 : nestDefense;
          this.damageEgg(BALANCE.raider.attackDamage * multiplier);
        }
      }

      raider.hpBarGfx.clear();
      const barWidth = 26;
      raider.hpBarGfx.fillStyle(0x000000, 0.5);
      raider.hpBarGfx.fillRect(raider.container.x - barWidth / 2, raider.container.y - 26, barWidth, 5);
      raider.hpBarGfx.fillStyle(0xef4444, 1);
      raider.hpBarGfx.fillRect(
        raider.container.x - barWidth / 2,
        raider.container.y - 26,
        barWidth * Phaser.Math.Clamp(raider.hp / raider.maxHp, 0, 1),
        5
      );
    }

    if (this.raiders.length > 40) {
      this.raiders = this.raiders.filter((r) => !r.dead);
    }
  }

  damageEgg(amount) {
    this.eggHp = Phaser.Math.Clamp(this.eggHp - amount, 0, this.eggMaxHp);
    if (this.eggHp <= 0) {
      this.loseGame();
    }
  }

  // ---------- HUD update ----------

  updateHud(time) {
    this.resourceText.setText(
      [
        `Ember: ${this.inventory.ember}  (total ${this.totalCollected.ember})`,
        `Frost: ${this.inventory.frost}  (total ${this.totalCollected.frost})`,
        `Storm: ${this.inventory.storm}  (total ${this.totalCollected.storm})`,
      ].join('\n')
    );

    const nestLabel = this.nestLevel === 0 ? 'not built' : `level ${this.nestLevel}`;
    this.nestText.setText(`Nest: ${nestLabel}\nEgg status: ${this.carrying ? 'carried' : 'in nest'}`);

    this.tierText.setText(`Raid tier: ${this.difficultyTier + 1}\nDefeated: ${this.raidersDefeated}`);

    const hpRatio = Phaser.Math.Clamp(this.eggHp / this.eggMaxHp, 0, 1);
    this.eggHpBarFill.width = 240 * hpRatio;
    this.eggHpBarFill.setFillStyle(hpRatio > 0.5 ? 0x4ade80 : hpRatio > 0.25 ? 0xfacc15 : 0xef4444);
    this.eggHpLabel.setText(`Egg HP ${Math.ceil(this.eggHp)}/${this.eggMaxHp}`);

    if (this.eggShape.visible) {
      const ratio = Phaser.Math.Clamp(this.eggHp / this.eggMaxHp, 0, 1);
      this.eggNestHpBarFill.width = 70 * ratio;
      this.eggNestHpBarFill.setFillStyle(ratio > 0.5 ? 0x4ade80 : ratio > 0.25 ? 0xfacc15 : 0xef4444);
    }

    this.promptText.setText(this.computePrompt());
    this.fitPanelToText(this.promptPanelBg, this.promptText, 24, 14);

    if (time < this.transientMessageUntil) {
      this.messageText.setText(this.transientMessage);
    } else {
      this.messageText.setText('');
    }
    this.fitPanelToText(this.messagePanelBg, this.messageText, 24, 12);
  }

  fitPanelToText(panel, text, paddingX, paddingY) {
    if (text.text.length === 0) {
      panel.setVisible(false);
      return;
    }
    panel.setVisible(true);
    panel.width = text.width + paddingX;
    panel.height = text.height + paddingY;
  }

  computePrompt() {
    const node = this.nearestHarvestableNode();
    if (node) {
      return `[E] Harvest ${ROCK_TYPES[node.cfg.type].label} (${node.reserve} left)`;
    }

    if (this.nearNestSite()) {
      const nextLevel = this.nestLevel + 1;
      const levelConfig = BALANCE.nestLevels[nextLevel];
      let line = levelConfig ? `[E] ${this.nestLevel === 0 ? 'Build' : 'Upgrade'} Nest (cost ${levelConfig.cost})` : 'Nest fully fortified';
      if (this.nestLevel >= 1) {
        line += this.carrying ? '  |  [Q] Place Egg' : '  |  [Q] Take Egg';
      }
      return line;
    }

    if (this.carrying && this.nearVolcano()) {
      return '[Q] Drop the egg into the Volcano!';
    }

    return '';
  }

  // ---------- end states ----------

  elapsedSeconds() {
    return Math.floor((this.time.now - this.startTime) / 1000);
  }

  loseGame() {
    if (this.gameOver || this.gameWon) return;
    this.gameOver = true;
    if (this.spawnTimer) this.spawnTimer.remove(false);

    this.centerPanelBg.setVisible(true);
    this.centerPortrait
      .setTexture('egg_idle_01')
      .setScale(2.2)
      .setTint(0x4b5563)
      .stop()
      .setVisible(true);
    this.centerTitle.setText('The egg was lost...').setVisible(true);
    this.centerBody
      .setText(
        [
          'Raiders overwhelmed your defenses.',
          `Survived ${this.elapsedSeconds()}s  |  Raiders defeated: ${this.raidersDefeated}`,
          '',
          'Press R to try again',
        ].join('\n')
      )
      .setVisible(true);
  }

  winGame() {
    if (this.gameOver || this.gameWon) return;
    this.gameWon = true;
    if (this.spawnTimer) this.spawnTimer.remove(false);

    const dragon = this.determineDragon();

    this.centerPanelBg.setVisible(true);
    this.centerPortrait
      .setTexture('egg_hatch_01')
      .setScale(2.4)
      .clearTint()
      .setVisible(true);
    this.centerPortrait.play('egg-hatch');
    this.centerPortrait.once('animationcomplete', () => {
      this.centerPortrait.setTexture('dragon_front_01').setScale(SPRITE_SCALE.portrait);
      const tint = DRAGON_TINTS[dragon];
      if (tint !== undefined) {
        this.centerPortrait.setTint(tint);
      } else {
        this.startPrismaticShimmer();
      }
      this.centerPortrait.play('dragon-idle');
    });

    this.centerTitle.setText(`Your ${dragon} hatched!`).setVisible(true);
    this.centerBody
      .setText(
        [
          `Ember ${this.totalCollected.ember}  Frost ${this.totalCollected.frost}  Storm ${this.totalCollected.storm}`,
          `Time: ${this.elapsedSeconds()}s  |  Raiders defeated: ${this.raidersDefeated}`,
          '',
          'Press R to play again',
        ].join('\n')
      )
      .setVisible(true);
  }

  startPrismaticShimmer() {
    const colors = ROCK_ORDER.map((type) => ROCK_TYPES[type].color);
    let i = 0;
    this.time.addEvent({
      delay: 260,
      loop: true,
      callback: () => {
        i = (i + 1) % colors.length;
        this.centerPortrait.setTint(colors[i]);
      },
    });
  }

  determineDragon() {
    const max = Math.max(this.totalCollected.ember, this.totalCollected.frost, this.totalCollected.storm);
    if (max === 0) return HYBRID_DRAGON;
    const winners = ROCK_ORDER.filter((type) => this.totalCollected[type] === max);
    if (winners.length > 1) return HYBRID_DRAGON;
    return ROCK_TYPES[winners[0]].dragon;
  }
}
