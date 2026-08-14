# tiles-viewer

A Vite + TypeScript viewer for 3D Tiles, built with Three.js.

## Requirements

- Node.js 18+ (Vite 8 requires Node 18 or 20)
- npm (bundled with Node.js)

## Install

```bash
npm install
```

## Run dev server

```bash
npm run dev
```

Vite will print a local URL (typically `http://localhost:5173`). Open it in a browser to view the tiles.

The default tileset is `/data/add_spheres/tileset.json`. To load a different tileset, either edit the URL widget in the page or pass it via a query parameter:

```
http://localhost:5173/?tileset=/path/to/your/tileset.json
```

## Other scripts

```bash
npm run build      # type-check and build for production
npm run preview    # preview the production build
npm run lint       # run eslint
npm run lint:fix   # run eslint with --fix
npm run format     # format with prettier
```
