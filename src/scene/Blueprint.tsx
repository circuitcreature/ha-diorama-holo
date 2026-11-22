import { DECORATION_KINDS } from '#/decoration/catalog.ts'
import type { CardConfig } from '#/types.ts'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { PASSAGE } from '#/scene/focus.ts'
import { Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Material, type Object3D } from 'three'

// The blueprint style paints the home as dark glass, with its edges traced
// in one color by the frame's last pass, see blueprintEdges.ts. Here every
// face gets its fill: a deep shade of the line color that keeps the pattern
// it had, so a tiled floor still shows its tiles. With an object color set,
// the furniture and everything else placed in the rooms is filled with it,
// solid, while the floors, walls, doors, windows and stairs stay glass.
// The signs on the floor that lead to the room beside are solid and unlit,
// in the line color unless the card gives them one of their own.
//
// A piece can have a fill and a line color of its own, over the card's.
// Its own fill is solid, whatever kind of piece it is. Its own line color
// is left on each of its meshes for the line pass to draw it in.
//
// Nothing in the scene is built for it. Each frame that is drawn, every
// mesh is looked at once more and its paint swapped for its fill. A lamp
// that is lit keeps its own paint, so a light still shows it is on. Pieces
// built later, or given new paint by their device, are found on the next
// frame.

// How much of the line color the glass takes, and how rough it is.
const FILL_SHARE = 0.14
const FILL_ROUGHNESS = 1

const DECORATION = 'decoration:'
const MERGED = 'merged:'

// Where a mesh keeps the paint of its own line color, and where the scene
// says whether any mesh has one, read by the line pass.
export const OWN_LINE = 'blueprintLine'
export const OWN_LINES = 'blueprintLines'

// The kinds that make the home rather than furnish it, filled as glass
// whatever the object color: walls, stairs, railings, and every door,
// window, blind and awning.
const STRUCTURE = new Set(['half_wall', 'stairs', 'railing'])
const STRUCTURE_KINDS = new Set(
  DECORATION_KINDS.filter(kind => STRUCTURE.has(kind.id) || kind.family === 'cover').map(kind => kind.id),
)

// The pieces of a card that are part of the home, by id.
function structureIds(config: CardConfig) {
  return new Set((config.decorations ?? []).filter(d => STRUCTURE_KINDS.has(d.kind)).map(d => d.id))
}

// The pieces with colors of their own, by id.
function ownColors(config: CardConfig) {
  const found = new Map<string, { line?: string; fill?: string }>()
  for (const d of config.decorations ?? []) if (d.blueprint?.line || d.blueprint?.fill) found.set(d.id, d.blueprint)
  return found
}

// The pieces kept out of the merged furniture, so each can be told apart
// from it: the home's own when the furniture is solid, and any with colors
// of its own.
export function unmerged(config: CardConfig) {
  const ids = new Set(ownColors(config).keys())
  if (config.style_objects) for (const id of structureIds(config)) ids.add(id)
  return ids
}

type Kept = {
  // The paint the mesh had, as its owner set it, and the fill made from it.
  source: Material | Material[]
  fill: Material | Material[]
}

// The glass and solid colors, the fill made for each paint, and the meshes
// changed, to put back when the style goes.
type Look = {
  glass: Color
  solid: string | null
  fills: Map<Material, MeshStandardMaterial>
  // Solid fills by their color, then by the paint they stand in for.
  solids: Map<string, Map<Material, MeshStandardMaterial>>
  // A plain paint for each line color of a piece's own.
  lines: Map<string, MeshBasicMaterial>
  // What every sign on the floor is filled with.
  sign: MeshBasicMaterial
  kept: Map<Mesh, Kept>
}

// The glass of a line color, as a hex string, for the editor to start a
// piece's own fill from.
export function glassColor(line: string) {
  return `#${new Color(line).multiplyScalar(FILL_SHARE).getHexString()}`
}

function makeLook(color: string, objects: string | undefined, arrows: string | undefined): Look {
  return {
    glass: new Color(color).multiplyScalar(FILL_SHARE),
    solid: objects ?? null,
    fills: new Map(),
    solids: new Map(),
    lines: new Map(),
    sign: new MeshBasicMaterial({ color: arrows ?? color }),
    kept: new Map(),
  }
}

