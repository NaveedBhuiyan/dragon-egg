import { WebSocket as ReconnectingWebSocket } from 'partysocket';

const PRODUCTION_HOST = 'nestward.lamias-game-idea.workers.dev';

export const SERVER_HOST = import.meta.env.DEV ? 'localhost:8787' : PRODUCTION_HOST;

// The Claude Artifact sandbox's CSP blocks WebSocket connections outright —
// but that failure only ever surfaces asynchronously (a silently-blocked
// connect attempt, not a thrown error), so it can't be feature-detected by
// just trying to open a socket. Artifacts are always served from claude.ai
// domains, so check the hostname instead.
export function isOnlinePlaySupported() {
  if (typeof window === 'undefined') return true;
  return !window.location.hostname.endsWith('claude.ai');
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export function connectToRoom(room, handlers) {
  const protocol = import.meta.env.DEV ? 'ws' : 'wss';
  const url = `${protocol}://${SERVER_HOST}/room/${room.toLowerCase()}`;
  const socket = new ReconnectingWebSocket(url);

  socket.addEventListener('open', () => handlers.onOpen?.());
  socket.addEventListener('close', () => handlers.onClose?.());
  socket.addEventListener('error', (event) => handlers.onError?.(event));
  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handlers.onMessage?.(msg);
  });

  return socket;
}

export function sendMessage(socket, msg) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}
