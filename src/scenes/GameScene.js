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
import { sendMessage } from '../net/client.js';

const ROCK_ORDER = Object.keys(ROCK_TYPES);

const SPRITE_MODULES = import.meta.glob('../assets/sprites/*.png', { eager: true, import: 'default' });
const SPRITES = Object.fromEntries(
  Object.entries(SPRITE_MODULES).map(([path, url]) => [path.split('/').pop().replace('.png', ''), url])
);

const EGG_IDLE_FRAMES = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ key: `egg_idle_${String(n).padStart(2, '0')}` }));
const EGG_HATCH_FRAMES = [1, 2, 3, 4].map((n) => ({ key: `egg_hatch_${String(n).padStart(2, '0')}` }));
const DRAGON_IDLE_FRAMES = [1, 2, 3, 4].map((n) => ({ key: `dragon_front_${String(n).padStart(2, '0')}` }));
const DRAGON_WALK_FRAMES = [1, 2, 3, 4].map((n) => ({ key: `dragon_walk_${String(n).padStart(2, '0')}` }));

const COMPACT_WIDTH_THRESHOLD = 700;
const JOYSTICK_RADIUS = 50;
const JOYSTICK_HIT_RADIUS = 80;
const JOYSTICK_DEAD_ZONE = 10;

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  preload() {
    for (const [key, url] of Object.entries(SPRITES)) {
      this.load.image(key, url);
    }
  }

  create(data) {
    this.mode = data?.mode === 'guardianRaider' ? 'guardianRaider' : data?.mode === 'online' ? 'online' : 'solo';
    this.onlineRole = data?.role ?? null;
    this.socket = data?.socket ?? null;
    this.peerConnected = this.mode !== 'online';
    this.lastPosSentAt = 0;

    const initial = data?.initialState ?? null;

    this.inventory = initial ? { ...initial.inventory } : { ember: 0, frost: 0, storm: 0 };
    this.totalCollected = initial ? { ...initial.totalCollected } : { ember: 0, frost: 0, storm: 0 };
    this.nestLevel = initial ? initial.nestLevel : 0;
    this.carrying = initial ? initial.carrying : true;
    this.eggMaxHp = initial ? initial.eggMaxHp : BALANCE.nestLevels[0].maxHp;
    this.eggHp = initial ? initial.eggHp : this.eggMaxHp;
    this.difficultyTier = 0;
    this.raidersDefeated = initial ? initial.raidersDefeated : 0;
    this.gameOver = false;
    this.gameWon = false;
    this.lastAttackTime = -Infinity;
    this.startTime = this.time.now;
    this.transientMessage = '';
    this.transientMessageUntil = 0;
    this.raiders = [];
    this.humanRaider = null;

    this.inputState = { moveX: 0, moveY: 0, interact: false, eggAction: false, attack: false };
    this.raiderInputState = { moveX: 0, moveY: 0, attack: false };
    // In online mode only one role is ever local, and keyboard/touch input
    // always writes into `inputState` — alias it to `raiderInputState` when
    // the Raider is local so the existing movement/touch code drives it
    // without needing a parallel input path.
    if (this.mode === 'online' && this.onlineRole === 'raider') {
      this.raiderInputState = this.inputState;
    }
    this.keyboardMoving = false;
    this.raiderKeyboardMoving = false;
    this.isTouch = this.sys.game.device.input.touch;
    this.compactHud = false;
    this.safeArea = this.probeSafeArea();

    this.createAnimations();
    this.buildWorld();
    this.buildNestVisuals();
    this.buildVolcanoVisuals();
    this.buildNodes(initial?.nodes);
    this.buildPlayer();
    this.buildHud();
    this.buildInput();
    this.buildTouchControls();

    this.cameras.main.setBounds(0, 0, WORLD.width, WORLD.height);

    if (this.mode === 'guardianRaider' || this.mode === 'online') {
      this.spawnHumanRaider(initial);
    }

    const followTarget = this.mode === 'online' && this.onlineRole === 'raider' ? this.humanRaider.container : this.playerContainer;
    this.cameras.main.startFollow(followTarget, true, 0.09, 0.09);
    this.refreshNestVisuals();

    this.scale.on('resize', (gameSize) => {
      this.cameras.main.setViewport(0, 0, gameSize.width, gameSize.height);
      this.safeArea = this.probeSafeArea();
      this.layoutHud(gameSize.width, gameSize.height);
    });

    // Some mobile browsers report a stale viewport size to ResizeObserver right
    // after rotation; force Phaser to recompute so the 'resize' handler above
    // always fires with correct dimensions. The layout itself is orientation-
    // independent (see layoutHud/layoutTouchControls), so there's no lock to
    // apply here — this only fixes the canvas staying the wrong size.
    const forceRescale = () => this.scale.refresh();
    window.addEventListener('resize', forceRescale);
    window.addEventListener('orientationchange', forceRescale);
    this.events.once('shutdown', () => {
      window.removeEventListener('resize', forceRescale);
      window.removeEventListener('orientationchange', forceRescale);
      this.socket?.removeEventListener('message', this.onNetworkMessage);
      this.socket?.removeEventListener('close', this.onNetworkClose);
    });

    this.layoutHud(this.scale.width, this.scale.height);

    if (this.mode === 'solo') {
      this.scheduleTierIncrease();
      this.scheduleNextSpawn();
    } else if (this.mode === 'online') {
      this.setupNetwork();
    }
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
    this.add.rectangle(0, 0, WORLD.width, WORLD.height, 0x1f2b1a).setOrigin(0, 0);
    const grid = this.add.graphics();
    grid.lineStyle(1, 0xffffff, 0.05);
    for (let x = 0; x <= WORLD.width; x += 100) {
      grid.lineBetween(x, 0, x, WORLD.height);
    }
    for (let y = 0; y <= WORLD.height; y += 100) {
      grid.lineBetween(0, y, WORLD.width, y);
    }
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

  buildNodes(initialNodes) {
    this.nodes = ROCK_NODES.map((cfg, id) => {
      const type = ROCK_TYPES[cfg.type];
      const reserve = initialNodes ? initialNodes.find((n) => n.id === id)?.reserve ?? BALANCE.nodeReserve : BALANCE.nodeReserve;
      const circle = this.add.circle(cfg.x, cfg.y, 16, type.color);
      circle.setStrokeStyle(2, 0xffffff, 0.4);
      const text = this.add
        .text(cfg.x, cfg.y + 26, `${reserve}`, {
          fontFamily: 'monospace',
          fontSize: '13px',
          color: '#e5e7eb',
        })
        .setOrigin(0.5);
      return { id, cfg, reserve, circle, text };
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

    const isRaider = this.mode === 'online' && this.onlineRole === 'raider';
    const instructions = isRaider
      ? 'Move: WASD/Arrows   Attack: SPACE — get close to the egg and strike!'
      : 'Move: WASD/Arrows   Attack: SPACE   Interact/Build: E   Egg: Q';
    this.bottomLeftPanelBg = this.add.rectangle(0, 0, 560, 30, panelColor, panelAlpha).setOrigin(0, 0.5).setDepth(999).setScrollFactor(0);
    this.instructionsText = this.add
      .text(16, 0, instructions, {
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

    this.centerPanelBg = this.add
      .rectangle(0, 0, 560, 460, 0x000000, 0.75)
      .setDepth(2000)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive();
    // Tap-to-restart for touch devices, which have no keyboard for the R key.
    this.centerPanelBg.on('pointerdown', () => this.restartOrExit());
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

    if (this.isTouch) {
      this.instructionsText.setVisible(false);
      this.bottomLeftPanelBg.setVisible(false);
    }
  }

  layoutHud(width, height) {
    this.compactHud = this.isTouch || width < COMPACT_WIDTH_THRESHOLD;
    const narrow = width < 500;
    const fontScale = this.compactHud ? 0.85 : 1;

    const topLeftWidth = narrow ? 150 : 250;
    const topRightWidth = narrow ? 140 : 170;

    this.topLeftPanelBg.setPosition(0, 0);
    this.topLeftPanelBg.width = topLeftWidth;
    this.topLeftPanelBg.height = this.compactHud ? 96 : 146;
    this.resourceText.setFontSize(Math.round(15 * fontScale));
    this.nestText.setFontSize(Math.round(15 * fontScale));
    this.nestText.setPosition(16, this.compactHud ? 48 : 96);

    this.topRightPanelBg.width = topRightWidth;
    this.topRightPanelBg.setPosition(width - 16, 6);
    this.tierText.setPosition(width - 16, 16);
    this.tierText.setFontSize(Math.round(15 * fontScale));

    // On narrow screens the corner panels are too wide to share a row with a
    // centered fixed-width egg bar, so shrink it and stack it in its own row
    // below the top panels, with the prompt line in a further row below that.
    this.eggHpBarMaxWidth = narrow ? Math.min(200, width - 40) : 240;
    const eggBarY = narrow ? 118 : 16;
    this.eggHpBarBg.width = this.eggHpBarMaxWidth;
    this.eggHpBarBg.setPosition(width / 2, eggBarY);
    this.eggHpBarFill.setPosition(width / 2 - this.eggHpBarMaxWidth / 2, eggBarY);
    this.eggHpLabel.setPosition(width / 2, eggBarY);

    if (this.compactHud) {
      const promptY = narrow ? 158 : 116;
      this.promptText.setPosition(width / 2, promptY);
      this.promptPanelBg.setPosition(width / 2, promptY);
    } else {
      this.promptText.setPosition(width / 2, height - 90);
      this.promptPanelBg.setPosition(width / 2, height - 90);
    }

    this.bottomLeftPanelBg.setPosition(0, height - 28);
    this.instructionsText.setPosition(16, height - 28);
    this.messageText.setPosition(width / 2, height - 130);
    this.messagePanelBg.setPosition(width / 2, height - 130);

    const modalWidth = Math.min(560, width * 0.92);
    const modalHeight = Math.min(460, height * 0.85);
    this.centerPanelBg.setPosition(width / 2, height / 2);
    this.centerPanelBg.width = modalWidth;
    this.centerPanelBg.height = modalHeight;
    this.centerPortrait.setPosition(width / 2, height / 2 - modalHeight * 0.24);
    this.centerTitle.setPosition(width / 2, height / 2 + modalHeight * 0.13);
    this.centerTitle.setFontSize(Math.round(30 * Math.min(1, modalWidth / 560)));
    this.centerBody.setPosition(width / 2, height / 2 + modalHeight * 0.3);

    this.layoutTouchControls(width, height);
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

    this.input.keyboard.on('keydown-E', () => {
      this.inputState.interact = true;
    });
    this.input.keyboard.on('keydown-Q', () => {
      this.inputState.eggAction = true;
    });
    this.input.keyboard.on('keydown-SPACE', () => {
      this.inputState.attack = true;
    });
    this.input.keyboard.on('keydown-ENTER', () => {
      if (this.mode === 'guardianRaider') this.raiderInputState.attack = true;
    });
    this.input.keyboard.on('keydown-R', () => this.restartOrExit());
  }

  restartOrExit() {
    if (!this.gameOver && !this.gameWon) return;
    if (this.mode === 'online') {
      this.socket?.close();
      this.scene.start('ModeSelectScene');
    } else {
      this.scene.restart({ mode: this.mode });
    }
  }

  pollKeyboardMovement() {
    // In 2-player local-test mode the arrow keys drive the Raider instead of
    // doubling up on the Guardian, so both roles can share one keyboard.
    const arrowsControlGuardian = this.mode !== 'guardianRaider';

    let dx = 0;
    let dy = 0;
    if (this.keys.left.isDown || (arrowsControlGuardian && this.keys.left2.isDown)) dx -= 1;
    if (this.keys.right.isDown || (arrowsControlGuardian && this.keys.right2.isDown)) dx += 1;
    if (this.keys.up.isDown || (arrowsControlGuardian && this.keys.up2.isDown)) dy -= 1;
    if (this.keys.down.isDown || (arrowsControlGuardian && this.keys.down2.isDown)) dy += 1;

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      this.inputState.moveX = dx / len;
      this.inputState.moveY = dy / len;
      this.keyboardMoving = true;
    } else if (this.keyboardMoving) {
      this.inputState.moveX = 0;
      this.inputState.moveY = 0;
      this.keyboardMoving = false;
    }

    if (this.mode === 'guardianRaider') {
      let rdx = 0;
      let rdy = 0;
      if (this.keys.left2.isDown) rdx -= 1;
      if (this.keys.right2.isDown) rdx += 1;
      if (this.keys.up2.isDown) rdy -= 1;
      if (this.keys.down2.isDown) rdy += 1;

      if (rdx !== 0 || rdy !== 0) {
        const rlen = Math.hypot(rdx, rdy);
        this.raiderInputState.moveX = rdx / rlen;
        this.raiderInputState.moveY = rdy / rlen;
        this.raiderKeyboardMoving = true;
      } else if (this.raiderKeyboardMoving) {
        this.raiderInputState.moveX = 0;
        this.raiderInputState.moveY = 0;
        this.raiderKeyboardMoving = false;
      }
    }
  }

  consumeInputActions() {
    if (this.mode === 'online') {
      if (this.onlineRole === 'guardian') {
        if (this.inputState.interact) {
          this.inputState.interact = false;
          this.sendGuardianInteract();
        }
        if (this.inputState.eggAction) {
          this.inputState.eggAction = false;
          this.sendGuardianEggAction();
        }
        if (this.inputState.attack) {
          this.inputState.attack = false;
          this.sendGuardianAttack();
        }
      } else if (this.onlineRole === 'raider' && this.inputState.attack) {
        this.inputState.attack = false;
        this.sendRaiderAttack();
      }
      return;
    }

    if (this.inputState.interact) {
      this.inputState.interact = false;
      this.handleInteract();
    }
    if (this.inputState.eggAction) {
      this.inputState.eggAction = false;
      this.handleEggAction();
    }
    if (this.inputState.attack) {
      this.inputState.attack = false;
      this.handleAttack();
    }
    if (this.mode === 'guardianRaider' && this.raiderInputState.attack) {
      this.raiderInputState.attack = false;
      this.handleRaiderAttack();
    }
  }

  // ---------- online networking ----------
  //
  // Movement is client-authoritative and simply relayed: each device sends
  // its own local role's position on a short interval, and applies whatever
  // it receives for the other role directly (no interpolation/prediction —
  // acceptable for a casual 2-friend game). Every other action (harvesting,
  // building, attacking, the egg, win/lose) is sent to the server instead of
  // applied locally, and the resulting authoritative state comes back via
  // 'stateUpdate' broadcasts to both clients — including the sender, so
  // there's no separate "local prediction" path to keep in sync.

  setupNetwork() {
    this.onNetworkMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handleNetworkMessage(msg);
    };
    this.onNetworkClose = () => {
      this.peerConnected = false;
      if (!this.gameOver && !this.gameWon) {
        this.showMessage('Connection lost — trying to reconnect...');
      }
    };
    this.socket.addEventListener('message', this.onNetworkMessage);
    this.socket.addEventListener('close', this.onNetworkClose);
  }

  handleNetworkMessage(msg) {
    if (msg.type === 'pos') {
      this.applyRemotePos(msg);
    } else if (msg.type === 'stateUpdate') {
      this.applyServerState(msg.state);
    } else if (msg.type === 'peerJoined') {
      this.peerConnected = true;
      this.showMessage("Your friend joined!");
    } else if (msg.type === 'peerLeft') {
      this.peerConnected = false;
      this.showMessage('Your friend disconnected.');
    }
  }

  applyRemotePos(msg) {
    const remoteRole = this.onlineRole === 'guardian' ? 'raider' : 'guardian';
    if (msg.role !== remoteRole) return;

    if (remoteRole === 'guardian') {
      this.playerContainer.setPosition(msg.x, msg.y);
      this.playerFacing = msg.facing;
      this.playerBody.setFlipX(msg.facing < 0);
      this.playerBody.play(msg.moving ? 'dragon-walk' : 'dragon-idle', true);
    } else if (this.humanRaider) {
      this.humanRaider.container.setPosition(msg.x, msg.y);
      this.humanRaider.facing = msg.facing;
      this.humanRaider.body.setFlipX(msg.facing < 0);
      this.humanRaider.body.play(msg.moving ? 'dragon-walk' : 'dragon-idle', true);
    }
  }

  applyServerState(state) {
    this.inventory = state.inventory;
    this.totalCollected = state.totalCollected;
    this.nestLevel = state.nestLevel;
    this.eggMaxHp = state.eggMaxHp;
    this.eggHp = state.eggHp;
    this.carrying = state.carrying;
    this.raidersDefeated = state.raidersDefeated;
    this.playerEgg.setVisible(this.carrying);

    for (const nodeState of state.nodes) {
      const node = this.nodes.find((n) => n.id === nodeState.id);
      if (node) node.reserve = nodeState.reserve;
    }

    if (this.humanRaider) {
      const wasDead = this.humanRaider.dead;
      this.humanRaider.hp = state.raiderHp;
      this.humanRaider.maxHp = state.raiderMaxHp;
      this.humanRaider.dead = state.raiderDead;
      this.humanRaider.container.setVisible(!state.raiderDead);

      if (wasDead && !state.raiderDead && this.onlineRole === 'raider') {
        const { x, y } = this.randomEdgePoint();
        this.humanRaider.container.setPosition(x, y);
      }
    }

    this.refreshNestVisuals();

    if ((state.gameWon || state.gameOver) && !this.gameWon && !this.gameOver) {
      this.gameWon = state.gameWon;
      this.gameOver = state.gameOver;
      if (this.spawnTimer) this.spawnTimer.remove(false);
      this.showOnlineEndScreen(state, state.winnerRole === this.onlineRole);
    }
  }

  updatePosBroadcast(time) {
    if (time - this.lastPosSentAt < 80) return;
    this.lastPosSentAt = time;

    if (this.onlineRole === 'guardian') {
      sendMessage(this.socket, {
        type: 'pos',
        x: this.playerContainer.x,
        y: this.playerContainer.y,
        facing: this.playerFacing,
        moving: this.inputState.moveX !== 0 || this.inputState.moveY !== 0,
      });
    } else if (this.onlineRole === 'raider' && this.humanRaider) {
      sendMessage(this.socket, {
        type: 'pos',
        x: this.humanRaider.container.x,
        y: this.humanRaider.container.y,
        facing: this.humanRaider.facing,
        moving: this.raiderInputState.moveX !== 0 || this.raiderInputState.moveY !== 0,
      });
    }
  }

  sendGuardianInteract() {
    const node = this.nearestHarvestableNode();
    const x = this.playerContainer.x;
    const y = this.playerContainer.y;
    if (node) {
      sendMessage(this.socket, { type: 'action', kind: 'harvest', nodeId: node.id, x, y });
      return;
    }
    if (this.nearNestSite()) {
      sendMessage(this.socket, { type: 'action', kind: 'build', x, y });
    }
  }

  sendGuardianEggAction() {
    const x = this.playerContainer.x;
    const y = this.playerContainer.y;
    if (this.carrying) {
      if (this.nearVolcano()) {
        sendMessage(this.socket, { type: 'action', kind: 'eggDrop', x, y });
      } else if (this.nestLevel >= 1 && this.nearNestSite()) {
        sendMessage(this.socket, { type: 'action', kind: 'eggPlace', x, y });
      }
      return;
    }
    if (this.nestLevel >= 1 && this.nearNestSite()) {
      sendMessage(this.socket, { type: 'action', kind: 'eggPickup', x, y });
    }
  }

  sendGuardianAttack() {
    if (this.time.now - this.lastAttackTime < BALANCE.attack.cooldownMs) return;
    this.lastAttackTime = this.time.now;
    this.showAttackSwing(this.playerContainer.x, this.playerContainer.y, 0xfef08a);
    if (!this.humanRaider) return;

    sendMessage(this.socket, {
      type: 'action',
      kind: 'guardianAttack',
      guardianX: this.playerContainer.x,
      guardianY: this.playerContainer.y,
      raiderX: this.humanRaider.container.x,
      raiderY: this.humanRaider.container.y,
    });
  }

  sendRaiderAttack() {
    const raider = this.humanRaider;
    if (!raider || raider.dead) return;
    if (this.time.now - raider.lastAttackTime < BALANCE.attack.cooldownMs) return;
    raider.lastAttackTime = this.time.now;
    this.showAttackSwing(raider.container.x, raider.container.y, 0xef4444);

    sendMessage(this.socket, {
      type: 'action',
      kind: 'raiderAttack',
      raiderX: raider.container.x,
      raiderY: raider.container.y,
      guardianX: this.playerContainer.x,
      guardianY: this.playerContainer.y,
    });
  }

  showOnlineEndScreen(state, iWon) {
    this.centerPanelBg.setVisible(true);

    if (state.gameWon) {
      const dragon = state.dragon;
      this.centerPortrait.setTexture('egg_hatch_01').setScale(2.4).clearTint().setVisible(true);
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
      this.centerTitle.setText(iWon ? `Your ${dragon} hatched!` : `The Guardian's ${dragon} hatched...`).setVisible(true);
    } else {
      this.centerPortrait.setTexture('egg_idle_01').setScale(2.2).setTint(0x4b5563).stop().setVisible(true);
      this.centerTitle.setText(iWon ? 'You destroyed the egg!' : 'Your egg was destroyed...').setVisible(true);
    }

    this.centerBody
      .setText(
        [
          `Ember ${state.totalCollected.ember}  Frost ${state.totalCollected.frost}  Storm ${state.totalCollected.storm}`,
          `Time: ${this.elapsedSeconds()}s  |  Raiders defeated: ${state.raidersDefeated}`,
          '',
          'Press R to return to the menu',
        ].join('\n')
      )
      .setVisible(true);
  }

  // ---------- touch controls ----------

  probeSafeArea() {
    if (typeof document === 'undefined') return { top: 0, right: 0, bottom: 0, left: 0 };
    const div = document.createElement('div');
    div.style.position = 'fixed';
    div.style.top = '0';
    div.style.left = '0';
    div.style.width = '0';
    div.style.height = '0';
    div.style.paddingTop = 'env(safe-area-inset-top)';
    div.style.paddingRight = 'env(safe-area-inset-right)';
    div.style.paddingBottom = 'env(safe-area-inset-bottom)';
    div.style.paddingLeft = 'env(safe-area-inset-left)';
    document.body.appendChild(div);
    const cs = getComputedStyle(div);
    const insets = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };
    document.body.removeChild(div);
    return insets;
  }

  buildTouchControls() {
    if (!this.isTouch) return;

    this.joystickActive = false;
    this.joystickPointerId = null;
    this.joystickOrigin = { x: 0, y: 0 };

    this.joystickBase = this.add.circle(0, 0, JOYSTICK_RADIUS, 0xffffff, 0.15).setStrokeStyle(3, 0xffffff, 0.4).setScrollFactor(0).setDepth(1500);
    this.joystickKnob = this.add.circle(0, 0, 24, 0xffffff, 0.35).setScrollFactor(0).setDepth(1501);
    this.joystickZone = this.add
      .circle(0, 0, JOYSTICK_HIT_RADIUS, 0xffffff, 0.001)
      .setScrollFactor(0)
      .setDepth(1502)
      .setInteractive();

    this.joystickZone.on('pointerdown', (pointer) => {
      this.joystickActive = true;
      this.joystickPointerId = pointer.id;
      this.updateJoystickFromPointer(pointer);
    });
    this.input.on('pointermove', (pointer) => {
      if (this.joystickActive && pointer.id === this.joystickPointerId) {
        this.updateJoystickFromPointer(pointer);
      }
    });
    this.input.on('pointerup', (pointer) => {
      if (this.joystickActive && pointer.id === this.joystickPointerId) {
        this.releaseJoystick();
      }
    });
    this.input.on('pointerupoutside', (pointer) => {
      if (this.joystickActive && pointer.id === this.joystickPointerId) {
        this.releaseJoystick();
      }
    });

    const makeButton = (radius, color) =>
      this.add.circle(0, 0, radius, color, 0.35).setStrokeStyle(3, 0xffffff, 0.55).setScrollFactor(0).setDepth(1500).setInteractive();
    const labelStyle = { fontFamily: 'monospace', fontSize: '12px', color: '#111827', fontStyle: 'bold' };
    const makeLabel = (text) => this.add.text(0, 0, text, labelStyle).setOrigin(0.5).setScrollFactor(0).setDepth(1501);

    this.attackButton = makeButton(38, 0xfef08a);
    this.attackLabel = makeLabel('ATK');
    this.eggButton = makeButton(32, 0x60a5fa);
    this.eggLabel = makeLabel('EGG');
    this.interactButton = makeButton(32, 0x4ade80);
    this.interactLabel = makeLabel('USE');

    this.attackButton.on('pointerdown', () => {
      this.inputState.attack = true;
    });
    this.eggButton.on('pointerdown', () => {
      this.inputState.eggAction = true;
    });
    this.interactButton.on('pointerdown', () => {
      this.inputState.interact = true;
    });
  }

  updateJoystickFromPointer(pointer) {
    const origin = this.joystickOrigin;
    const dx = pointer.x - origin.x;
    const dy = pointer.y - origin.y;
    const dist = Math.hypot(dx, dy);

    if (dist < JOYSTICK_DEAD_ZONE) {
      this.inputState.moveX = 0;
      this.inputState.moveY = 0;
      this.joystickKnob.setPosition(origin.x, origin.y);
      return;
    }

    const angle = Math.atan2(dy, dx);
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    const clamped = Math.min(dist, JOYSTICK_RADIUS);

    this.inputState.moveX = nx;
    this.inputState.moveY = ny;
    this.joystickKnob.setPosition(origin.x + nx * clamped, origin.y + ny * clamped);
  }

  releaseJoystick() {
    this.joystickActive = false;
    this.joystickPointerId = null;
    this.inputState.moveX = 0;
    this.inputState.moveY = 0;
    if (this.joystickKnob) this.joystickKnob.setPosition(this.joystickOrigin.x, this.joystickOrigin.y);
  }

  layoutTouchControls(width, height) {
    if (!this.isTouch) return;
    const sa = this.safeArea;

    const joyX = 90 + sa.left;
    const joyY = height - 110 - sa.bottom;
    this.joystickOrigin = { x: joyX, y: joyY };
    this.joystickBase.setPosition(joyX, joyY);
    this.joystickZone.setPosition(joyX, joyY);
    if (!this.joystickActive) this.joystickKnob.setPosition(joyX, joyY);

    const btnX = width - 60 - sa.right;
    const topSafeY = 70;
    const attackY = height - 90 - sa.bottom;
    const gap = Math.min(80, Math.max(50, (attackY - topSafeY) / 2));
    const eggY = attackY - gap;
    const interactY = eggY - gap;

    this.attackButton.setPosition(btnX, attackY);
    this.attackLabel.setPosition(btnX, attackY);
    this.eggButton.setPosition(btnX, eggY);
    this.eggLabel.setPosition(btnX, eggY);
    this.interactButton.setPosition(btnX, interactY);
    this.interactLabel.setPosition(btnX, interactY);
  }

  updateTouchControls() {
    if (!this.isTouch) return;

    const node = this.nearestHarvestableNode();
    const nearNest = this.nearNestSite();
    const nextLevelConfig = BALANCE.nestLevels[this.nestLevel + 1];
    const interactUsable = !!node || (nearNest && !!nextLevelConfig && this.totalRocks() >= 0);
    this.setButtonEnabled(this.interactButton, this.interactLabel, interactUsable);

    const eggUsable = this.carrying
      ? this.nearVolcano() || (this.nestLevel >= 1 && nearNest)
      : this.nestLevel >= 1 && nearNest;
    this.setButtonEnabled(this.eggButton, this.eggLabel, eggUsable);
  }

  setButtonEnabled(button, label, enabled) {
    button.setAlpha(enabled ? 0.85 : 0.35);
    label.setAlpha(enabled ? 1 : 0.5);
  }

  // ---------- update ----------

  update(time, delta) {
    if (this.gameOver || this.gameWon) return;

    this.pollKeyboardMovement();
    this.consumeInputActions();

    if (this.mode === 'online') {
      // Only the locally-controlled role simulates its own movement; the
      // other role's container is positioned from network 'pos' messages
      // in applyRemotePos(). Both still need their HP bar redrawn each
      // frame since that's cosmetic, not authoritative state.
      if (this.onlineRole === 'guardian') {
        this.updatePlayerMovement(delta);
      } else {
        this.updateHumanRaider(delta);
      }
      this.updatePosBroadcast(time);
    } else if (this.mode === 'guardianRaider') {
      this.updatePlayerMovement(delta);
      this.updateHumanRaider(delta);
    } else {
      this.updatePlayerMovement(delta);
      this.updateRaiders(time, delta);
    }

    if (this.humanRaider) this.drawRaiderHpBar(this.humanRaider);

    this.updateNodesVisuals();
    this.updateTouchControls();
    this.updateHud(time);
  }

  // Moves a container+body pair by a normalized direction vector, flipping
  // on horizontal facing and switching walk/idle animation. Shared by the
  // Guardian (keyboard/touch input) and the human-controlled Raider.
  moveCharacter(container, body, moveX, moveY, speed, delta, currentFacing) {
    if (moveX !== 0 || moveY !== 0) {
      const dist = (speed * delta) / 1000;
      container.x = Phaser.Math.Clamp(container.x + moveX * dist, 20, WORLD.width - 20);
      container.y = Phaser.Math.Clamp(container.y + moveY * dist, 20, WORLD.height - 20);

      const facing = moveX !== 0 ? (moveX < 0 ? -1 : 1) : currentFacing;
      body.setFlipX(facing < 0);
      body.play('dragon-walk', true);
      return facing;
    }

    body.play('dragon-idle', true);
    return currentFacing;
  }

  updatePlayerMovement(delta) {
    const speed = BALANCE.playerSpeed * (this.carrying ? BALANCE.carrySpeedMultiplier : 1);
    this.playerFacing = this.moveCharacter(
      this.playerContainer,
      this.playerBody,
      this.inputState.moveX,
      this.inputState.moveY,
      speed,
      delta,
      this.playerFacing
    );
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

  showAttackSwing(x, y, color) {
    const ring = this.add.circle(x, y, BALANCE.attack.range, color, 0.25);
    this.tweens.add({
      targets: ring,
      alpha: 0,
      scale: 1.3,
      duration: 220,
      onComplete: () => ring.destroy(),
    });
  }

  handleAttack() {
    if (this.gameOver || this.gameWon) return;
    if (this.time.now - this.lastAttackTime < BALANCE.attack.cooldownMs) return;
    this.lastAttackTime = this.time.now;

    this.showAttackSwing(this.playerContainer.x, this.playerContainer.y, 0xfef08a);

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

    if (raider.isHuman) {
      raider.container.setVisible(false);
      raider.hpBarGfx.clear();
      this.time.delayedCall(BALANCE.raiderPvp.respawnMs, () => this.respawnHumanRaider(raider));
      return;
    }

    raider.container.destroy();
    raider.hpBarGfx.destroy();
  }

  respawnHumanRaider(raider) {
    if (this.gameOver || this.gameWon) return;
    const { x, y } = this.randomEdgePoint();
    raider.container.setPosition(x, y).setVisible(true);
    raider.hp = raider.maxHp;
    raider.dead = false;
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

      this.drawRaiderHpBar(raider);
    }

    if (this.raiders.length > 40) {
      this.raiders = this.raiders.filter((r) => !r.dead);
    }
  }

  drawRaiderHpBar(raider) {
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

  // ---------- human-controlled raider (2-player mode) ----------

  spawnHumanRaider(initial) {
    const { x, y } = this.randomEdgePoint();
    const hp = initial ? initial.raiderHp : BALANCE.raiderPvp.hp;
    const maxHp = initial ? initial.raiderMaxHp : BALANCE.raiderPvp.hp;
    const dead = initial ? initial.raiderDead : false;

    const body = this.add
      .sprite(0, 6, 'dragon_walk_01')
      .setScale(SPRITE_SCALE.raider)
      .setOrigin(0.5, 0.75)
      .setTint(0xdc2626);
    body.play('dragon-idle');
    const container = this.add.container(x, y, [body]).setVisible(!dead);
    const hpBarGfx = this.add.graphics();

    this.humanRaider = {
      container,
      body,
      hpBarGfx,
      hp,
      maxHp,
      speed: BALANCE.raiderPvp.speed,
      facing: 1,
      attackElapsed: 0,
      lastAttackTime: -Infinity,
      dead,
      isHuman: true,
    };
    this.raiders.push(this.humanRaider);
  }

  updateHumanRaider(delta) {
    const raider = this.humanRaider;
    if (!raider || raider.dead) return;

    raider.facing = this.moveCharacter(
      raider.container,
      raider.body,
      this.raiderInputState.moveX,
      this.raiderInputState.moveY,
      raider.speed,
      delta,
      raider.facing
    );
  }

  handleRaiderAttack() {
    const raider = this.humanRaider;
    if (!raider || raider.dead || this.gameOver || this.gameWon) return;
    if (this.time.now - raider.lastAttackTime < BALANCE.attack.cooldownMs) return;
    raider.lastAttackTime = this.time.now;

    this.showAttackSwing(raider.container.x, raider.container.y, 0xef4444);

    const eggPos = this.eggWorldPosition();
    const d = Phaser.Math.Distance.Between(raider.container.x, raider.container.y, eggPos.x, eggPos.y);
    if (d > BALANCE.attack.range) return;

    const nestDefense = BALANCE.nestLevels[this.nestLevel] ? BALANCE.nestLevels[this.nestLevel].defenseMultiplier : 1;
    const multiplier = this.carrying ? 1 : nestDefense;
    this.damageEgg(BALANCE.raiderPvp.eggDamage * multiplier);
  }

  damageEgg(amount) {
    this.eggHp = Phaser.Math.Clamp(this.eggHp - amount, 0, this.eggMaxHp);
    if (this.eggHp <= 0) {
      this.loseGame();
    }
  }

  // ---------- HUD update ----------

  updateHud(time) {
    if (this.compactHud) {
      this.resourceText.setText(`\u{1F525}${this.inventory.ember}  ❄${this.inventory.frost}  ⚡${this.inventory.storm}`);
    } else {
      this.resourceText.setText(
        [
          `Ember: ${this.inventory.ember}  (total ${this.totalCollected.ember})`,
          `Frost: ${this.inventory.frost}  (total ${this.totalCollected.frost})`,
          `Storm: ${this.inventory.storm}  (total ${this.totalCollected.storm})`,
        ].join('\n')
      );
    }

    const nestLabel = this.nestLevel === 0 ? 'not built' : `level ${this.nestLevel}`;
    this.nestText.setText(`Nest: ${nestLabel}\nEgg status: ${this.carrying ? 'carried' : 'in nest'}`);

    this.tierText.setText(`Raid tier: ${this.difficultyTier + 1}\nDefeated: ${this.raidersDefeated}`);

    const hpRatio = Phaser.Math.Clamp(this.eggHp / this.eggMaxHp, 0, 1);
    this.eggHpBarFill.width = this.eggHpBarMaxWidth * hpRatio;
    this.eggHpBarFill.setFillStyle(hpRatio > 0.5 ? 0x4ade80 : hpRatio > 0.25 ? 0xfacc15 : 0xef4444);
    this.eggHpLabel.setText(`Egg HP ${Math.ceil(this.eggHp)}/${this.eggMaxHp}`);

    if (this.eggShape.visible) {
      const ratio = Phaser.Math.Clamp(this.eggHp / this.eggMaxHp, 0, 1);
      this.eggNestHpBarFill.width = 70 * ratio;
      this.eggNestHpBarFill.setFillStyle(ratio > 0.5 ? 0x4ade80 : ratio > 0.25 ? 0xfacc15 : 0xef4444);
    }

    if (this.compactHud) {
      const activeText = time < this.transientMessageUntil ? this.transientMessage : this.computePrompt();
      this.promptText.setText(activeText);
      this.fitPanelToText(this.promptPanelBg, this.promptText, 24, 14);
      this.messageText.setText('');
      this.messagePanelBg.setVisible(false);
    } else {
      this.promptText.setText(this.computePrompt());
      this.fitPanelToText(this.promptPanelBg, this.promptText, 24, 14);

      if (time < this.transientMessageUntil) {
        this.messageText.setText(this.transientMessage);
      } else {
        this.messageText.setText('');
      }
      this.fitPanelToText(this.messagePanelBg, this.messageText, 24, 12);
    }
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
    if (this.mode === 'online' && this.onlineRole === 'raider') {
      return this.computeRaiderPrompt();
    }

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

  computeRaiderPrompt() {
    if (!this.humanRaider || this.humanRaider.dead) return 'Respawning...';
    const eggPos = this.eggWorldPosition();
    const d = Phaser.Math.Distance.Between(this.humanRaider.container.x, this.humanRaider.container.y, eggPos.x, eggPos.y);
    return d <= BALANCE.attack.range ? '[SPACE] Attack the egg!' : '';
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
