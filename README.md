# culling-experiments

A Vite + TypeScript test bed for frustum and occlusion culling experiments, rendered with raw WebGPU and WGSL (three.js is only used for math, cameras and fly controls).

The scene is a real industrial CAD model (an `envmesh` dataset, P-75: ~499 M triangles in ~1.47 M octree cells), streamed from `public/data/cad/` as an HLOD hierarchy. The frustum culling runs on the GPU (see below); occlusion culling is left to implement, with its extension point marked.

## Dataset

`public/data/cad/` is git-ignored (multi-GB) and removed from `dist/` on build. It must contain `metadata.json`, `hierarchy.bin`, `geometry.bin`, `geometry_lod.bin` and `geometry_lod2.bin`. The dev server must answer HTTP Range requests (Vite does). Only the `cell-chunks-v2.2-quantized` geometry format is supported; the PVS (`visibility.bin`) and chunked hierarchy files are not used.

## How the model is loaded (`src/cad/`)

- **Hierarchy** (`hierarchy.ts`): `hierarchy.bin` is downloaded whole (~100 MB) and kept as bytes, one 70-byte record per cell. The octree uses ADD refinement: a cell keeps drawing its own geometry while its children add detail.
- **LOD tiers**: every cell can ship `raw` (`geometry.bin`), `lod1` and `lod2` geometry. A tier a cell lacks falls back to the next finer one.
- **Selection** (`cadModel.ts`, `select()`): every frame a best-first traversal from the root, ordered by projected size, picks cells until the triangle budget is spent. Cells below the minimum size are not descended into. The tier comes from the projected size. A resident finer tier is kept rather than swapped for a coarser one.
- **Streaming**: selected cells that are not resident are fetched with HTTP Range requests (priority = projected size), decoded in workers (`cellDecode*.ts`) and uploaded to the GPU as one set of buffers per cell (the decoded arrays are not kept on the CPU). Cells not selected for 2 s have their loads cancelled, and an LRU over the resident cap evicts the rest.
- **CPU culling hooks** (`cullingHooks.ts`): `beginFrame(camera)` runs once per selection pass and `isCellVisible(box)` is asked for every candidate cell. Both are pass-through. Returning `false` drops the cell and its whole subtree, which also frees its share of the triangle budget. The GPU culling below is separate and does not use them.

The **CAD** folder in the controls panel sets the triangle budget, the minimum size, the tier thresholds, the resident cap and a *freeze selection* toggle (freeze, then fly around to inspect what was selected). The **HLOD** folder shows what the traversal selected, drew and loaded. The minimap is off by default because it draws the scene a second time.

## GPU-driven frustum culling (`src/gpu/`)

The CPU still chooses *what to load* (the HLOD selection above, which has no frustum test, so it also selects cells outside the view). Every frame the GPU then decides *which of the selected cells are drawn*: the CPU records one indirect draw per resident cell and never reads a visibility result back.

```
CPU   camera -> cad.update() (selection flags) -> frustum planes -> uniforms
GPU   1. clear the counters
      2. cull.wgsl compute: one thread per cell slot writes instanceCount = 0 or 1 into the cell's draw arguments
      3. render pass: for every resident cell, drawIndexedIndirect(args, slot * 20)   (instanceCount 0 draws nothing)
      4. optional minimap pass: same arguments, seen from above, with the culling frustum outlined
      5. counters and timestamps are copied to a staging ring and read back a frame or two later
```

- **Files:** `renderer.ts` (device, pipelines, the frame above), `cellStore.ts` (slots and the buffers below), `frustum.ts` (plane extraction), `shaders/cull.wgsl`, `shaders/render.wgsl`, `shaders/overlay.wgsl`.
- **Per-slot buffers:** `boxes` (min/max of the cell's own geometry, 2 x `vec4f`), `selected` (`u32`, written by the CPU each frame), `args` (5 x `u32` in `drawIndexedIndirect` layout; the CPU writes `indexCount`, the compute shader writes `instanceCount`), plus 4 atomic `counters` (selected, visible, visible triangles).
- **The test:** `frustum.ts` extracts the six planes from the view-projection matrix (Gribb and Hartmann; WebGPU depth range is 0..1, so the near plane is row 2). `cull.wgsl` tests the box by centre and extent: it is outside when, for some plane, `dot(n, centre) + d + dot(abs(n), extent) < 0`.
- **Scenarios:** `cullingConfig.mode` turns the frustum test on for `frustum` and `frustum+occlusion`. Because the selection is the same either way, the image is identical with and without culling; only the cost changes.
- **Where occlusion goes:** `cull.wgsl` has a reserved flag bit (`FLAG_OCCLUSION`) and a marked spot after the frustum test. The main pass already renders to a `depth32float` texture with `TEXTURE_BINDING` usage and without MSAA, so a depth pyramid can be built from it.
- **Debugging:** the **Culling** folder has *freeze culling frustum*: culling keeps using the frustum of the moment you ticked it while the camera moves, so you can fly out and see what was cut. With the minimap on, you see the cut from above: it is drawn with the same culling results, so cells outside the yellow outline (the culling frustum) disappear. The **Culling** folder shows whether the frustum test is on; the technique itself is picked in the Benchmark panel, and `No technique` leaves culling off. The **Main view** folder shows draws visible/issued, the percentage culled and the GPU time of the culling pass.
- **Not done yet:** one draw per cell is encoded on the CPU (no multi-draw-indirect in WebGPU), geometry is per-cell buffers rather than one shared arena, and the test is flat over the resident cells rather than hierarchical.

## Benchmark (`src/benchmark/`)

A game-style benchmark: pick a technique and a duration in the **Benchmark** panel (top right) and press **Play**. The camera then flies a fixed closed loop around and through the model (`cameraPath.ts`, edit its waypoints to change what is measured) while the panel shows live numbers; **Esc** cancels and puts the camera back.

- **Phases:** an optional warm-up lap (the same loop at 3x speed, so the recorded lap measures rendering rather than streaming), a short wait until the loads settle, then the recorded lap. The path is driven by time, so every run sees the same poses.
- **Results:** average FPS, 1% / 0.1% lows, frame-time percentiles, GPU time, CPU update/render time, triangles, draw calls, selected cells and resident memory, plus a chart of any of them over the run (including the GPU time of the culling pass). **Save** keeps the run (name it first), **Discard** throws it away.
- **History:** every saved run is kept in the browser's `localStorage` (about 40 KB each), with the GPU, resolution and CAD settings it was measured with. Filter by technique or GPU, tick runs to overlay them on one chart, open one for its details, or delete it.
- **GPU time** comes from WebGPU timestamp queries, so it is not capped by vsync like FPS is. It shows `n/a` where the browser does not support `timestamp-query`.
- **Techniques:** the four scenarios (no technique, frustum, occlusion, frustum + occlusion) set `cullingConfig.mode` in `src/cad/cullingHooks.ts`. The frustum scenarios run the GPU frustum test; the occlusion part is not implemented yet, so `occlusion` behaves like `no technique` and `frustum+occlusion` like `frustum`. During a run the controls panel and minimap are hidden.

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
