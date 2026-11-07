// GPU frustum culling: one thread per cell slot decides whether the cell is drawn this frame.

struct Params {
  planes: array<vec4f, 6>, // (nx, ny, nz, d), normals pointing into the frustum
  cellCount: u32,          // slots in use (high-water mark)
  flags: u32,              // bit 0: frustum test on, bit 1: occlusion test on (reserved)
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> boxes: array<vec4f>;        // slot * 2 = min.xyz, slot * 2 + 1 = max.xyz
@group(0) @binding(2) var<storage, read> selected: array<u32>;       // 1 when the CPU selection wants the cell this frame
@group(0) @binding(3) var<storage, read_write> args: array<u32>;     // drawIndexedIndirect args, 5 u32 per slot
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>, 4>;

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

  if (visible && (params.flags & FLAG_FRUSTUM) != 0u) {
    let lo = boxes[slot * 2u].xyz;
    let hi = boxes[slot * 2u + 1u].xyz;
    if (outsideFrustum((lo + hi) * 0.5, (hi - lo) * 0.5)) {
      visible = false;
    }
  }

  // Occlusion culling plugs in here: `if (visible && (params.flags & FLAG_OCCLUSION) != 0u) { ... }`

  // instanceCount is what turns the CPU-recorded draw into a real draw (1) or a no-op (0).
  args[slot * 5u + 1u] = select(0u, 1u, visible);

  if (visible) {
    atomicAdd(&counters[1], 1u);
    atomicAdd(&counters[2], indexCount / 3u);
  }
}
