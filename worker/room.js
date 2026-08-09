// A plain Cloudflare Durable Object, one instance per room, handling both
// players' WebSocket connections directly. This mirrors party/index.js
// (the PartyKit version) almost exactly — same role assignment, same
// message protocol, same simulation module — but talks to the raw
// WebSocketPair API instead of PartyKit's Party.Server abstraction, since
// PartyKit's own hosted `*.partykit.dev` domain pool is currently full
// platform-wide. If that's ever resolved, party/index.js can be used
// instead without changing the client or the simulation rules at all.
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

export class NestwardRoom {
  constructor() {
    this.gameState = createInitialState();
    this.connections = new Map(); // WebSocket -> role
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade request', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(ws) {
    ws.accept();

    const taken = new Set(this.connections.values());
    const role = ROLES.find((r) => !taken.has(r));

    if (!role) {
      ws.send(JSON.stringify({ type: 'full' }));
      ws.close();
      return;
    }

    this.connections.set(ws, role);
    ws.send(JSON.stringify({ type: 'welcome', role, state: this.gameState }));

    const peerRole = role === 'guardian' ? 'raider' : 'guardian';
    if ([...this.connections.values()].includes(peerRole)) {
      ws.send(JSON.stringify({ type: 'peerJoined', role: peerRole }));
      this.broadcast({ type: 'peerJoined', role }, ws);
    }

    ws.addEventListener('message', (event) => this.handleMessage(ws, role, event.data));
    ws.addEventListener('close', () => this.handleClose(ws, role));
    ws.addEventListener('error', () => this.handleClose(ws, role));
  }

  broadcast(msg, exclude) {
    const data = JSON.stringify(msg);
    for (const ws of this.connections.keys()) {
      if (ws === exclude) continue;
      try {
        ws.send(data);
      } catch {
        // Connection is gone; its own close handler will clean it up.
      }
    }
  }

  broadcastState() {
    this.broadcast({ type: 'stateUpdate', state: this.gameState });
  }

  handleMessage(ws, role, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'pos') {
      this.broadcast(
        { type: 'pos', role, x: msg.x, y: msg.y, facing: msg.facing, moving: msg.moving },
        ws
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
      if (msg.kind === 'harvest') result = applyHarvest(this.gameState, msg);
      else if (msg.kind === 'build') result = applyBuild(this.gameState, msg);
      else if (msg.kind === 'eggPickup') result = applyEggPickup(this.gameState, msg);
      else if (msg.kind === 'eggPlace') result = applyEggPlace(this.gameState, msg);
      else if (msg.kind === 'eggDrop') result = applyEggDrop(this.gameState, msg);
      else if (msg.kind === 'guardianAttack') result = applyGuardianAttack(this.gameState, msg);
    } else if (role === 'raider') {
      if (msg.kind === 'raiderAttack') result = applyRaiderAttack(this.gameState, msg);
    }

    if (!result.ok) return;

    if (result.depleted) {
      const nodeId = result.nodeId;
      setTimeout(() => {
        const node = this.gameState.nodes.find((n) => n.id === nodeId);
        if (node) node.reserve = BALANCE.nodeReserve;
        this.broadcastState();
      }, BALANCE.nodeRespawnMs);
    }

    if (result.killed) {
      setTimeout(() => {
        respawnRaider(this.gameState);
        this.broadcastState();
      }, BALANCE.raiderPvp.respawnMs);
    }

    this.broadcastState();
  }

  handleClose(ws, role) {
    this.connections.delete(ws);
    this.broadcast({ type: 'peerLeft', role });
  }
}
