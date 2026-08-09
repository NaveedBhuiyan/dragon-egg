import { BALANCE } from '../src/gameConfig.js';
import {
  createInitialState,
  applyHarvest,
  applyBuild,
  applyEggPickup,
  applyEggPlace,
  applyEggDrop,
  applyGuardianAttack,
  applyRaiderAttack,
  respawnRaider,
} from '../src/net/simulation.js';

const ROLES = ['guardian', 'raider'];

export default class NestwardServer {
  constructor(room) {
    this.room = room;
    this.state = createInitialState();
    this.roleByConnection = new Map();
  }

  send(connection, msg) {
    connection.send(JSON.stringify(msg));
  }

  broadcastState() {
    this.room.broadcast(JSON.stringify({ type: 'stateUpdate', state: this.state }));
  }

  onConnect(connection) {
    const taken = new Set(this.roleByConnection.values());
    const role = ROLES.find((r) => !taken.has(r));

    if (!role) {
      this.send(connection, { type: 'full' });
      connection.close();
      return;
    }

    this.roleByConnection.set(connection.id, role);
    this.send(connection, { type: 'welcome', role, state: this.state });

    const peerRole = role === 'guardian' ? 'raider' : 'guardian';
    const peerConnected = [...this.roleByConnection.values()].includes(peerRole);
    if (peerConnected) {
      this.send(connection, { type: 'peerJoined', role: peerRole });
      this.room.broadcast(JSON.stringify({ type: 'peerJoined', role }), [connection.id]);
    }
  }

  onMessage(message, sender) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    const role = this.roleByConnection.get(sender.id);
    if (!role) return;

    if (msg.type === 'pos') {
      this.room.broadcast(
        JSON.stringify({
          type: 'pos',
          role,
          x: msg.x,
          y: msg.y,
          facing: msg.facing,
          moving: msg.moving,
          carrying: msg.carrying,
        }),
        [sender.id]
      );
      return;
    }

    if (msg.type === 'action') {
      this.handleAction(role, msg);
    }
  }

  handleAction(role, msg) {
    let result = { ok: false };

    if (role === 'guardian') {
      if (msg.kind === 'harvest') result = applyHarvest(this.state, msg);
      else if (msg.kind === 'build') result = applyBuild(this.state, msg);
      else if (msg.kind === 'eggPickup') result = applyEggPickup(this.state, msg);
      else if (msg.kind === 'eggPlace') result = applyEggPlace(this.state, msg);
      else if (msg.kind === 'eggDrop') result = applyEggDrop(this.state, msg);
      else if (msg.kind === 'guardianAttack') result = applyGuardianAttack(this.state, msg);
    } else if (role === 'raider') {
      if (msg.kind === 'raiderAttack') result = applyRaiderAttack(this.state, msg);
    }

    if (!result.ok) return;

    if (result.depleted) {
      const nodeId = result.nodeId;
      setTimeout(() => {
        const node = this.state.nodes.find((n) => n.id === nodeId);
        if (node) node.reserve = BALANCE.nodeReserve;
        this.broadcastState();
      }, BALANCE.nodeRespawnMs);
    }

    if (result.killed) {
      setTimeout(() => {
        respawnRaider(this.state);
        this.broadcastState();
      }, BALANCE.raiderPvp.respawnMs);
    }

    this.broadcastState();
  }

  onClose(connection) {
    const role = this.roleByConnection.get(connection.id);
    this.roleByConnection.delete(connection.id);
    if (role) {
      this.room.broadcast(JSON.stringify({ type: 'peerLeft', role }));
    }
  }
}
