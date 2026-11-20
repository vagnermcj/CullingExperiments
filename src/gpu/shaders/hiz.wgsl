// Depth pyramid (Hi-Z) reduction. Dispatched once per pyramid level: every texel of `dst` summarises
// the block of `src` texels it covers.
//
// Level 0 reads the main depth buffer (bound as a plain float texture); level n reads level n - 1.
// Sizes follow the usual mip rule, dst = max(1, floor(src / 2)), so `src` may have odd dimensions.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dstSize = textureDimensions(dst);
  if (any(id.xy >= dstSize)) {
    return;
  }
  let srcSize = textureDimensions(src);

  // dst texel (x, y) covers the src block starting at (2x, 2y): 2 texels wide, or 3 on an axis where src
  // is odd, so the leftover row / column is not dropped. Depth is 0 = near, 1 = far, and the farthest
  // value of the block (max) is the conservative one: nothing nearer than it can be called hidden.
  // Coordinates are clamped because a 1-texel-wide src is odd and its 3-wide block would leave the texture.

  let x_max = select(2u, 1u, srcSize.x % 2u == 0u);
  let y_max = select(2u, 1u, srcSize.y % 2u == 0u);
  var depth = 0.0;

  for (var y = 0u; y <= y_max; y = y + 1u) {
    for (var x = 0u; x <= x_max; x = x + 1u) {
      let coords = min(id.xy * 2u + vec2u(x, y), srcSize - vec2u(1u));
      let src_texel = textureLoad(src, coords, 0).r;
      depth = max(depth, src_texel);
    }
  }
  
  textureStore(dst, id.xy, vec4f(depth, 0.0, 0.0, 1.0));
}
