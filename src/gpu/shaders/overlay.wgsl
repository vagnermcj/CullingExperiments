struct Frame {
  viewProj: mat4x4f,
  sunDir: vec4f,
  sunColor: vec4f,
  skyColor: vec4f,
  groundColor: vec4f,
  background: vec4f,
}

@group(0) @binding(0) var<uniform> frame: Frame;

// One triangle that covers the whole viewport; used to paint the minimap background.
@vertex
fn bgVs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

@fragment
fn bgFs() -> @location(0) vec4f {
  return vec4f(frame.background.rgb * 0.55, 1.0);
}

@vertex
fn lineVs(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return frame.viewProj * vec4f(position, 1.0);
}

@fragment
fn lineFs() -> @location(0) vec4f {
  return vec4f(1.0, 0.86, 0.2, 1.0);
}

// Cell bounding boxes, drawn straight from the culling tables: one instance per slot, 24 vertices (12 edges).
struct BoxParams {
  mode: u32, // 1: drawn only, 2: selected (drawn + culled), 3: every resident cell
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(1) @binding(0) var<storage, read> boxes: array<vec4f>;    // slot * 2 = min.xyz, slot * 2 + 1 = max.xyz
@group(1) @binding(1) var<storage, read> selected: array<u32>;
@group(1) @binding(2) var<storage, read> args: array<u32>;       // 5 u32 per slot; [1] = instanceCount set by the cull pass
@group(1) @binding(3) var<uniform> boxParams: BoxParams;

const BOX_MODE_DRAWN = 1u;
const BOX_MODE_SELECTED = 2u;

struct BoxOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
}

@vertex
fn boxVs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) slot: u32) -> BoxOut {
  // Corner bits: x = 1, y = 2, z = 4. Pairs of corners make the 12 edges.
  var edges = array<u32, 24>(0u, 1u, 1u, 3u, 3u, 2u, 2u, 0u, 4u, 5u, 5u, 7u, 7u, 6u, 6u, 4u, 0u, 4u, 1u, 5u, 3u, 7u, 2u, 6u);
  var out: BoxOut;

  let resident = args[slot * 5u] > 0u;
  let isSelected = selected[slot] != 0u;
  let drawn = args[slot * 5u + 1u] != 0u;
  var show = resident;
  if (boxParams.mode == BOX_MODE_DRAWN) {
    show = resident && isSelected && drawn;
  } else if (boxParams.mode == BOX_MODE_SELECTED) {
    show = resident && isSelected;
  }
  if (!show) {
    // Behind the near plane: the line is clipped away.
    out.clip = vec4f(0.0, 0.0, -2.0, 1.0);
    out.color = vec3f(0.0);
    return out;
  }

  let corner = edges[vertex];
  let lo = boxes[slot * 2u].xyz;
  let hi = boxes[slot * 2u + 1u].xyz;
  let position = select(lo, hi, vec3<bool>((corner & 1u) != 0u, (corner & 2u) != 0u, (corner & 4u) != 0u));
  out.clip = frame.viewProj * vec4f(position, 1.0);
  // Green: drawn. Red: selected but culled. Grey: resident, not selected by the HLOD.
  out.color = select(select(vec3f(1.0, 0.25, 0.2), vec3f(0.2, 1.0, 0.4), drawn), vec3f(0.55, 0.55, 0.6), !isSelected);
  return out;
}

@fragment
fn boxFs(in: BoxOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
