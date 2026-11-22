import { cutAtNeighbours, touchesNeighbour } from '#/geometry/slab.ts'
import type { Point } from '#/types.ts'
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three'

// The walls of a room, raised along its outline from the top of its floor.
//
// A wall is centred on the room's edge. Where the edge runs along another
// room, this room builds only the half on its own side and the other room
// builds the other half, so a wall between two rooms comes out whole and is
// drawn once. Where the edge stands free, this room builds the whole of it.
// The corners are mitred, so each edge's wall meets the next one cleanly.
//
// A door or a window standing on an edge cuts its opening out of the wall:
// the wall stops either side of it and carries on above it, and below it
// for a window.
//
// The floor's top is at y = 0 and plan y maps to -z, as for the slab.

// A gap in an edge's wall: from `from` to `to` meters along the edge, and
// from `bottom` to `top` meters up.
export type Opening = { from: number; to: number; bottom: number; top: number }

// A door or window on the plan, to be matched to the edge it stands on.
export type OpeningPiece = { position: Point; width: number; bottom: number; top: number }

// How far off an edge a piece may stand and still be in its wall, in meters.
// Wider than a wall is thick, narrower than a door is wide.
const OPENING_REACH_M = 0.3
// Edges nearly in line are treated as one straight wall at their joint.
const PARALLEL = 1e-3

type Line = { a: Point; dx: number; dy: number; nx: number; ny: number; length: number }

// Where two offset lines cross, or null where they run side by side.
function cross(p: Point, d: Point, q: Point, e: Point): Point | null {
  const det = d[0] * e[1] - d[1] * e[0]
  if (Math.abs(det) < PARALLEL) return null
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / det
  return [p[0] + d[0] * t, p[1] + d[1] * t]
}

// A solid block over a four cornered patch of the plan, from y0 up to y1,
// pushed as triangles with flat normals that face out.
function prism(out: number[], normals: number[], quad: Point[], y0: number, y1: number) {
  if (y1 - y0 < 1e-4) return
  const v = (p: Point, y: number) => new Vector3(p[0], y, -p[1])
  const bottom = quad.map(p => v(p, y0))
  const top = quad.map(p => v(p, y1))
  const centre = new Vector3()
  for (const p of [...bottom, ...top]) centre.add(p)
  centre.divideScalar(8)
  const faces: Vector3[][] = [top, [...bottom].reverse()]
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    faces.push([bottom[i], bottom[j], top[j], top[i]])
  }
  const n = new Vector3()
  const ab = new Vector3()
  const ac = new Vector3()
  const mid = new Vector3()
  for (const face of faces) {
    ab.subVectors(face[1], face[0])
    ac.subVectors(face[2], face[0])
    n.crossVectors(ab, ac)
    if (n.lengthSq() < 1e-12) {
      ac.subVectors(face[3], face[0])
      n.crossVectors(ab, ac)
    }
    if (n.lengthSq() < 1e-12) continue
    n.normalize()
    // Turned to face away from the middle of the block.
    mid.copy(face[0]).add(face[2]).multiplyScalar(0.5).sub(centre)
    const flip = n.dot(mid) < 0
    if (flip) n.negate()
    const tris = flip
      ? [face[0], face[2], face[1], face[0], face[3], face[2]]
      : [face[0], face[1], face[2], face[0], face[2], face[3]]
    for (const p of tris) {
      out.push(p.x, p.y, p.z)
      normals.push(n.x, n.y, n.z)
    }
  }
}

