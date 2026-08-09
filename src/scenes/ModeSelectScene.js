import Phaser from 'phaser';
import { connectToRoom, generateRoomCode, isOnlinePlaySupported } from '../net/client.js';

const OPTIONS = [
  {
    mode: 'solo',
    title: 'Solo vs AI',
    body: 'Defend your nest against waves of AI raiders on your own.',
  },
  {
    mode: 'guardianRaider',
    title: '2-Player: Guardian vs Raider (local test)',
    body: 'One nest, two roles, one keyboard.\nGuardian: WASD move, SPACE attack, E interact, Q egg.\nRaider: Arrow keys move, ENTER attack.',
  },
  {
    mode: 'online',
    title: '2-Player Online',
    body: 'Play with a friend on another device — host a room or join with a code.',
  },
];

export default class ModeSelectScene extends Phaser.Scene {
  constructor() {
    super('ModeSelectScene');
  }

  create() {
    this.uiState = 'menu';
    this.dynamicObjects = [];
    this.roomCodeInput = null;

    this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x12190f).setOrigin(0, 0).setScrollFactor(0);

    this.add
      .text(0, 0, 'Nestward', {
        fontFamily: 'monospace',
        fontSize: '36px',
        color: '#fef3c7',
      })
      .setOrigin(0.5)
      .setName('title');

    this.cards = OPTIONS.map((opt) => ({ opt, bg: null, title: null, body: null }));

    this.scale.on('resize', (gameSize) => this.render());
    this.events.once('shutdown', () => this.removeRoomCodeInput());

