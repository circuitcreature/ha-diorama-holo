import { OWN_LINE, OWN_LINES } from '#/scene/Blueprint.tsx'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import {
  Color,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  Uniform,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three'

// The lines of the blueprint style, found in the finished picture rather
// than in the shapes. Each pixel rebuilds the points around it from the
// depth of the frame and draws a line where they stop lying flat: a corner
// or a crease, however softly the shape rounds it. Where one thing stands in
// front of another the line is drawn on the near one. A flat floor gets no
// line across it, and a shape against nothing at all gets none along that
// edge, so a floor shows its top edge once and not its underside as well.
//
// Only what writes depth is seen, so steam, a beam or a glow gets no lines.
//
// A piece with a line color of its own is drawn in it. When any piece has
// one, the scene is drawn once more before the lines, flat, each piece in
// its line color and the rest in the card's, and a line takes its color
// from there, from the near side of the edge it is on. Without one that
// drawing is skipped and every line takes the card's color.

// How sharply the surface turns between two pixels, as the distance of the
// middle one from the line through its neighbours over their spacing, for a
// line to start and to be drawn in full. A square corner is about 0.5.
const CREASE_FROM = 0.05
const CREASE_FULL = 0.14
// How far the next thing behind stands, as a share of the distance to the
// near one, for a line to start and to be drawn in full.
const STEP_FROM = 0.015
const STEP_FULL = 0.04

const fragmentShader = /* glsl */ `
uniform vec3 color;
uniform sampler2D lineMap;
uniform bool own;
uniform vec2 focal;
uniform float spread;

// The point a pixel shows, in the camera's own space.
vec3 viewAt(const in vec2 uv, const in float depth) {
  float z = getViewZ(depth);
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * -z / focal.x, ndc.y * -z / focal.y, z);
}

// How far c stands off the line from a to b, over the length of that line.
// Points on one flat surface along a row of pixels lie on a line, so it is
// nothing there and grows where the surface turns.
float bent(const in vec3 a, const in vec3 c, const in vec3 b) {
  vec3 ab = b - a;
  float l = dot(ab, ab);
  return l > 0.0 ? length(cross(c - a, ab)) / l : 0.0;
}

// The line, from 0 to 1, along one direction through the pixel.
float across(const in vec2 uv, const in vec2 dir, const in vec3 c) {
  float da = readDepth(uv - dir);
  float db = readDepth(uv + dir);
  float line = 0.0;
  // A step back to something farther on either side, drawn on this side.
  // The camera looks down its negative z, so farther is more negative.
  float near = -c.z;
  if (da < 1.0) line = max(line, smoothstep(${STEP_FROM}, ${STEP_FULL}, (c.z - getViewZ(da)) / near));
  if (db < 1.0) line = max(line, smoothstep(${STEP_FROM}, ${STEP_FULL}, (c.z - getViewZ(db)) / near));
  // A turn of the surface, only between two pixels that show something.
  if (da < 1.0 && db < 1.0) {
    vec3 a = viewAt(uv - dir, da);
    vec3 b = viewAt(uv + dir, db);
    line = max(line, smoothstep(${CREASE_FROM}, ${CREASE_FULL}, bent(a, c, b)));
  }
  return line;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  // Nothing here, only what is behind the card.
  if (depth >= 1.0) {
    outputColor = inputColor;
    return;
  }
  vec3 c = viewAt(uv, depth);
  float line = max(
    across(uv, vec2(texelSize.x * spread, 0.0), c),
    across(uv, vec2(0.0, texelSize.y * spread), c)
  );
  vec3 ink = own ? texture2D(lineMap, uv).rgb : color;
  outputColor = vec4(mix(inputColor.rgb, ink, line), inputColor.a);
}
`

export class BlueprintEdgesEffect extends Effect {
  private camera: Camera
  private scene: Scene
  // The scene drawn flat in the line colors, and what it is drawn with: the
  // card's color, and nothing at all for what writes no depth.
  private target = new WebGLRenderTarget(1, 1, { type: HalfFloatType })
  private plain: MeshBasicMaterial
  private unseen = new MeshBasicMaterial({ colorWrite: false, depthWrite: false })

  constructor(scene: Scene, camera: Camera, color: string) {
    super('BlueprintEdgesEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['color', new Uniform(new Color(color))],
        ['lineMap', new Uniform(null)],
        ['own', new Uniform(false)],
        ['focal', new Uniform(new Vector2(1, 1))],
        ['spread', new Uniform(1)],
      ]),
    })
    this.scene = scene
    this.camera = camera
    this.plain = new MeshBasicMaterial({ color })
    this.uniforms.get('lineMap')!.value = this.target.texture
  }

  set color(value: string) {
    ;(this.uniforms.get('color')!.value as Color).set(value)
    this.plain.color.set(value)
  }

  // Lines as wide on a sharp screen as on a plain one.
  set pixelRatio(ratio: number) {
    this.uniforms.get('spread')!.value = Math.max(1, Math.round(ratio))
  }

  setSize(width: number, height: number) {
    this.target.setSize(width, height)
  }

  update(renderer: WebGLRenderer, _input: WebGLRenderTarget, _delta?: number) {
    const m = (this.camera as PerspectiveCamera).projectionMatrix.elements
    ;(this.uniforms.get('focal')!.value as Vector2).set(m[0], m[5])
    const own = this.scene.userData[OWN_LINES] === true
    this.uniforms.get('own')!.value = own
    if (own) this.drawLineColors(renderer)
  }

  // The scene drawn flat, each mesh in its line color, with nothing else:
  // no background, no shadows drawn again, every paint put back after.
  private drawLineColors(renderer: WebGLRenderer) {
    const scene = this.scene
    const swapped: [Mesh, Material | Material[]][] = []
    scene.traverseVisible(object => {
      if (!(object instanceof Mesh)) return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      const ink = (object.userData[OWN_LINE] as Material | undefined) ?? this.plain
      swapped.push([object, object.material])
      object.material = materials.every(m => m.depthWrite) ? ink : this.unseen
    })
    const background = scene.background
    const environment = scene.environment
    const shadows = renderer.shadowMap.autoUpdate
    const pending = renderer.shadowMap.needsUpdate
    const before = renderer.getRenderTarget()
    scene.background = null
    scene.environment = null
    renderer.shadowMap.autoUpdate = false
    renderer.shadowMap.needsUpdate = false
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(scene, this.camera)
    renderer.setRenderTarget(before)
    renderer.shadowMap.autoUpdate = shadows
    renderer.shadowMap.needsUpdate = pending
    scene.background = background
    scene.environment = environment
    for (const [mesh, material] of swapped) mesh.material = material
  }

  dispose() {
    this.target.dispose()
    this.plain.dispose()
    this.unseen.dispose()
    super.dispose()
  }
}
