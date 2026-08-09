import Phaser from 'phaser';
import ModeSelectScene from './scenes/ModeSelectScene.js';
import GameScene from './scenes/GameScene.js';
import './style.css';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  backgroundColor: '#12190f',
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  input: {
    activePointers: 3,
  },
  scene: [ModeSelectScene, GameScene],
});
