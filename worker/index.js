export { NestwardRoom } from './room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([a-zA-Z0-9]+)$/);
    if (!match) {
      return new Response('Not found', { status: 404 });
    }

    const roomCode = match[1].toLowerCase();
    const id = env.NESTWARD_ROOM.idFromName(roomCode);
    const stub = env.NESTWARD_ROOM.get(id);
    return stub.fetch(request);
  },
};
