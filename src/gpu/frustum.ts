import type { Matrix4 } from 'three'

export const PLANE_COUNT = 6

/**
 * Writes the six frustum planes of a view-projection matrix into `out` as (nx, ny, nz, d) x 6,
 * ordered left, right, bottom, top, near, far.
 *
 * Normals point INTO the frustum, so a point p is inside a plane when dot(n, p) + d >= 0.
 * Method: Gribb & Hartmann, "Fast Extraction of Viewing Frustum Planes from the World-View-Projection Matrix".
 */
export const extractFrustumPlanes = (viewProjection: Matrix4, out: Float32Array): void => {
  const e = viewProjection.elements // column-major: row r is e[r], e[r + 4], e[r + 8], e[r + 12]
  const row = (r: number): [number, number, number, number] => [e[r], e[r + 4], e[r + 8], e[r + 12]]
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)]

  // A point is inside the volume when, for its clip-space (x, y, z, w):  -w <= x <= w,  -w <= y <= w,  0 <= z <= w.
  // Each inequality is "row combination >= 0", i.e. one plane. The z range starts at 0 (WebGPU), not -w (WebGL),
  // which is why the near plane is just row 2.
  const planes: [number, number, number, number][] = [
    [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]], // left:   w + x >= 0
    [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]], // right:  w - x >= 0
    [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]], // bottom: w + y >= 0
    [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]], // top:    w - y >= 0
    [r2[0], r2[1], r2[2], r2[3]], //                                 near:   z >= 0
    [r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]], // far:    w - z >= 0
  ]

  planes.forEach(([a, b, c, d], i) => {
    // Normalising makes d a real distance, which the box test below relies on.
    const length = Math.hypot(a, b, c) || 1
    out[i * 4] = a / length
    out[i * 4 + 1] = b / length
    out[i * 4 + 2] = c / length
    out[i * 4 + 3] = d / length
  })
}
