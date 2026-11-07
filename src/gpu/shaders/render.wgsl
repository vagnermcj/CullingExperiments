struct Frame {
  viewProj: mat4x4f,
  sunDir: vec4f,       // xyz: direction towards the sun
  sunColor: vec4f,     // rgb linear, a: intensity
  skyColor: vec4f,     // rgb linear, a: intensity
  groundColor: vec4f,  // rgb linear
  background: vec4f,   // rgb already sRGB-encoded
}

@group(0) @binding(0) var<uniform> frame: Frame;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec4f,  // snorm8x4, w is padding
  @location(2) color: vec4f,   // unorm8x4, a is padding
}

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
}

const PI = 3.14159265359;

@vertex
fn vs(in: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.clip = frame.viewProj * vec4f(in.position, 1.0);
  out.normal = in.normal.xyz;
  out.color = in.color.rgb;
  return out;
}

fn srgbEncode(linear: vec3f) -> vec3f {
  let low = linear * 12.92;
  let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3f(0.0031308));
}

@fragment
fn fs(in: VertexOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  var n = normalize(in.normal);
  if (!frontFacing) {
    n = -n; // cells are double-sided; shade the back face with the flipped normal
  }

  // Hemisphere ambient + one directional light, Lambert diffuse (albedo / PI), like the previous three.js look.
  let ambient = mix(frame.groundColor.rgb, frame.skyColor.rgb, n.y * 0.5 + 0.5) * frame.skyColor.a;
  let sun = frame.sunColor.rgb * frame.sunColor.a * max(dot(n, frame.sunDir.xyz), 0.0);
  let lit = in.color * (ambient + sun) / PI;
  return vec4f(srgbEncode(lit), 1.0);
}
