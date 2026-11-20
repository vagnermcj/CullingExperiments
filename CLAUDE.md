# CLAUDE.md

## What this project is

A WebGPU test bed for **GPU-driven culling** on a real industrial CAD model (the P-75 `envmesh` dataset, ~499 M triangles in ~1.47 M octree cells, streamed as an HLOD hierarchy). The goal is to study and benchmark two techniques:

1. **GPU-driven frustum culling**: a compute shader tests every resident cell's bounding box against the six frustum planes and writes the `instanceCount` of its indirect draw arguments. The CPU never reads visibility back.
2. **Two-pass occlusion culling (GPU driven, Hi-Z)**: the cells visible last frame are drawn first, a hierarchical depth buffer (Hi-Z / depth pyramid) is built from that depth, and then everything else is tested against the pyramid; the newly visible cells are drawn in a second pass. This avoids the one-frame lag of reprojection-based schemes and needs no CPU readback.

Stack: Vite + TypeScript, raw WebGPU API and WGSL shaders. three.js is used only for math, cameras and fly controls (no three.js renderer, no TSL / node materials). React + leva for the UI.

See `README.md` for the full description of loading, HLOD selection, the GPU frustum culling pipeline and the benchmark.

## Layout

- `src/cad/`: hierarchy, HLOD selection, streaming, worker decoding, CPU culling hooks (`cullingHooks.ts`, also holds `cullingConfig.mode`).
- `src/gpu/`: renderer, cell slots and buffers, frustum plane extraction, shaders (`cull.wgsl`, `render.wgsl`, `overlay.wgsl`), and the depth pyramid plumbing (`depthPyramid.ts`, with the reduction in `hiz.wgsl` and a debug view in `hizDebug.wgsl`).
- `src/benchmark/`: camera path, runner, results UI, saved runs (localStorage).
- `public/data/cad/`: the dataset (git-ignored, multi-GB).

## Focus: learning

This is a learning project. The user is studying these culling techniques, and the point is for them to understand and implement each one themselves, not to reach a finished renderer quickly. Favour explanations, references and pointers over ready-made solutions: when asked about a technique, explain the idea, the trade-offs and where it plugs into the code, and leave the implementation to the user unless they explicitly ask for code.

Status: GPU frustum culling is done. **What remains is the two-pass Hi-Z occlusion culling.**

### Output style: Learning

Work in the **Learning** output style:

- **Claude implements the less important parts**: the plumbing around the technique, such as textures and views, buffers, bind group layouts, pipeline creation, dispatch and pass encoding, UI toggles, stats counters and benchmark hooks.
- **Claude leaves the core of the technique to the user**, marked in the code with a `TODO(human)` comment at the exact spot, saying what the piece must do, its inputs and outputs, and the constraints (e.g. conservative min/max reduction, which mip to sample). Code around the marker should compile and run (a stub that keeps the current behaviour, e.g. "everything visible").
- The core pieces of occlusion culling that belong to the user: the depth pyramid reduction shader, projecting a cell's bounding box to screen space and choosing the mip level, the Hi-Z occlusion test itself, and the two-pass logic (which cells go to pass 1 vs. pass 2, and how the visibility of the previous frame is updated).
- **Every part comes with its references**: when introducing or explaining a piece, point to the specific section, slide or article that covers it (see _References_ below), plus a short explanation of the idea and the trade-offs.

## Working rules

- **The user writes the culling techniques by hand, to learn them.** Follow the Learning output style above: Claude may build the infrastructure around occlusion culling, but not the core pieces listed there, unless explicitly asked for that specific piece. Loading, HLOD, environment, tooling and benchmark work is fine. When unsure whether something is "the technique" or "the environment", ask.
- The occlusion extension point is already marked in `cull.wgsl` (reserved `FLAG_OCCLUSION` bit, a spot after the frustum test). The main pass renders to a `depth32float` texture with `TEXTURE_BINDING` usage and no MSAA, so a depth pyramid can be built from it.
- Culled cells are simply not drawn, everywhere (main view and minimap). No tinted or debug-coloured "culled" geometry.
- Code, comments and UI text are in English. Chat with the user in Portuguese.

## Testing

- **Do not run visual tests** (opening the app in a browser, screenshots, flying the camera, checking the rendered image). The user does those.
- **Only run the formatting / static checks** after a change:

```bash
npm run format:check
npm run lint
npx tsc --noEmit
```

Use `npm run format` / `npm run lint:fix` to fix what they report.

## References

Claude may look up further references when useful; add good ones here.

### Book

- Tomas Akenine-Möller, Eric Haines, Naty Hoffman et al., _Real-Time Rendering_, 4th edition (CRC Press, 2018). **Chapter 19, Acceleration Algorithms**, is the main textbook reference: 19.2 Culling Techniques, 19.4 View Frustum Culling, 19.7 Occlusion Culling (including Hierarchical Z-Buffering), 19.8 Culling Systems, 19.9 Level of Detail and 19.10 Rendering Large Scenes. Chapter 22 (Intersection Test Methods) covers the box/plane and box/frustum tests. Book site: https://www.realtimerendering.com/

### Two-pass occlusion culling

- Ulrich Haar and Sebastian Aaltonen, _GPU-Driven Rendering Pipelines_ (Assassin's Creed Unity, Ubisoft), Advances in Real-Time Rendering course, SIGGRAPH 2015. The origin of the two-pass occlusion culling scheme used here: https://advances.realtimerendering.com/s2015/
- Milosz Krupa, _Two-Pass Occlusion Culling_: https://medium.com/@mil_kru/two-pass-occlusion-culling-4100edcad501
- _Two-Pass Hierarchical Z-Buffer Occlusion Culling_: https://medium.com/@Lucmomber/two-pass-hierarchical-z-buffer-occlusion-culling-93171c5a9808
- Arseny Kapoulkine, _niagara_ (Vulkan renderer built on stream, with GPU frustum + two-pass Hi-Z occlusion culling and a depth pyramid; the code and the discussion on building the pyramid for non-power-of-two sizes are worth reading): https://github.com/zeux/niagara and https://github.com/zeux/niagara/discussions/15
- Graham Wihlidal, _Optimizing the Graphics Pipeline with Compute_, GDC 2016 (GPU cluster and triangle culling, Hi-Z tests in compute): https://www.slideshare.net/gwihlidal/optimizing-the-graphics-pipeline-with-compute-gdc-2016

### Hi-Z and GPU culling background

- Ned Greene, Michael Kass, Gavin Miller, _Hierarchical Z-Buffer Visibility_, SIGGRAPH 1993. The original Z-pyramid paper: https://www.cs.princeton.edu/courses/archive/spring01/cs598b/papers/greene93.pdf
- vkguide, _GPU Driven Rendering: Compute Culling_ (frustum + Hi-Z culling in a compute shader, single pass with last frame's depth, based on niagara): https://vkguide.dev/docs/gpudriven/compute_culling/
- Kirill Krupitskas, _Modern rendering culling techniques_ (overview of frustum, Hi-Z, one-pass vs two-pass): https://krupitskas.com/posts/modern_culling_techniques/
- NVIDIA nvpro-samples, _gl_occlusion_culling_ (batched GPU occlusion culling of all bounding boxes at once, with a temporal variant; also `gl_cadscene_rendertechniques` for CAD scenes): https://github.com/nvpro-samples/gl_occlusion_culling
