import { SLAB_BEVEL_SEGMENTS, SLAB_CURVE_SEGMENTS } from '#/constants.ts'
import SurfaceMaterial from '#/scene/SurfaceMaterial.tsx'
import type { SurfaceKind } from '#/materials/textures.ts'
import { FLOOR_MATERIALS, FLOOR_PATTERN_SHIFT_M, ROOM_SLAB_EDGE_RADIUS_M, ROOM_SLAB_THICKNESS_M } from '#/theme.ts'
import { floorColor } from '#/scene/floorColor.ts'
import { useEased } from '#/scene/decor/ease.ts'
import { presenceTint } from '#/scene/presence.ts'
import { ensureCounterClockwise, inset, roundedShape } from '#/geometry/polygon.ts'
import { elevationOf } from '#/geometry/elevation.ts'
import { slabGeometry, touchesNeighbour } from '#/geometry/slab.ts'
import { wallGeometry, type OpeningPiece } from '#/geometry/walls.ts'
import { decorationKind, footprint, paramValue } from '#/decoration/catalog.ts'
import { WALL_COLOR, WALL_HEIGHT_M, WALL_THICKNESS_M } from '#/theme.ts'
import type { DecorationConfig, Point, RoomConfig, WallsConfig } from '#/types.ts'
import { memo, useEffect, useMemo } from 'react'
import { useBlueprintMode } from '#/scene/blueprintMode.ts'

// Floors this close to touching are drawn as touching, in meters.
const TOUCHING_GAP_M = 0.001

type Props = {
  room: RoomConfig
  // Every room of the home, to tell where this one touches another.
  rooms: RoomConfig[]
  index: number
  radius: number
  gap: number
  // Someone is in the room, by its presence sensor.
  occupied?: boolean
  // The card's walls, when it has them, and the pieces whose doors and
  // windows cut openings in them.
  walls?: WallsConfig | null
  decorations?: DecorationConfig[]
}

// The pieces that cut an opening in a wall, and how high up it starts.
const OPENING_KINDS = new Set(['door', 'sliding_door', 'garage_door', 'window'])

function openingPieces(decorations: DecorationConfig[], onFloor: (room: string) => boolean): OpeningPiece[] {
  const found: OpeningPiece[] = []
  for (const item of decorations) {
    if (!OPENING_KINDS.has(item.kind) || !onFloor(item.room)) continue
    const kind = decorationKind(item.kind)
    if (!kind) continue
    const bottom = item.kind === 'window' ? paramValue(kind, item.params, 'sill', item.variant) : 0
    found.push({
      position: item.position,
      width: footprint(kind, item.params, item.variant)[0],
      bottom,
      top: bottom + paramValue(kind, item.params, 'height', item.variant),
    })
  }
  return found
}

// Clicks on the floor are not taken here. The press fallback finds the room
// under a press once the pieces around it have had their turn.
function Room({ room, rooms, index, radius, gap, occupied = false, walls = null, decorations = [] }: Props) {
  const elevation = elevationOf(room)
  // With every floor in view, a floor reaches down only as far as the
  // lowest room of its own floor, and leaves the floor below in sight.
  const storey = room.storey ?? 0
  const lowest = Math.min(storey, ...rooms.filter(other => (other.storey ?? 0) === storey).map(elevationOf))
  const geometry = useMemo(() => {
    const points = inset(ensureCounterClockwise(room.points), gap / 2)
    const cornerRadius = room.radius ?? radius
    // With no gap, floors that touch meet flat and square: the edge is only
    // rounded over, and a corner only rounded off, where it stands free.
    // With a gap every floor stands free, and so does a floor along a lower
    // one, where it is rounded over as a step down.
    const neighbours =
      gap > TOUCHING_GAP_M
        ? []
        : rooms
            .filter(other => other.id !== room.id && (other.storey ?? 0) === storey && elevationOf(other) >= elevation)
            .map(r => r.points)
    // A concave corner wraps around a neighbour's convex corner. For the two
    // arcs to be concentric its radius grows by the gap.
    const outline = roundedShape(points, cornerRadius, cornerRadius + gap, i => touchesNeighbour(points[i], neighbours))
      .getPoints(SLAB_CURVE_SEGMENTS)
      .map((p): Point => [p.x, p.y])
    return slabGeometry(
      outline,
      neighbours,
      ROOM_SLAB_EDGE_RADIUS_M,
      // A floor raised above the lowest one reaches down to it, so it stands
      // as a solid step and not as a sheet in the air.
      ROOM_SLAB_THICKNESS_M + elevation - lowest,
      SLAB_BEVEL_SEGMENTS,
      FLOOR_PATTERN_SHIFT_M,
    )
  }, [room.id, room.points, room.radius, rooms, radius, gap, elevation, lowest, storey])

  // The walls along the outline, each room building its own half of a wall
  // it shares, see walls.ts.
  const wallHeight = walls && room.walls !== 'none' ? (walls.height ?? WALL_HEIGHT_M) : 0
  const freeWalls = room.walls !== 'shared'
  const wallThickness = walls?.thickness ?? WALL_THICKNESS_M
  const wallShape = useMemo(() => {
    if (!wallHeight) return null
    const sameFloor = (other: RoomConfig) =>
      (other.storey ?? 0) === storey && (other.floor_id ?? '') === (room.floor_id ?? '')
    const outline = inset(ensureCounterClockwise(room.points), gap / 2)
    const beside = rooms.filter(other => other.id !== room.id && sameFloor(other))
    const neighbours = beside.map(other => inset(ensureCounterClockwise(other.points), gap / 2))
    const floorRooms = new Set([room.id, ...beside.map(other => other.id)])
    const pieces = openingPieces(decorations, id => floorRooms.has(id))
    return wallGeometry(outline, neighbours, wallHeight, wallThickness, pieces, freeWalls)
  }, [room.id, room.points, room.floor_id, rooms, gap, storey, wallHeight, wallThickness, decorations, freeWalls])
  useEffect(() => () => wallShape?.dispose(), [wallShape])

  // In the blueprint style the floor has no pattern, so none is baked.
  const blueprint = useBlueprintMode()
  const floor = room.floor && !blueprint ? FLOOR_MATERIALS[room.floor.material] : undefined
  // The presence filter fades over the floor and away again.
  const shown = useEased(occupied ? 1 : 0, 4)
  const color = presenceTint(floorColor(room, index), room, shown)

  return (
    <mesh
      // Named so the outline and the press fallback can find the room.
      name={`room:${room.id}`}
      position={[0, elevation, 0]}
      geometry={geometry}
      castShadow
      receiveShadow
    >
      {floor ? (
        // Extrude UVs are plan meters, so the surface tiles at its own
        // physical size, scaled and turned by what the room asks for.
        <SurfaceMaterial
          kind={(floor.surface ?? 'matte') as SurfaceKind}
          color={color}
          scale={room.floor?.scale ?? 1}
          rotation={room.floor?.rotation ?? 0}
          intensity={room.floor?.intensity ?? 1}
        />
      ) : (
        <meshStandardMaterial color={color} roughness={0.85} />
      )}
      {/* A part of the room, so it shows, hides and is pressed with it. */}
      {wallShape && (
        <mesh name={`walls:${room.id}`} geometry={wallShape} castShadow receiveShadow userData={{ room: room.id }}>
          <meshStandardMaterial color={walls?.color ?? WALL_COLOR} roughness={0.9} />
        </mesh>
      )}
    </mesh>
  )
}

export default memo(Room)