// A fill for each paint, made once and shared by every mesh in that paint.
// Glass keeps the paint's pattern, darkened; a solid fill is the color alone.
function fillFor(look: Look, source: Material, solid: string | null) {
  let cache = solid ? look.solids.get(solid) : look.fills
  if (!cache) {
    cache = new Map()
    look.solids.set(solid!, cache)
  }
  let found = cache.get(source)
  if (!found) {
    const s = source as MeshStandardMaterial
    found = new MeshStandardMaterial({
      color: solid ?? look.glass,
      roughness: FILL_ROUGHNESS,
      metalness: 0,
      map: solid ? null : (s.map ?? null),
      normalMap: solid ? null : (s.normalMap ?? null),
      side: s.side,
      transparent: s.transparent,
      opacity: s.transparent ? Math.min(s.opacity, 0.6) : 1,
      alphaTest: s.alphaTest,
    })
    if (!solid && s.normalScale) found.normalScale.copy(s.normalScale)
    cache.set(source, found)
  }
  return found
}

function lineFor(look: Look, color: string) {
  let found = look.lines.get(color)
  if (!found) {
    found = new MeshBasicMaterial({ color })
    look.lines.set(color, found)
  }
  return found
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

// The piece a mesh is part of, by id, `merged` for merged furniture, or null
// for anything else, like a floor.
function pieceOf(mesh: Object3D): string | null {
  for (let node: Object3D | null = mesh; node; node = node.parent) {
    if (node.name.startsWith(MERGED)) return MERGED
    if (node.name.startsWith(DECORATION)) return node.name.slice(DECORATION.length)
  }
  return null
}

type Pieces = {
  structure: ReadonlySet<string>
  own: ReadonlyMap<string, { line?: string; fill?: string }>
}

// Every mesh in the scene in its fill, or its own paint while it glows.
function paint(scene: Object3D, look: Look, pieces: Pieces) {
  const seen = new Set<Mesh>()
  let ownLines = false
  scene.traverse(object => {
    if (!(object instanceof Mesh)) return
    if ((object as { isSkinnedMesh?: boolean }).isSkinnedMesh) return
    let k = look.kept.get(object)
    // New paint from its owner, or a mesh not seen before.
    if (!k || (object.material !== k.source && object.material !== k.fill)) {
      if (untouched(object)) return
      const source = object.material
      const piece = pieceOf(object)
      const own = piece ? pieces.own.get(piece) : undefined
      const furniture = piece === MERGED || (piece !== null && !pieces.structure.has(piece))
      const solid = own?.fill ?? (furniture ? look.solid : null)
      const fill = (m: Material) => (object.name.startsWith(PASSAGE) ? look.sign : fillFor(look, m, solid))
      k = { source, fill: Array.isArray(source) ? source.map(fill) : fill(source) }
      look.kept.set(object, k)
      if (own?.line) object.userData[OWN_LINE] = lineFor(look, own.line)
      else delete object.userData[OWN_LINE]
    }
    const sources = Array.isArray(k.source) ? k.source : [k.source]
    object.material = sources.some(glows) ? k.source : k.fill
    if (object.userData[OWN_LINE]) ownLines = true
    seen.add(object)
  })
  scene.userData[OWN_LINES] = ownLines
  // Meshes that have left the scene are let go of.
  for (const mesh of look.kept.keys()) if (!seen.has(mesh)) look.kept.delete(mesh)
}

// Every mesh gets its own paint back.
function restore(scene: Object3D, look: Look) {
  for (const [mesh, k] of look.kept) {
    if (mesh.material === k.fill) mesh.material = k.source
    delete mesh.userData[OWN_LINE]
  }
  look.kept.clear()
  delete scene.userData[OWN_LINES]
  for (const fill of look.fills.values()) fill.dispose()
  for (const solids of look.solids.values()) for (const fill of solids.values()) fill.dispose()
  for (const line of look.lines.values()) line.dispose()
  look.fills.clear()
  look.solids.clear()
  look.lines.clear()
  look.sign.dispose()
}

type Props = {
  config: CardConfig
  // The color of the lines, as a hex string. The glass is a deep shade of it.
  color: string
}

export default function Blueprint({ config, color }: Props) {
  const scene = useThree(s => s.scene)
  const invalidate = useThree(s => s.invalidate)
  // The pieces' own colors, as one string, so the look is made again only
  // when one of them changes.
  const own = useMemo(() => JSON.stringify([...ownColors(config)]), [config])
  const pieces = useMemo<Pieces>(
    () => ({
      structure: structureIds(config),
      own: new Map(JSON.parse(own) as [string, { line?: string; fill?: string }][]),
    }),
    [config, own],
  )
  const objects = config.style_objects
  const arrows = config.style_arrows
  // Made again with any color, a piece's own too, so every mesh is painted
  // again from its own paint.
  const look = useMemo(() => ({ ...makeLook(color, objects, arrows), own }), [color, objects, arrows, own])

  // Before the frame is drawn, so what was built since is drawn in the style.
  useFrame(() => paint(scene, look, pieces), -1)

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
