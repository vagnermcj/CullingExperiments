// GPU culling: one thread per cell slot decides whether the cell is drawn this frame.

struct Params {
  planes: array<vec4f, 6>, // (nx, ny, nz, d), normals pointing into the frustum
  cellCount: u32,          // slots in use (high-water mark)
  flags: u32,              // bit 0: frustum test on, bit 1: occlusion test on
  near: f32,               // distance of the camera's near plane
  pad0: u32,
  viewProj: mat4x4f,       // world -> clip space of this frame's camera (depth 0 = near, 1 = far)
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> boxes: array<vec4f>;        // slot * 2 = min.xyz, slot * 2 + 1 = max.xyz
@group(0) @binding(2) var<storage, read> selected: array<u32>;       // 1 when the CPU selection wants the cell this frame
@group(0) @binding(3) var<storage, read_write> args: array<u32>;     // drawIndexedIndirect args, 5 u32 per slot
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>, 4>; // selected, visible, triangles, occluded
// Depth pyramid (Hi-Z): r32float, level 0 is half the depth buffer, each texel is the farthest depth of
// the pixels it covers. Not filterable: read it with textureLoad(pyramid, texel, level).r.
@group(0) @binding(5) var pyramid: texture_2d<f32>;

const FLAG_FRUSTUM = 1u;
const FLAG_OCCLUSION = 2u;

// True when the box is entirely behind at least one frustum plane.
fn outsideFrustum(center: vec3f, extent: vec3f) -> bool {
  for (var p = 0u; p < 6u; p++) {
    let plane = params.planes[p];
    // Signed distance of the box centre to the plane, and how far the box reaches along the plane normal.
    let distance = dot(plane.xyz, center) + plane.w;
    let reach = dot(abs(plane.xyz), extent);
    // Even the box corner that is deepest inside is still behind the plane.
    if (distance + reach < 0.0) {
      return true;
    }
  }
  return false;
}

// True when the box (world-space min / max corners) is certainly hidden behind the depth in the pyramid.
fn occluded(lo: vec3f, hi: vec3f) -> bool {
  // TODO(human): the Hi-Z occlusion test. Returning false means "not hidden, draw it".
  //
  // Step 1, project the box: build its 8 corners from `lo` / `hi`, multiply each by `params.viewProj`
  //   to get clip coordinates, divide by w to get NDC (x, y in -1..1, z in 0..1 with 0 = near).
  //   Keep the screen rectangle (min and max of x, y) and the nearest depth (smallest z) of the 8.
  //   If any corner has clip.w < params.near the box crosses the near plane and the divide is
  //   meaningless: return false (visible) right away.
  //
  // Step 2, to texture space and pick the level: NDC -> uv is uv = (x * 0.5 + 0.5, 0.5 - y * 0.5)
  //   (y flips: NDC points up, texel rows go down). Measure the rectangle in level-0 texels with
  //   `textureDimensions(pyramid, 0)` and pick the level where it is at most 1 texel wide and tall,
  //   so that it can touch at most 2x2 texels: ceil(log2(largest side)), clamped to
  //   0 .. textureNumLevels(pyramid) - 1.
  //
  // Step 3, compare: read the texels of that level under the rectangle's corners (up to 2x2, with
  //   coordinates clamped to `textureDimensions(pyramid, level) - 1`) and keep the farthest (max).
  //   The box is hidden only if its nearest depth is farther than that value.
  return false;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x;
  if (slot >= params.cellCount) {
    return;
  }

  let indexCount = args[slot * 5u];
  var visible = selected[slot] != 0u && indexCount > 0u;

  if (visible) {
    atomicAdd(&counters[0], 1u);
  }

  let lo = boxes[slot * 2u].xyz;
  let hi = boxes[slot * 2u + 1u].xyz;

  if (visible && (params.flags & FLAG_FRUSTUM) != 0u) {
    if (outsideFrustum((lo + hi) * 0.5, (hi - lo) * 0.5)) {
      visible = false;
    }
  }

  // After the frustum test, so boxes outside the view never reach the projection.
  if (visible && (params.flags & FLAG_OCCLUSION) != 0u) {
    if (occluded(lo, hi)) {
      visible = false;
      atomicAdd(&counters[3], 1u);
    }
  }

  // instanceCount is what turns the CPU-recorded draw into a real draw (1) or a no-op (0).
  args[slot * 5u + 1u] = select(0u, 1u, visible);

  if (visible) {
    atomicAdd(&counters[1], 1u);
    atomicAdd(&counters[2], indexCount / 3u);
  }
}
