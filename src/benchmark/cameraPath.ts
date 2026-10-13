import * as THREE from 'three'

export interface BenchmarkPath {
  /** Writes the camera position and look-at target for t in [0, 1); the path is a closed loop at constant speed. */
  sample(t: number, position: THREE.Vector3, target: THREE.Vector3): void
}

/**
 * The flight, in fractions of the model's bounds so it fits any model of this kind: a wide overview,
 * a bow approach, close passes along the deck, a run between the modules, a top-down pass and the
 * far side. Edit the waypoints to change what gets measured.
 */
export const createBenchmarkPath = (bounds: THREE.Box3): BenchmarkPath => {
  const size = bounds.getSize(new THREE.Vector3())
  const c = bounds.getCenter(new THREE.Vector3())
  const longest = Math.max(size.x, size.y, size.z)
  const { min, max } = bounds
  const at = (fx: number, y: number, z: number) => new THREE.Vector3(min.x + fx * size.x, y, z)

  const shots: [THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(c.x, c.y + size.y * 0.5 + longest * 0.15, max.z + longest * 0.6), c.clone()],
    [at(0.1, c.y + longest * 0.08, max.z + longest * 0.35), at(0.3, c.y, c.z)],
    [at(0.25, c.y + size.y * 0.25, max.z + longest * 0.12), at(0.45, c.y + size.y * 0.1, c.z)],
    [at(0.45, c.y + size.y * 0.35, c.z + size.z * 0.1), at(0.65, c.y + size.y * 0.2, c.z - size.z * 0.1)],
    [at(0.6, max.y + longest * 0.25, c.z + size.z * 0.05), at(0.68, c.y, c.z)],
    [at(0.95, c.y + size.y * 0.3, max.z + longest * 0.2), at(0.7, c.y + size.y * 0.1, c.z)],
    [at(0.75, c.y + size.y * 0.2, min.z - longest * 0.15), new THREE.Vector3(c.x, c.y + size.y * 0.1, c.z)],
    [at(0.3, c.y + size.y * 0.4, min.z - longest * 0.2), at(0.5, c.y + size.y * 0.1, c.z)],
  ]

  const positions = new THREE.CatmullRomCurve3(shots.map(([p]) => p), true, 'centripetal')
  const targets = new THREE.CatmullRomCurve3(shots.map(([, t]) => t), true, 'centripetal')

  return {
    sample(t, position, target) {
      const u = t - Math.floor(t)
      positions.getPointAt(u, position)
      targets.getPointAt(u, target)
    },
  }
}
