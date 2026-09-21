# culling-experiments

A Vite + TypeScript test bed for frustum and occlusion culling experiments, built with Three.js (WebGPU).

The scene is a ground plane with a configurable number of trees spread uniformly (from `public/data/tree.glb`) and a few walls near the camera start, which will act as occluders.

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

Vite will print a local URL (typically `http://localhost:5173`). Open it in a browser.

Use the **Forest** folder in the controls panel to change the number of trees and to toggle the walls. The placement is deterministic, so the same tree count always produces the same forest. If `public/data/tree.glb` is missing, a simple placeholder tree is used.

## Other scripts

```bash
npm run build      # type-check and build for production
npm run preview    # preview the production build
npm run lint       # run eslint
npm run lint:fix   # run eslint with --fix
npm run format     # format with prettier
```
