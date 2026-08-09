# dragon-egg

**Nestward** — a top-down browser game. Collect elemental rocks, build and defend a nest against raiders, then carry your egg into a volcano to hatch a dragon. Play solo against AI, or online 1v1 as the Guardian vs. a human-controlled Raider.

Play it live: https://naveedbhuiyan.github.io/dragon-egg/

## Development

Two dev servers run side by side — Vite for the game client, Wrangler for the local multiplayer server (used automatically by the client whenever `import.meta.env.DEV` is true):

```bash
npm install
npm run dev          # game client, http://localhost:5173
npm run dev:server   # multiplayer server, ws://localhost:8787
```

Solo play and the local 2-player test mode (one keyboard, two roles) don't need the server running at all — only "2-Player Online" does.

## Build (game client)

```bash
npm run build
```

Builds a single self-contained `dist/index.html` (Phaser + all sprites inlined). The `docs/` folder holds a copy of the latest build and is what GitHub Pages serves — after building, copy the result over:

```bash
cp dist/index.html docs/index.html
```

## Multiplayer server

The authoritative game-state server for "2-Player Online" is a Cloudflare Worker + Durable Object (`worker/`), sharing its game rules with the client via `src/net/simulation.js`. Deploy it with:

```bash
npm run deploy:server
```

If you redeploy under a different Worker/account name, update `PRODUCTION_HOST` in `src/net/client.js` to match, then rebuild and redeploy the client.

There's also an equivalent PartyKit implementation in `party/` + `partykit.json` (`npx partykit dev` / `npx partykit deploy`) — unused for now because PartyKit's shared `*.partykit.dev` hosting hit its platform-wide domain limit at the time this was built. If that's resolved later, switching back only means changing the client's connection URL; the game rules (`src/net/simulation.js`) are shared by both server implementations.

Online play doesn't work from the Claude Artifact build — its sandbox blocks WebSocket connections outright — so the mode is automatically disabled there, pointing players to the GitHub Pages link instead.
