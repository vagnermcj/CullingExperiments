import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export const GROUND_SIZE = 400
// Starting position of the camera; the walls are placed in front of it.
export const START_POSITION = new THREE.Vector3(0, 3, 24)

const TREE_URL = `${import.meta.env.BASE_URL}data/tree.glb`
const TREE_HEIGHT = 6
const TREE_SCALE_JITTER = 0.25

// Walls: [x, z, width]. Height and thickness are shared.
const WALLS: readonly (readonly [number, number, number])[] = [
  [-20, 8, 18],
  [0, 4, 18],
  [20, 8, 18],
  [-8, -8, 24],
  [12, -14, 24],
]
const WALL_HEIGHT = 8
const WALL_THICKNESS = 1.5

// R2 low-discrepancy sequence: point i is fixed regardless of the tree count and
// any prefix of the sequence is uniformly spread, so changing N never moves the
// trees that already exist.
const PLASTIC = 1.324717957244746
const R2_A1 = 1 / PLASTIC
const R2_A2 = 1 / (PLASTIC * PLASTIC)

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export interface ForestScene {
  group: THREE.Group
  setTreeCount: (count: number) => void
  setWalls: (enabled: boolean) => void
}

// Used when tree.glb is missing so the scene is still usable.
const createFallbackTree = (): THREE.Object3D => {
  const tree = new THREE.Group()
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.35, TREE_HEIGHT * 0.3, 8),
    new THREE.MeshStandardMaterial({ color: '#6b4a2b' }),
  )
  trunk.position.y = TREE_HEIGHT * 0.15
  const crown = new THREE.Mesh(
    new THREE.ConeGeometry(1.6, TREE_HEIGHT * 0.8, 10),
    new THREE.MeshStandardMaterial({ color: '#2f6b3a' }),
  )
  crown.position.y = TREE_HEIGHT * 0.3 + TREE_HEIGHT * 0.4
  tree.add(trunk, crown)
  return tree
}

// Scales the model to TREE_HEIGHT and puts its base at y = 0, centered on x/z.
const normalizeTree = (model: THREE.Object3D): THREE.Object3D => {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const scale = size.y > 0 ? TREE_HEIGHT / size.y : 1
  const holder = new THREE.Group()
  model.scale.multiplyScalar(scale)
  model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale)
  holder.add(model)
  return holder
}

const loadTree = async (): Promise<THREE.Object3D> => {
  try {
    const gltf = await new GLTFLoader().loadAsync(TREE_URL)
    return normalizeTree(gltf.scene)
  } catch (error) {
    console.warn(`Could not load ${TREE_URL}, using a placeholder tree.`, error)
    return createFallbackTree()
  }
}

export const createForestScene = (): ForestScene => {
  const group = new THREE.Group()

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
    new THREE.MeshStandardMaterial({ color: '#3e5a34' }),
  )
  ground.rotation.x = -Math.PI / 2
  group.add(ground)

  const walls = new THREE.Group()
  const wallMaterial = new THREE.MeshStandardMaterial({ color: '#8a8f98' })
  for (const [x, z, width] of WALLS) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, WALL_HEIGHT, WALL_THICKNESS), wallMaterial)
    wall.position.set(x, WALL_HEIGHT / 2, z)
    walls.add(wall)
  }
  group.add(walls)

  const trees = new THREE.Group()
  group.add(trees)

  let template: THREE.Object3D | null = null
  let targetCount = 0

  const createTree = (index: number): THREE.Object3D => {
    const random = mulberry32(index + 1)
    const tree = new THREE.Group()
    tree.add(template!.clone())
    tree.position.set(
      (((0.5 + index * R2_A1) % 1) - 0.5) * GROUND_SIZE,
      0,
      (((0.5 + index * R2_A2) % 1) - 0.5) * GROUND_SIZE,
    )
    tree.rotation.y = random() * Math.PI * 2
    tree.scale.setScalar(1 + (random() * 2 - 1) * TREE_SCALE_JITTER)
    return tree
  }

  // Grows or shrinks the pool from the end, so existing trees stay untouched.
  const applyTreeCount = () => {
    if (!template) return
    while (trees.children.length > targetCount) trees.remove(trees.children[trees.children.length - 1])
    while (trees.children.length < targetCount) trees.add(createTree(trees.children.length))
  }

  void loadTree().then((tree) => {
    template = tree
    applyTreeCount()
  })

  return {
    group,
    setTreeCount: (count) => {
      targetCount = Math.max(0, Math.floor(count))
      applyTreeCount()
    },
    setWalls: (enabled) => {
      walls.visible = enabled
    },
  }
}