    this.render();
  }

  // ---------- state transitions ----------

  goToMenu() {
    this.uiState = 'menu';
    this.render();
  }

  goToOnlineChoice() {
    this.uiState = 'onlineChoice';
    this.render();
  }

  goToJoinInput() {
    this.uiState = 'joinInput';
    this.render();
  }

  hostGame() {
    this.connect(generateRoomCode());
  }

  joinGame() {
    const code = (this.roomCodeInput?.value || '').trim();
    if (code.length === 0) return;
    this.connect(code);
  }

  connect(code) {
    this.uiState = 'connecting';
    this.connectingCode = code;
    this.connectStatus = 'Connecting...';
    this.render();

    this.socket = connectToRoom(code, {
      onOpen: () => {
        this.connectStatus = 'Connected, waiting for server...';
        this.render();
      },
      onError: () => {
        this.connectStatus = 'Connection failed. Check your internet and try again.';
        this.render();
      },
      onClose: () => {
        if (this.uiState === 'connecting') {
          this.connectStatus = 'Connection closed unexpectedly.';
          this.render();
        }
      },
      onMessage: (msg) => {
        if (msg.type === 'welcome') {
          this.scene.start('GameScene', {
            mode: 'online',
            role: msg.role,
            initialState: msg.state,
            socket: this.socket,
            roomCode: code,
          });
        } else if (msg.type === 'full') {
          this.connectStatus = 'That room already has two players.';
          this.socket.close();
          this.render();
        }
      },
    });
  }

  // ---------- rendering ----------

  clearDynamic() {
    for (const obj of this.dynamicObjects) obj.destroy();
    this.dynamicObjects = [];
    for (const card of this.cards) {
      card.bg = null;
      card.title = null;
      card.body = null;
    }
  }

  render() {
    this.clearDynamic();
    if (this.uiState !== 'joinInput') this.removeRoomCodeInput();

    const { width, height } = this.scale;
    this.children.getByName('title')?.setPosition(width / 2, height * 0.14);

    if (this.uiState === 'menu') this.renderMenu(width, height);
    else if (this.uiState === 'onlineChoice') this.renderOnlineChoice(width, height);
    else if (this.uiState === 'joinInput') this.renderJoinInput(width, height);
    else if (this.uiState === 'connecting') this.renderConnecting(width, height);
  }

  addText(x, y, text, style) {
    const obj = this.add.text(x, y, text, style).setOrigin(0.5);
    this.dynamicObjects.push(obj);
    return obj;
  }

  addButton(x, y, w, h, label, onClick, color = 0x8b5e3c) {
    const bg = this.add.rectangle(x, y, w, h, 0x000000, 0.55).setStrokeStyle(2, color, 0.8).setInteractive();
    bg.on('pointerover', () => bg.setStrokeStyle(2, 0xfde68a, 1));
    bg.on('pointerout', () => bg.setStrokeStyle(2, color, 0.8));
    bg.on('pointerdown', onClick);
    const label_ = this.addText(x, y, label, { fontFamily: 'monospace', fontSize: '18px', color: '#fde68a' });
    this.dynamicObjects.push(bg);
    return { bg, label: label_ };
  }

  renderMenu(width, height) {
    const onlineSupported = isOnlinePlaySupported();
    const cardWidth = Math.min(420, width * 0.85);
    const cardHeight = 140;
    const gap = 20;
    const totalHeight = this.cards.length * cardHeight + (this.cards.length - 1) * gap;
    const startY = height / 2 - totalHeight / 2 + cardHeight / 2 + 20;

    this.cards.forEach((card, i) => {
      const y = startY + i * (cardHeight + gap);
      const disabled = card.opt.mode === 'online' && !onlineSupported;
      const strokeColor = disabled ? 0x4b5563 : 0x8b5e3c;

      const bg = this.add
        .rectangle(width / 2, y, cardWidth, cardHeight, 0x000000, disabled ? 0.35 : 0.55)
        .setStrokeStyle(2, strokeColor, disabled ? 0.5 : 0.8);
      if (!disabled) {
        bg.setInteractive();
        bg.on('pointerover', () => bg.setStrokeStyle(2, 0xfde68a, 1));
        bg.on('pointerout', () => bg.setStrokeStyle(2, strokeColor, 0.8));
        bg.on('pointerdown', () => {
          if (card.opt.mode === 'online') this.goToOnlineChoice();
          else this.scene.start('GameScene', { mode: card.opt.mode });
        });
      }
      this.dynamicObjects.push(bg);

      const title = this.addText(width / 2, y - cardHeight / 2 + 26, card.opt.title, {
        fontFamily: 'monospace',
        fontSize: '19px',
        color: disabled ? '#9ca3af' : '#fde68a',
      });
      const bodyText = disabled
        ? "Not available here — this page's sandbox blocks the network connection online play needs. Open this game's GitHub Pages link instead."
        : card.opt.body;
      const body = this.addText(width / 2, y + 14, bodyText, {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: disabled ? '#6b7280' : '#e5e7eb',
        align: 'center',
        wordWrap: { width: cardWidth - 40 },
      });

      card.bg = bg;
      card.title = title;
      card.body = body;
    });
  }

  renderOnlineChoice(width, height) {
    this.addText(width / 2, height * 0.32, '2-Player Online', { fontFamily: 'monospace', fontSize: '24px', color: '#fde68a' });
    this.addText(
      width / 2,
      height * 0.4,
      'One player hosts, the other joins with the room code.',
      { fontFamily: 'monospace', fontSize: '14px', color: '#e5e7eb' }
    );

    this.addButton(width / 2, height * 0.52, 280, 60, 'Host New Game', () => this.hostGame());
    this.addButton(width / 2, height * 0.62, 280, 60, 'Join With Code', () => this.goToJoinInput());
    this.addButton(width / 2, height * 0.75, 160, 44, '< Back', () => this.goToMenu(), 0x6b7280);
  }

  renderJoinInput(width, height) {
    this.addText(width / 2, height * 0.32, 'Enter Room Code', { fontFamily: 'monospace', fontSize: '24px', color: '#fde68a' });

    this.ensureRoomCodeInput(width, height);

    this.addButton(width / 2, height * 0.56, 200, 56, 'Connect', () => this.joinGame());
    this.addButton(width / 2, height * 0.68, 160, 44, '< Back', () => this.goToOnlineChoice(), 0x6b7280);
  }

  renderConnecting(width, height) {
    this.addText(width / 2, height * 0.4, `Room: ${this.connectingCode}`, { fontFamily: 'monospace', fontSize: '22px', color: '#fde68a' });
    this.addText(width / 2, height * 0.48, this.connectStatus, {
      fontFamily: 'monospace',
      fontSize: '15px',
      color: '#e5e7eb',
      align: 'center',
      wordWrap: { width: width * 0.8 },
    });
    this.addButton(
      width / 2,
      height * 0.6,
      160,
      44,
      'Cancel',
      () => {
        this.socket?.close();
        this.goToOnlineChoice();
      },
      0x6b7280
    );
  }

  // ---------- DOM room-code input ----------

  ensureRoomCodeInput(width, height) {
    if (!this.roomCodeInput) {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 4;
      input.placeholder = 'ABCD';
      input.autocapitalize = 'characters';
      input.autocomplete = 'off';
      input.style.position = 'fixed';
      input.style.fontFamily = 'monospace';
      input.style.fontSize = '28px';
      input.style.letterSpacing = '6px';
      input.style.textAlign = 'center';
      input.style.textTransform = 'uppercase';
      input.style.width = '160px';
      input.style.padding = '8px';
      input.style.borderRadius = '4px';
      input.style.border = '2px solid #8b5e3c';
      input.style.background = '#0b0f0a';
      input.style.color = '#fde68a';
      input.style.touchAction = 'manipulation';
      input.style.userSelect = 'text';
      input.style.zIndex = '10';
      input.addEventListener('input', () => {
        input.value = input.value.toUpperCase().slice(0, 4);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.joinGame();
      });
      document.body.appendChild(input);
      this.roomCodeInput = input;
    }
    this.roomCodeInput.style.left = `${width / 2 - 80}px`;
    this.roomCodeInput.style.top = `${height * 0.44 - 24}px`;
    this.roomCodeInput.focus();
  }

  removeRoomCodeInput() {
    if (this.roomCodeInput) {
      this.roomCodeInput.remove();
      this.roomCodeInput = null;
    }
  }
}
