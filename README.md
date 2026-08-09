# dragon-egg

**Nestward** — a top-down browser game. Collect elemental rocks, build and defend a nest against raiders, then carry your egg into a volcano to hatch a dragon.

Play it live: https://naveedbhuiyan.github.io/dragon-egg/

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Builds a single self-contained `dist/index.html` (Phaser + all sprites inlined). The `docs/` folder holds a copy of the latest build and is what GitHub Pages serves — after building, copy the result over:

```bash
cp dist/index.html docs/index.html
```
