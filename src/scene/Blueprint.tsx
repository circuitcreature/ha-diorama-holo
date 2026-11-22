import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Object3D,
} from 'three'

// The blueprint style draws the home as lines on dark glass: every edge
// where two faces of a shape meet at a sharp angle is traced in one color,
// and the faces are filled with a deep shade of it, so walls still hide
// what stands behind them, still take presses and still catch shade.
//
// Nothing in the scene is built for it. Each frame that is drawn, every
// mesh is looked at once more: its paint is swapped for a fill made from it,
// keeping its pattern, and it gets its edges as a child. A lamp that is lit
// keeps its own paint, so a light still shows it is on. Pieces built later,
// or given new paint by their device, are found on the next frame.

// Faces that meet at less than this, in degrees, are taken as one surface,
// so a curve is not drawn as a fan of lines.
const EDGE_ANGLE_DEG = 30
// How much of the line color the fill takes, and how rough it is.
const FILL_SHARE = 0.14
const FILL_ROUGHNESS = 1
// How far the lines are drawn towards the camera, as a share of depth, so
// they sit on top of the faces they lie along instead of breaking into
// dashes against them.
const LINE_LIFT = 0.0006

const EDGE = 'blueprint:edge'

type Kept = {
  // The paint the mesh had, as its owner set it, and the fill made from it.
  source: Material | Material[]
  fill: Material | Material[]
}

// Edges of each shape, made once however many meshes share it, and let go
// of with it.
const edgesOf = new WeakMap<BufferGeometry, EdgesGeometry>()
function edges(geometry: BufferGeometry) {
  let found = edgesOf.get(geometry)
  if (!found) {
    found = new EdgesGeometry(geometry, EDGE_ANGLE_DEG)
    edgesOf.set(geometry, found)
    const made = found
    geometry.addEventListener('dispose', () => {
      made.dispose()
      edgesOf.delete(geometry)
    })
  }
  return found
}

// The edges of every copy of an instanced mesh, each placed where its copy
// stands, as one shape.
const at = new Matrix4()
const v = new Vector3()
function instancedEdges(mesh: InstancedMesh) {
  const one = edges(mesh.geometry).attributes.position
  const position = new Float32Array(one.count * 3 * mesh.count)
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, at)
    for (let j = 0; j < one.count; j++) {
      v.fromBufferAttribute(one, j).applyMatrix4(at)
      const k = (i * one.count + j) * 3
      position[k] = v.x
      position[k + 1] = v.y
      position[k + 2] = v.z
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(position, 3))
  return geometry
}

// Whether a paint glows, like a lamp that is on.
function glows(material: Material) {
  const m = material as MeshStandardMaterial
  return !!m.emissive && m.emissiveIntensity > 0 && (m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0)
}

// Whether a mesh is left as it is: steam, a beam of light, a glow, anything
// drawn without depth, which is light and not a thing.
function untouched(mesh: Mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials.some(m => !m.depthWrite || m.type === 'ShaderMaterial' || m.type === 'RawShaderMaterial')
}

type Props = {
  // The color of the lines, as a hex string. The fill is a deep shade of it.
  color: string
}

// The line and fill of one color, the fill made for each paint, and the
// meshes changed, to put back when the style goes.
type Look = {
  line: LineBasicMaterial
  fill: Color
  fills: Map<Material, MeshStandardMaterial>
  kept: Map<Mesh, Kept>
}

function makeLook(color: string): Look {
  const line = new LineBasicMaterial({ color, toneMapped: false })
  // Lifted towards the camera a little, see LINE_LIFT.
  line.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_vertex>',
      `#include <fog_vertex>\n\tgl_Position.z -= ${LINE_LIFT.toFixed(6)} * gl_Position.w;`,
    )
  }
  line.customProgramCacheKey = () => 'blueprint-line'
  return { line, fill: new Color(color).multiplyScalar(FILL_SHARE), fills: new Map(), kept: new Map() }
}

