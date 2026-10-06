# culling-experiments

A Vite + TypeScript test bed for frustum and occlusion culling experiments, built with Three.js (WebGPU).

The scene is a real industrial CAD model (an `envmesh` dataset, P-75: ~499 M triangles in ~1.47 M octree cells), streamed from `public/data/cad/` as an HLOD hierarchy. No culling technique is implemented on purpose: the selected HLOD is drawn as is, and the hooks for the techniques are marked below.

## Dataset

`public/data/cad/` is git-ignored (multi-GB) and removed from `dist/` on build. It must contain `metadata.json`, `hierarchy.bin`, `geometry.bin`, `geometry_lod.bin` and `geometry_lod2.bin`. The dev server must answer HTTP Range requests (Vite does). Only the `cell-chunks-v2.2-quantized` geometry format is supported; the PVS (`visibility.bin`) and chunked hierarchy files are not used.

## How the model is loaded (`src/cad/`)

- **Hierarchy** (`hierarchy.ts`): `hierarchy.bin` is downloaded whole (~100 MB) and kept as bytes, one 70-byte record per cell. The octree uses ADD refinement: a cell keeps drawing its own geometry while its children add detail.
- **LOD tiers**: every cell can ship `raw` (`geometry.bin`), `lod1` and `lod2` geometry. A tier a cell lacks falls back to the next finer one.
- **Selection** (`cadModel.ts`, `select()`): every frame a best-first traversal from the root, ordered by projected size, picks cells until the triangle budget is spent. Cells below the minimum size are not descended into. The tier comes from the projected size. A resident finer tier is kept rather than swapped for a coarser one.
- **Streaming**: selected cells that are not resident are fetched with HTTP Range requests (priority = projected size), decoded in workers (`cellDecode*.ts`) and added as one mesh per cell. Cells not selected for 2 s have their loads cancelled, and an LRU over the resident cap evicts the rest.
- **Culling hooks** (`cullingHooks.ts`): `beginFrame(camera)` runs once per selection pass and `isCellVisible(box)` is asked for every candidate cell. Both are pass-through. Returning `false` drops the cell and its whole subtree. Cell meshes have `frustumCulled = false`, so nothing but your hook culls.

The **CAD** folder in the controls panel sets the triangle budget, the minimum size, the tier thresholds, the resident cap and a *freeze selection* toggle (freeze, then fly around to inspect what was selected). The **HLOD** folder shows what the traversal selected, drew and loaded. The minimap is off by default because it renders the scene a second time.

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

Controls: drag to look, `WASD` to move (fly controls).

## Other scripts

```bash
npm run build      # type-check and build for production
npm run preview    # preview the production build
npm run lint       # run eslint
npm run lint:fix   # run eslint with --fix
npm run format     # format with prettier
```
