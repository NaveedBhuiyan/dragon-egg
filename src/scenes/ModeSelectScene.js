import Phaser from 'phaser';

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
];

export default class ModeSelectScene extends Phaser.Scene {
  constructor() {
    super('ModeSelectScene');
  }

  create() {
    this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x12190f).setOrigin(0, 0).setScrollFactor(0);

    this.add
      .text(0, 0, 'Nestward', {
        fontFamily: 'monospace',
        fontSize: '36px',
        color: '#fef3c7',
      })
      .setOrigin(0.5)
      .setName('title');

    this.cards = OPTIONS.map((opt) => {
      const title = this.add
        .text(0, 0, opt.title, { fontFamily: 'monospace', fontSize: '20px', color: '#fde68a' })
        .setOrigin(0.5)
        .setDepth(1);
      const body = this.add
        .text(0, 0, opt.body, { fontFamily: 'monospace', fontSize: '14px', color: '#e5e7eb', align: 'center' })
        .setOrigin(0.5)
        .setDepth(1);

      return { opt, bg: null, title, body };
    });

    this.scale.on('resize', (gameSize) => this.layout(gameSize.width, gameSize.height));
    this.layout(this.scale.width, this.scale.height);
  }

  layout(width, height) {
    this.children.getByName('title')?.setPosition(width / 2, height * 0.2);

    const cardWidth = Math.min(420, width * 0.85);
    const cardHeight = 150;
    const gap = 24;
    const totalHeight = this.cards.length * cardHeight + (this.cards.length - 1) * gap;
    const startY = height / 2 - totalHeight / 2 + cardHeight / 2;

    this.cards.forEach((card, i) => {
      const y = startY + i * (cardHeight + gap);

      // Phaser Shape strokes don't follow a post-creation width/height
      // mutation (only the fill does), so recreate the background at the
      // right size on every layout pass instead of resizing it in place.
      card.bg?.destroy();
      const bg = this.add
        .rectangle(width / 2, y, cardWidth, cardHeight, 0x000000, 0.55)
        .setStrokeStyle(2, 0x8b5e3c, 0.8)
        .setInteractive();
      bg.on('pointerover', () => bg.setStrokeStyle(2, 0xfde68a, 1));
      bg.on('pointerout', () => bg.setStrokeStyle(2, 0x8b5e3c, 0.8));
      bg.on('pointerdown', () => this.scene.start('GameScene', { mode: card.opt.mode }));
      card.bg = bg;

      card.title.setPosition(width / 2, y - cardHeight / 2 + 30);
      card.body.setPosition(width / 2, y + 15);
    });
  }
}