// A fill for each paint, made once and shared by every mesh in that paint.
// Its pattern stays, darkened to the fill, so a tiled floor still shows its
// tiles.
function fillFor(look: Look, source: Material) {
  let found = look.fills.get(source)
  if (!found) {
    const s = source as MeshStandardMaterial
    found = new MeshStandardMaterial({
      color: look.fill,
      roughness: FILL_ROUGHNESS,
      metalness: 0,
      map: s.map ?? null,
      normalMap: s.normalMap ?? null,
      side: s.side,
      transparent: s.transparent,
      opacity: s.transparent ? Math.min(s.opacity, 0.6) : 1,
      alphaTest: s.alphaTest,
    })
    if (s.normalScale) found.normalScale.copy(s.normalScale)
    look.fills.set(source, found)
  }
  return found
}

// The edges of a mesh, as a child that follows it. An instanced mesh has the
// edges of every copy, made again when the copies move.
function lines(look: Look, mesh: Mesh) {
  let child = mesh.children.find(c => c.name === EDGE) as LineSegments | undefined
  if (!child) {
    child = new LineSegments(undefined, look.line)
    child.name = EDGE
    // Presses go to the faces, never to a line.
    child.raycast = () => {}
    child.userData.noShadow = true
    mesh.add(child)
  }
  child.material = look.line
  if (mesh instanceof InstancedMesh) {
    const version = `${mesh.instanceMatrix.version}:${mesh.count}:${mesh.geometry.uuid}`
    if (child.userData.version !== version) {
      if (child.userData.version !== undefined) child.geometry.dispose()
      child.geometry = instancedEdges(mesh)
      child.userData.version = version
    }
  } else if (child.geometry !== edgesOf.get(mesh.geometry)) child.geometry = edges(mesh.geometry)
}

// Every mesh in the scene in its fill, or its own paint while it glows, with
// its edges.
function paint(scene: Object3D, look: Look) {
  const seen = new Set<Mesh>()
  scene.traverse(object => {
    if (!(object instanceof Mesh) || object.name === EDGE) return
    if ((object as { isSkinnedMesh?: boolean }).isSkinnedMesh) return
    let k = look.kept.get(object)
    // New paint from its owner, or a mesh not seen before.
    if (!k || (object.material !== k.source && object.material !== k.fill)) {
      if (untouched(object)) return
      const source = object.material
      k = { source, fill: Array.isArray(source) ? source.map(m => fillFor(look, m)) : fillFor(look, source) }
      look.kept.set(object, k)
    }
    const sources = Array.isArray(k.source) ? k.source : [k.source]
    object.material = sources.some(glows) ? k.source : k.fill
    lines(look, object)
    seen.add(object)
  })
  // Meshes that have left the scene are let go of.
  for (const mesh of look.kept.keys()) if (!seen.has(mesh)) look.kept.delete(mesh)
}

// Every mesh gets its own paint back and loses its edges.
function restore(scene: Object3D, look: Look) {
  const gone: Object3D[] = []
  scene.traverse(object => {
    if (object.name === EDGE) gone.push(object)
  })
  for (const object of gone) {
    if (object.userData.version !== undefined) (object as LineSegments).geometry.dispose()
    object.removeFromParent()
  }
  for (const [mesh, k] of look.kept) if (mesh.material === k.fill) mesh.material = k.source
  look.kept.clear()
  for (const fill of look.fills.values()) fill.dispose()
  look.fills.clear()
  look.line.dispose()
}

export default function Blueprint({ color }: Props) {
  const scene = useThree(s => s.scene)
  const invalidate = useThree(s => s.invalidate)
  const look = useMemo(() => makeLook(color), [color])

  // Before the frame is drawn, so what was built since is drawn in the style.
  useFrame(() => paint(scene, look), -1)

  // A new color is drawn at once, and the style going is too.
  useEffect(() => {
    invalidate()
    return () => {
      restore(scene, look)
      invalidate()
    }
  }, [scene, look, invalidate])

  return null
}
