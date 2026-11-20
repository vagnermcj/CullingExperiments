// Debug view: one level of the depth pyramid stretched over the main view, as linear depth in grey.

struct Params {
  viewport: vec2f, // render target size in pixels
  near: f32,
  far: f32,
  mip: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var pyramid: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) fragment: vec4f) -> @location(0) vec4f {
  // Nearest texel, no filtering: the blocks of the chosen level stay visible.
  let size = textureDimensions(pyramid, params.mip);
  let uv = fragment.xy / params.viewport;
  let texel = min(vec2u(uv * vec2f(size)), size - vec2u(1u));
  let depth = textureLoad(pyramid, texel, params.mip).r;

  // Perspective depth is crowded near 1; view-space distance spreads it out. Black is near, white is far.
  let distance = params.near * params.far / (params.far - depth * (params.far - params.near));
  let shade = sqrt(distance / params.far);
  return vec4f(vec3f(shade), 1.0);
}