// The openings each edge of `outline` has, from the pieces that stand on it.
export function openingsOf(outline: Point[], pieces: OpeningPiece[]): Opening[][] {
  return outline.map((a, i) => {
    const b = outline[(i + 1) % outline.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const length = Math.hypot(dx, dy) || 1
    const found: Opening[] = []
    for (const piece of pieces) {
      const rx = piece.position[0] - a[0]
      const ry = piece.position[1] - a[1]
      const along = (rx * dx + ry * dy) / length
      const off = Math.abs(rx * dy - ry * dx) / length
      if (off > OPENING_REACH_M || along < -0.05 || along > length + 0.05) continue
      found.push({
        from: Math.max(0, along - piece.width / 2),
        to: Math.min(length, along + piece.width / 2),
        bottom: piece.bottom,
        top: piece.top,
      })
    }
    return found.sort((x, y) => x.from - y.from)
  })
}

// The walls of a room, `height` tall and `thickness` thick, along `outline`,
// counter clockwise on the plan. `neighbours` are the outlines of the rooms
// beside it on the same floor, and `pieces` its doors and windows. Without
// `free` the room builds only the walls it shares, as a porch does, and a
// shared wall ends square where it meets an open side.
export function wallGeometry(
  outline: Point[],
  neighbours: Point[][],
  height: number,
  thickness: number,
  pieces: OpeningPiece[],
  free = true,
): BufferGeometry {
  const geometry = new BufferGeometry()
  const points = neighbours.length > 0 ? cutAtNeighbours(outline, neighbours) : outline
  const n = points.length
  if (n < 3 || height <= 0 || thickness <= 0) return geometry
  const half = thickness / 2
  const lines: Line[] = points.map((a, i) => {
    const b = points[(i + 1) % n]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const length = Math.hypot(dx, dy) || 1
    return { a, dx: dx / length, dy: dy / length, nx: -dy / length, ny: dx / length, length }
  })
  // How far each edge's wall reaches out past the edge: half the wall where
  // it stands free, and none where the room beside builds that half.
  const outward = points.map((a, i) => {
    const b = points[(i + 1) % n]
    return touchesNeighbour([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], neighbours) ? 0 : half
  })
  // The four corners of each edge's wall: where its inner and outer faces
  // meet the faces of the walls before and after it.
  const face = (i: number, offset: number): [Point, Point] => {
    const l = lines[i]
    return [
      [l.a[0] + l.nx * offset, l.a[1] + l.ny * offset],
      [l.dx, l.dy],
    ]
  }
  // Whether an edge's wall is built at all.
  const built = (i: number) => free || outward[i] === 0
  const end = (i: number, j: number, mine: number, theirs: number, start: boolean): Point => {
    const [p, d] = face(i, mine)
    const [q, e] = face(j, theirs)
    const met = built(j) ? cross(p, d, q, e) : null
    if (met) return met
    // In line with the next edge: a square end, which steps where a free
    // wall carries on as a shared one.
    const l = lines[i]
    const s = start ? 0 : l.length
    return [p[0] + d[0] * s, p[1] + d[1] * s]
  }
  const openings = openingsOf(points, pieces)
  const position: number[] = []
  const normal: number[] = []
  for (let i = 0; i < n; i++) {
    if (!built(i)) continue
    const prev = (i - 1 + n) % n
    const next = (i + 1) % n
    const l = lines[i]
    // Inward is +normal for a counter clockwise outline.
    const corners = {
      innerStart: end(i, prev, half, half, true),
      innerEnd: end(i, next, half, half, false),
      outerStart: end(i, prev, -outward[i], -outward[prev], true),
      outerEnd: end(i, next, -outward[i], -outward[next], false),
    }
    // A point on the inner or outer face, `s` meters along the edge, the
    // mitred corner at either end.
    const at = (s: number, inner: boolean): Point => {
      if (s <= 0) return inner ? corners.innerStart : corners.outerStart
      if (s >= l.length) return inner ? corners.innerEnd : corners.outerEnd
      const o = inner ? half : -outward[i]
      return [l.a[0] + l.dx * s + l.nx * o, l.a[1] + l.dy * s + l.ny * o]
    }
    const span = (s0: number, s1: number, y0: number, y1: number) => {
      if (s1 - s0 < 1e-4) return
      prism(position, normal, [at(s0, false), at(s1, false), at(s1, true), at(s0, true)], y0, y1)
    }
    let s = 0
    for (const o of openings[i]) {
      const from = Math.max(o.from, s)
      if (from > s) span(s, from, 0, height)
      const to = Math.max(o.to, from)
      // Under a window and over a door or a window.
      if (o.bottom > 0) span(from, to, 0, Math.min(o.bottom, height))
      if (o.top < height) span(from, to, Math.max(o.top, 0), height)
      s = to
    }
    span(s, l.length, 0, height)
  }
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3))
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return geometry
}
