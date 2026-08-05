import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions): THREE.MeshPhysicalMaterial {
  const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : new THREE.Color(typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F'),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clamp01(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: Math.max(1, readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: Math.max(1, readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clamp01(readLayerNumber(spec.specularIntensity, ['base'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    if (bumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = bumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    if (displacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = displacementScale;
      material.displacementBias = -displacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Futuristic MBT Tank
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createFuturisticMBTTankModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Futuristic MBT Tank";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["armor"] = createSculptMaterial(
    "armor",
    {"id": "armor", "name": "Olive painted armor", "type": "physical", "shaderModel": "MeshPhysicalMaterial / PBR approximation", "qualityTier": "reference-fidelity", "baseColor": "#667952", "color": "#667952", "albedo": {"dominant": "#667952", "secondary": ["#4B5B39", "#7C8F64"]}, "colorVariation": {"palette": ["#667952", "#4B5B39", "#7C8F64"], "pattern": "low-frequency mottled edge variation", "amplitude": 0.12, "heightCorrelation": 0.24}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "stable world/object scale detail"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.3, "role": "broad panel value breakup"}, {"id": "meso", "frequency": 14, "amplitude": 0.16, "role": "seams, vents, and edge relief"}, {"id": "micro", "frequency": 58, "amplitude": 0.06, "role": "grazing-angle roughness breakup"}], "roughness": {"base": 0.68, "variation": 0.16, "map": "independent-armor-roughness"}, "metalness": {"base": 0.28, "variation": 0.05}, "normal": {"pattern": "independent reference-derived height field", "strength": 0.32, "scale": 22, "space": "tangent"}, "bump": {"pattern": "panel-edge micro relief", "amplitude": 0.06, "scale": 18}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.46, "contactShadowBias": 0.32, "notes": "Darken panel seams, track gaps, and attachment sockets."}, "wear": {"edgeWear": 0.18, "scratches": ["sparse directional track-edge scratches"], "chips": ["small corner chips on front armor"]}, "dirt": {"amount": 0.22, "cavityBias": 0.7, "color": "#20251C"}, "localOverrides": [{"id": "armor_dirt", "region": "panel cavities and underside", "dirtAmount": 0.28, "cavityBias": 0.8, "streak": true, "patinaColor": "#34402B", "evidenceRefs": ["rear-three-quarter"]}, {"id": "armor_bevel_wear", "region": "front and turret chamfers", "roughness": 0.46, "colorShift": "#8A9A70", "evidenceRefs": ["front-three-quarter"]}], "referencePbr": {"version": "1.0", "sourceImage": ".img2threejs/reference.png", "extractor": "extract_pbr_evidence.py", "method": "reference crop evidence plus procedural relightable approximation", "verdict": "usable for stylized realtime material response", "hardLimit": "contact-sheet lighting is not inverse-rendered albedo", "usable": true, "confidence": 0.82, "estimatedFidelity": 0.78, "targetThreshold": 0.7, "maps": {"albedo": {"path": ".img2threejs/pbr-evidence/painted-metal_albedo.png", "channel": "albedo"}, "roughness": {"path": ".img2threejs/pbr-evidence/painted-metal_roughness.png", "channel": "roughness"}, "height": {"path": ".img2threejs/pbr-evidence/painted-metal_height.png", "channel": "height"}, "normal": {"path": ".img2threejs/pbr-evidence/painted-metal_normal.png", "channel": "normal"}, "ao": {"path": ".img2threejs/pbr-evidence/painted-metal_ao.png", "channel": "ao"}}}, "notes": "Primary painted composite/metal armor."},
    options
  );
  materialMap["dark-metal"] = createSculptMaterial(
    "dark-metal",
    {"id": "dark-metal", "name": "Gunmetal track hardware", "type": "physical", "shaderModel": "MeshPhysicalMaterial / PBR approximation", "qualityTier": "reference-fidelity", "baseColor": "#24272A", "color": "#24272A", "albedo": {"dominant": "#24272A", "secondary": ["#15191B", "#596166"]}, "colorVariation": {"palette": ["#24272A", "#596166"], "pattern": "low-frequency mottled edge variation", "amplitude": 0.12, "heightCorrelation": 0.24}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "stable world/object scale detail"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.3, "role": "broad panel value breakup"}, {"id": "meso", "frequency": 14, "amplitude": 0.16, "role": "seams, vents, and edge relief"}, {"id": "micro", "frequency": 58, "amplitude": 0.06, "role": "grazing-angle roughness breakup"}], "roughness": {"base": 0.46, "variation": 0.16, "map": "independent-dark-metal-roughness"}, "metalness": {"base": 0.82, "variation": 0.05}, "normal": {"pattern": "independent reference-derived height field", "strength": 0.32, "scale": 22, "space": "tangent"}, "bump": {"pattern": "panel-edge micro relief", "amplitude": 0.06, "scale": 18}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.46, "contactShadowBias": 0.32, "notes": "Darken panel seams, track gaps, and attachment sockets."}, "wear": {"edgeWear": 0.18, "scratches": ["sparse directional track-edge scratches"], "chips": ["small corner chips on front armor"]}, "dirt": {"amount": 0.22, "cavityBias": 0.7, "color": "#20251C"}, "localOverrides": [{"id": "gunmetal_wear", "region": "track crowns and wheel rims", "roughness": 0.31, "colorShift": "#596166", "evidenceRefs": ["side-view"]}], "referencePbr": {"version": "1.0", "sourceImage": ".img2threejs/reference.png", "extractor": "extract_pbr_evidence.py", "method": "reference crop evidence plus procedural relightable approximation", "verdict": "usable for stylized realtime material response", "hardLimit": "contact-sheet lighting is not inverse-rendered albedo", "usable": true, "confidence": 0.82, "estimatedFidelity": 0.78, "targetThreshold": 0.7, "maps": {"albedo": {"path": ".img2threejs/pbr-evidence/painted-metal_albedo.png", "channel": "albedo"}, "roughness": {"path": ".img2threejs/pbr-evidence/painted-metal_roughness.png", "channel": "roughness"}, "height": {"path": ".img2threejs/pbr-evidence/painted-metal_height.png", "channel": "height"}, "normal": {"path": ".img2threejs/pbr-evidence/painted-metal_normal.png", "channel": "normal"}, "ao": {"path": ".img2threejs/pbr-evidence/painted-metal_ao.png", "channel": "ao"}}}, "notes": "Dark metallic tracks, hubs, rods, and barrel rings."},
    options
  );
  materialMap["glass"] = createSculptMaterial(
    "glass",
    {"id": "glass", "name": "Smoked sensor glass", "type": "physical", "shaderModel": "MeshPhysicalMaterial / PBR approximation", "qualityTier": "reference-fidelity", "baseColor": "#5F737A", "color": "#5F737A", "albedo": {"dominant": "#5F737A", "secondary": ["#15191B", "#596166"]}, "colorVariation": {"palette": ["#5F737A", "#596166"], "pattern": "low-frequency mottled edge variation", "amplitude": 0.12, "heightCorrelation": 0.24}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "stable world/object scale detail"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.3, "role": "broad panel value breakup"}, {"id": "meso", "frequency": 14, "amplitude": 0.16, "role": "seams, vents, and edge relief"}, {"id": "micro", "frequency": 58, "amplitude": 0.06, "role": "grazing-angle roughness breakup"}], "roughness": {"base": 0.22, "variation": 0.16, "map": "independent-glass-roughness"}, "metalness": {"base": 0.18, "variation": 0.05}, "normal": {"pattern": "independent reference-derived height field", "strength": 0.32, "scale": 22, "space": "tangent"}, "bump": {"pattern": "panel-edge micro relief", "amplitude": 0.06, "scale": 18}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.46, "contactShadowBias": 0.32, "notes": "Darken panel seams, track gaps, and attachment sockets."}, "wear": {"edgeWear": 0.18, "scratches": ["sparse directional track-edge scratches"], "chips": ["small corner chips on front armor"]}, "dirt": {"amount": 0.22, "cavityBias": 0.7, "color": "#20251C"}, "localOverrides": [{"id": "sensor_gloss", "region": "vision blocks and sensor faces", "roughness": 0.12, "clearcoat": 0.42, "evidenceRefs": ["front-three-quarter", "top-view"]}], "referencePbr": {"version": "1.0", "sourceImage": ".img2threejs/reference.png", "extractor": "extract_pbr_evidence.py", "method": "reference crop evidence plus procedural relightable approximation", "verdict": "usable for stylized realtime material response", "hardLimit": "contact-sheet lighting is not inverse-rendered albedo", "usable": true, "confidence": 0.82, "estimatedFidelity": 0.78, "targetThreshold": 0.7, "maps": {"albedo": {"path": ".img2threejs/pbr-evidence/painted-metal_albedo.png", "channel": "albedo"}, "roughness": {"path": ".img2threejs/pbr-evidence/painted-metal_roughness.png", "channel": "roughness"}, "height": {"path": ".img2threejs/pbr-evidence/painted-metal_height.png", "channel": "height"}, "normal": {"path": ".img2threejs/pbr-evidence/painted-metal_normal.png", "channel": "normal"}, "ao": {"path": ".img2threejs/pbr-evidence/painted-metal_ao.png", "channel": "ao"}}}, "notes": "Cool smoked glass/optical surfaces."},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_hull_shell_0 = null;
  const endpoint_hull_shell_0 = makeAttachmentEndpoint(attachment_hull_shell_0);
  const node_hull_shell_0 = new THREE.Group();
  node_hull_shell_0.name = "Hull shell__pivot";
  if (endpoint_hull_shell_0) {
    node_hull_shell_0.position.copy(endpoint_hull_shell_0.start);
    node_hull_shell_0.rotation.set(0, 0, 0);
    node_hull_shell_0.scale.set(1, 1, 1);
  } else {
    node_hull_shell_0.position.set(0.0, 0.0, 0.0);
    node_hull_shell_0.rotation.set(0.0, 0.0, 0.0);
    node_hull_shell_0.scale.set(1.0, 1.0, 1.0);
  }
  node_hull_shell_0.userData.sculptComponent = {"id": "hull_shell", "name": "Hull shell", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible hull shell has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 8.4, "height": 1.8, "depth": 4.8, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hull-bevel", "front-panel-seam", "engine-deck"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "side-view", "top-view"], "details": [], "fidelityTier": "form-refinement"};
  node_hull_shell_0.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}};
  (nodes["root"] ?? root).add(node_hull_shell_0);
  nodes["hull_shell"] = node_hull_shell_0;
  const mesh_hull_shell_0Geometry = endpoint_hull_shell_0
    ? new THREE.CylinderGeometry(endpoint_hull_shell_0.endRadius, endpoint_hull_shell_0.baseRadius, endpoint_hull_shell_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_hull_shell_0 = new THREE.Mesh(
    mesh_hull_shell_0Geometry,
    materialMap["armor"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hull_shell_0.name = "Hull shell";
  if (endpoint_hull_shell_0) {
    mesh_hull_shell_0.position.copy(endpoint_hull_shell_0.midpoint);
    mesh_hull_shell_0.quaternion.copy(endpoint_hull_shell_0.quaternion);
  }
  mesh_hull_shell_0.castShadow = options.castShadow ?? true;
  mesh_hull_shell_0.receiveShadow = options.receiveShadow ?? true;
  mesh_hull_shell_0.userData.sculptComponent = {"id": "hull_shell", "name": "Hull shell", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible hull shell has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 8.4, "height": 1.8, "depth": 4.8, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hull-bevel", "front-panel-seam", "engine-deck"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "side-view", "top-view"], "details": [], "fidelityTier": "form-refinement"};
  node_hull_shell_0.add(mesh_hull_shell_0);
  meshes["hull_shell"] = mesh_hull_shell_0;
  colliders["hull_shell"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["body"] ??= [];
  destructionGroups["body"].push(node_hull_shell_0);

  const attachment_track_left_1 = {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.369], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view", "frontal-view"]};
  const endpoint_track_left_1 = makeAttachmentEndpoint(attachment_track_left_1);
  const node_track_left_1 = new THREE.Group();
  node_track_left_1.name = "Left track assembly__pivot";
  if (endpoint_track_left_1) {
    node_track_left_1.position.copy(endpoint_track_left_1.start);
    node_track_left_1.rotation.set(0, 0, 0);
    node_track_left_1.scale.set(1, 1, 1);
  } else {
    node_track_left_1.position.set(-2.65, -0.62, 0.0);
    node_track_left_1.rotation.set(0.0, 0.0, 0.0);
    node_track_left_1.scale.set(1.0, 1.0, 1.0);
  }
  node_track_left_1.userData.sculptComponent = {"id": "track_left", "name": "Left track assembly", "level": "macro", "role": "track", "importance": 0.9, "confidence": 0.86, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Visible left track assembly has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.369], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view", "frontal-view"]}, "dimensions": {"width": 8.8, "height": 1.45, "depth": 0.82, "units": "meters", "confidence": 0.84}, "transform": {"position": [-2.65, -0.62, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "track", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "track", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["track-loop-left"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["side-view", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_track_left_1.userData.actionProfile = {"animationRole": "track", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "track", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["hull_shell"] ?? root).add(node_track_left_1);
  nodes["track_left"] = node_track_left_1;
  const mesh_track_left_1Geometry = endpoint_track_left_1
    ? new THREE.CylinderGeometry(endpoint_track_left_1.endRadius, endpoint_track_left_1.baseRadius, endpoint_track_left_1.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_track_left_1 = new THREE.Mesh(
    mesh_track_left_1Geometry,
    materialMap["dark-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_track_left_1.name = "Left track assembly";
  if (endpoint_track_left_1) {
    mesh_track_left_1.position.copy(endpoint_track_left_1.midpoint);
    mesh_track_left_1.quaternion.copy(endpoint_track_left_1.quaternion);
  }
  mesh_track_left_1.castShadow = options.castShadow ?? true;
  mesh_track_left_1.receiveShadow = options.receiveShadow ?? true;
  mesh_track_left_1.userData.sculptComponent = {"id": "track_left", "name": "Left track assembly", "level": "macro", "role": "track", "importance": 0.9, "confidence": 0.86, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Visible left track assembly has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.369], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view", "frontal-view"]}, "dimensions": {"width": 8.8, "height": 1.45, "depth": 0.82, "units": "meters", "confidence": 0.84}, "transform": {"position": [-2.65, -0.62, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "track", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "track", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["track-loop-left"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["side-view", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_track_left_1.add(mesh_track_left_1);
  meshes["track_left"] = mesh_track_left_1;
  colliders["track_left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["track"] ??= [];
  destructionGroups["track"].push(node_track_left_1);

  const attachment_track_right_2 = {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.369], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view", "frontal-view"]};
  const endpoint_track_right_2 = makeAttachmentEndpoint(attachment_track_right_2);
  const node_track_right_2 = new THREE.Group();
  node_track_right_2.name = "Right track assembly__pivot";
  if (endpoint_track_right_2) {
    node_track_right_2.position.copy(endpoint_track_right_2.start);
    node_track_right_2.rotation.set(0, 0, 0);
    node_track_right_2.scale.set(1, 1, 1);
  } else {
    node_track_right_2.position.set(2.65, -0.62, 0.0);
    node_track_right_2.rotation.set(0.0, 0.0, 0.0);
    node_track_right_2.scale.set(1.0, 1.0, 1.0);
  }
  node_track_right_2.userData.sculptComponent = {"id": "track_right", "name": "Right track assembly", "level": "macro", "role": "track", "importance": 0.9, "confidence": 0.86, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Visible right track assembly has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.369], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view", "frontal-view"]}, "dimensions": {"width": 8.8, "height": 1.45, "depth": 0.82, "units": "meters", "confidence": 0.84}, "transform": {"position": [2.65, -0.62, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "track", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "track", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["track-loop-right"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["side-view", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_track_right_2.userData.actionProfile = {"animationRole": "track", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "track", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["hull_shell"] ?? root).add(node_track_right_2);
  nodes["track_right"] = node_track_right_2;
  const mesh_track_right_2Geometry = endpoint_track_right_2
    ? new THREE.CylinderGeometry(endpoint_track_right_2.endRadius, endpoint_track_right_2.baseRadius, endpoint_track_right_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_track_right_2 = new THREE.Mesh(
    mesh_track_right_2Geometry,
    materialMap["dark-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_track_right_2.name = "Right track assembly";
  if (endpoint_track_right_2) {
    mesh_track_right_2.position.copy(endpoint_track_right_2.midpoint);
    mesh_track_right_2.quaternion.copy(endpoint_track_right_2.quaternion);
  }
  mesh_track_right_2.castShadow = options.castShadow ?? true;
  mesh_track_right_2.receiveShadow = options.receiveShadow ?? true;
  mesh_track_right_2.userData.sculptComponent = {"id": "track_right", "name": "Right track assembly", "level": "macro", "role": "track", "importance": 0.9, "confidence": 0.86, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Visible right track assembly has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.369], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view", "frontal-view"]}, "dimensions": {"width": 8.8, "height": 1.45, "depth": 0.82, "units": "meters", "confidence": 0.84}, "transform": {"position": [2.65, -0.62, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "track", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "track", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["track-loop-right"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["side-view", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_track_right_2.add(mesh_track_right_2);
  meshes["track_right"] = mesh_track_right_2;
  colliders["track_right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["track"] ??= [];
  destructionGroups["track"].push(node_track_right_2);

  const attachment_turret_shell_3 = {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 1.575], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "top-view", "frontal-view"]};
  const endpoint_turret_shell_3 = makeAttachmentEndpoint(attachment_turret_shell_3);
  const node_turret_shell_3 = new THREE.Group();
  node_turret_shell_3.name = "Rotating turret shell__pivot";
  if (endpoint_turret_shell_3) {
    node_turret_shell_3.position.copy(endpoint_turret_shell_3.start);
    node_turret_shell_3.rotation.set(0, 0, 0);
    node_turret_shell_3.scale.set(1, 1, 1);
  } else {
    node_turret_shell_3.position.set(0.0, 1.48, -0.18);
    node_turret_shell_3.rotation.set(0.0, 0.0, 0.0);
    node_turret_shell_3.scale.set(1.0, 1.0, 1.0);
  }
  node_turret_shell_3.userData.sculptComponent = {"id": "turret_shell", "name": "Rotating turret shell", "level": "meso", "role": "turret", "importance": 0.72, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Visible rotating turret shell has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 1.575], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "top-view", "frontal-view"]}, "dimensions": {"width": 4.2, "height": 1.25, "depth": 3.5, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 1.48, -0.18], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "turret", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "turret", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["turret-bevel", "turret-ring", "sensor-cluster"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "top-view", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_turret_shell_3.userData.actionProfile = {"animationRole": "turret", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "turret", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["hull_shell"] ?? root).add(node_turret_shell_3);
  nodes["turret_shell"] = node_turret_shell_3;
  const mesh_turret_shell_3Geometry = endpoint_turret_shell_3
    ? new THREE.CylinderGeometry(endpoint_turret_shell_3.endRadius, endpoint_turret_shell_3.baseRadius, endpoint_turret_shell_3.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_turret_shell_3 = new THREE.Mesh(
    mesh_turret_shell_3Geometry,
    materialMap["armor"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_turret_shell_3.name = "Rotating turret shell";
  if (endpoint_turret_shell_3) {
    mesh_turret_shell_3.position.copy(endpoint_turret_shell_3.midpoint);
    mesh_turret_shell_3.quaternion.copy(endpoint_turret_shell_3.quaternion);
  }
  mesh_turret_shell_3.castShadow = options.castShadow ?? true;
  mesh_turret_shell_3.receiveShadow = options.receiveShadow ?? true;
  mesh_turret_shell_3.userData.sculptComponent = {"id": "turret_shell", "name": "Rotating turret shell", "level": "meso", "role": "turret", "importance": 0.72, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Visible rotating turret shell has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 1.575], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "top-view", "frontal-view"]}, "dimensions": {"width": 4.2, "height": 1.25, "depth": 3.5, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 1.48, -0.18], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "turret", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "turret", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["turret-bevel", "turret-ring", "sensor-cluster"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "top-view", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_turret_shell_3.add(mesh_turret_shell_3);
  meshes["turret_shell"] = mesh_turret_shell_3;
  colliders["turret_shell"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["turret"] ??= [];
  destructionGroups["turret"].push(node_turret_shell_3);

  const attachment_main_barrel_4 = {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 2.9699999999999998], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "side-view", "frontal-view"]};
  const endpoint_main_barrel_4 = makeAttachmentEndpoint(attachment_main_barrel_4);
  const node_main_barrel_4 = new THREE.Group();
  node_main_barrel_4.name = "Main stepped barrel__pivot";
  if (endpoint_main_barrel_4) {
    node_main_barrel_4.position.copy(endpoint_main_barrel_4.start);
    node_main_barrel_4.rotation.set(0, 0, 0);
    node_main_barrel_4.scale.set(1, 1, 1);
  } else {
    node_main_barrel_4.position.set(0.0, 1.43, -4.2);
    node_main_barrel_4.rotation.set(0.0, 0.0, 0.0);
    node_main_barrel_4.scale.set(1.0, 1.0, 1.0);
  }
  node_main_barrel_4.userData.sculptComponent = {"id": "main_barrel", "name": "Main stepped barrel", "level": "meso", "role": "barrel", "importance": 0.72, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Visible main stepped barrel has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "turret_shell", "attachment": {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 2.9699999999999998], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "side-view", "frontal-view"]}, "dimensions": {"width": 0.36, "height": 0.36, "depth": 6.6, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 1.43, -4.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "barrel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "barrel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["barrel-rings", "muzzle-bore"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "side-view", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_main_barrel_4.userData.actionProfile = {"animationRole": "barrel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "barrel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["turret_shell"] ?? root).add(node_main_barrel_4);
  nodes["main_barrel"] = node_main_barrel_4;
  const mesh_main_barrel_4Geometry = endpoint_main_barrel_4
    ? new THREE.CylinderGeometry(endpoint_main_barrel_4.endRadius, endpoint_main_barrel_4.baseRadius, endpoint_main_barrel_4.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  const mesh_main_barrel_4 = new THREE.Mesh(
    mesh_main_barrel_4Geometry,
    materialMap["dark-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_barrel_4.name = "Main stepped barrel";
  if (endpoint_main_barrel_4) {
    mesh_main_barrel_4.position.copy(endpoint_main_barrel_4.midpoint);
    mesh_main_barrel_4.quaternion.copy(endpoint_main_barrel_4.quaternion);
  }
  mesh_main_barrel_4.castShadow = options.castShadow ?? true;
  mesh_main_barrel_4.receiveShadow = options.receiveShadow ?? true;
  mesh_main_barrel_4.userData.sculptComponent = {"id": "main_barrel", "name": "Main stepped barrel", "level": "meso", "role": "barrel", "importance": 0.72, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Visible main stepped barrel has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "turret_shell", "attachment": {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 2.9699999999999998], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "side-view", "frontal-view"]}, "dimensions": {"width": 0.36, "height": 0.36, "depth": 6.6, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 1.43, -4.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "barrel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "barrel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["barrel-rings", "muzzle-bore"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "side-view", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_main_barrel_4.add(mesh_main_barrel_4);
  meshes["main_barrel"] = mesh_main_barrel_4;
  colliders["main_barrel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["barrel"] ??= [];
  destructionGroups["barrel"].push(node_main_barrel_4);

  const attachment_hull_glacis_5 = {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 1.71], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "frontal-view"]};
  const endpoint_hull_glacis_5 = makeAttachmentEndpoint(attachment_hull_glacis_5);
  const node_hull_glacis_5 = new THREE.Group();
  node_hull_glacis_5.name = "Wedge glacis armor__pivot";
  if (endpoint_hull_glacis_5) {
    node_hull_glacis_5.position.copy(endpoint_hull_glacis_5.start);
    node_hull_glacis_5.rotation.set(0, 0, 0);
    node_hull_glacis_5.scale.set(1, 1, 1);
  } else {
    node_hull_glacis_5.position.set(0.0, 0.38, -2.6);
    node_hull_glacis_5.rotation.set(0.0, 0.0, 0.0);
    node_hull_glacis_5.scale.set(1.0, 1.0, 1.0);
  }
  node_hull_glacis_5.userData.sculptComponent = {"id": "hull_glacis", "name": "Wedge glacis armor", "level": "meso", "role": "panel", "importance": 0.72, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Visible wedge glacis armor has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 1.71], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "frontal-view"]}, "dimensions": {"width": 4.6, "height": 0.78, "depth": 3.8, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 0.38, -2.6], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["front-panel-seam", "glacis-ridge"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_hull_glacis_5.userData.actionProfile = {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}};
  (nodes["hull_shell"] ?? root).add(node_hull_glacis_5);
  nodes["hull_glacis"] = node_hull_glacis_5;
  const mesh_hull_glacis_5Geometry = endpoint_hull_glacis_5
    ? new THREE.CylinderGeometry(endpoint_hull_glacis_5.endRadius, endpoint_hull_glacis_5.baseRadius, endpoint_hull_glacis_5.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_hull_glacis_5 = new THREE.Mesh(
    mesh_hull_glacis_5Geometry,
    materialMap["armor"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hull_glacis_5.name = "Wedge glacis armor";
  if (endpoint_hull_glacis_5) {
    mesh_hull_glacis_5.position.copy(endpoint_hull_glacis_5.midpoint);
    mesh_hull_glacis_5.quaternion.copy(endpoint_hull_glacis_5.quaternion);
  }
  mesh_hull_glacis_5.castShadow = options.castShadow ?? true;
  mesh_hull_glacis_5.receiveShadow = options.receiveShadow ?? true;
  mesh_hull_glacis_5.userData.sculptComponent = {"id": "hull_glacis", "name": "Wedge glacis armor", "level": "meso", "role": "panel", "importance": 0.72, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Visible wedge glacis armor has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 1.71], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "frontal-view"]}, "dimensions": {"width": 4.6, "height": 0.78, "depth": 3.8, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 0.38, -2.6], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["front-panel-seam", "glacis-ridge"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_hull_glacis_5.add(mesh_hull_glacis_5);
  meshes["hull_glacis"] = mesh_hull_glacis_5;
  colliders["hull_glacis"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["panel"] ??= [];
  destructionGroups["panel"].push(node_hull_glacis_5);

  const attachment_engine_deck_6 = {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.9450000000000001], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["rear-three-quarter", "top-view"]};
  const endpoint_engine_deck_6 = makeAttachmentEndpoint(attachment_engine_deck_6);
  const node_engine_deck_6 = new THREE.Group();
  node_engine_deck_6.name = "Rear engine deck__pivot";
  if (endpoint_engine_deck_6) {
    node_engine_deck_6.position.copy(endpoint_engine_deck_6.start);
    node_engine_deck_6.rotation.set(0, 0, 0);
    node_engine_deck_6.scale.set(1, 1, 1);
  } else {
    node_engine_deck_6.position.set(0.0, 1.12, 2.25);
    node_engine_deck_6.rotation.set(0.0, 0.0, 0.0);
    node_engine_deck_6.scale.set(1.0, 1.0, 1.0);
  }
  node_engine_deck_6.userData.sculptComponent = {"id": "engine_deck", "name": "Rear engine deck", "level": "meso", "role": "panel", "importance": 0.72, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible rear engine deck has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.9450000000000001], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["rear-three-quarter", "top-view"]}, "dimensions": {"width": 4.5, "height": 0.58, "depth": 2.1, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 1.12, 2.25], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["rear-access-seam", "deck-vents"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["rear-three-quarter", "top-view"], "details": [], "fidelityTier": "form-refinement"};
  node_engine_deck_6.userData.actionProfile = {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}};
  (nodes["hull_shell"] ?? root).add(node_engine_deck_6);
  nodes["engine_deck"] = node_engine_deck_6;
  const mesh_engine_deck_6Geometry = endpoint_engine_deck_6
    ? new THREE.CylinderGeometry(endpoint_engine_deck_6.endRadius, endpoint_engine_deck_6.baseRadius, endpoint_engine_deck_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_engine_deck_6 = new THREE.Mesh(
    mesh_engine_deck_6Geometry,
    materialMap["armor"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_engine_deck_6.name = "Rear engine deck";
  if (endpoint_engine_deck_6) {
    mesh_engine_deck_6.position.copy(endpoint_engine_deck_6.midpoint);
    mesh_engine_deck_6.quaternion.copy(endpoint_engine_deck_6.quaternion);
  }
  mesh_engine_deck_6.castShadow = options.castShadow ?? true;
  mesh_engine_deck_6.receiveShadow = options.receiveShadow ?? true;
  mesh_engine_deck_6.userData.sculptComponent = {"id": "engine_deck", "name": "Rear engine deck", "level": "meso", "role": "panel", "importance": 0.72, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible rear engine deck has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.9450000000000001], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["rear-three-quarter", "top-view"]}, "dimensions": {"width": 4.5, "height": 0.58, "depth": 2.1, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 1.12, 2.25], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["rear-access-seam", "deck-vents"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["rear-three-quarter", "top-view"], "details": [], "fidelityTier": "form-refinement"};
  node_engine_deck_6.add(mesh_engine_deck_6);
  meshes["engine_deck"] = mesh_engine_deck_6;
  colliders["engine_deck"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["panel"] ??= [];
  destructionGroups["panel"].push(node_engine_deck_6);

  const attachment_side_skirts_7 = {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.171], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view"]};
  const endpoint_side_skirts_7 = makeAttachmentEndpoint(attachment_side_skirts_7);
  const node_side_skirts_7 = new THREE.Group();
  node_side_skirts_7.name = "Side skirt armor__pivot";
  if (endpoint_side_skirts_7) {
    node_side_skirts_7.position.copy(endpoint_side_skirts_7.start);
    node_side_skirts_7.rotation.set(0, 0, 0);
    node_side_skirts_7.scale.set(1, 1, 1);
  } else {
    node_side_skirts_7.position.set(0.0, 0.1, -2.37);
    node_side_skirts_7.rotation.set(0.0, 0.0, 0.0);
    node_side_skirts_7.scale.set(1.0, 1.0, 1.0);
  }
  node_side_skirts_7.userData.sculptComponent = {"id": "side_skirts", "name": "Side skirt armor", "level": "meso", "role": "panel", "importance": 0.72, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible side skirt armor has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.171], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view"]}, "dimensions": {"width": 7.6, "height": 0.72, "depth": 0.38, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 0.1, -2.37], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["skirt-seams", "skirt-fasteners"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "form-refinement"};
  node_side_skirts_7.userData.actionProfile = {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}};
  (nodes["hull_shell"] ?? root).add(node_side_skirts_7);
  nodes["side_skirts"] = node_side_skirts_7;
  const mesh_side_skirts_7Geometry = endpoint_side_skirts_7
    ? new THREE.CylinderGeometry(endpoint_side_skirts_7.endRadius, endpoint_side_skirts_7.baseRadius, endpoint_side_skirts_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_side_skirts_7 = new THREE.Mesh(
    mesh_side_skirts_7Geometry,
    materialMap["armor"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_side_skirts_7.name = "Side skirt armor";
  if (endpoint_side_skirts_7) {
    mesh_side_skirts_7.position.copy(endpoint_side_skirts_7.midpoint);
    mesh_side_skirts_7.quaternion.copy(endpoint_side_skirts_7.quaternion);
  }
  mesh_side_skirts_7.castShadow = options.castShadow ?? true;
  mesh_side_skirts_7.receiveShadow = options.receiveShadow ?? true;
  mesh_side_skirts_7.userData.sculptComponent = {"id": "side_skirts", "name": "Side skirt armor", "level": "meso", "role": "panel", "importance": 0.72, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible side skirt armor has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.171], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view"]}, "dimensions": {"width": 7.6, "height": 0.72, "depth": 0.38, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 0.1, -2.37], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["skirt-seams", "skirt-fasteners"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "form-refinement"};
  node_side_skirts_7.add(mesh_side_skirts_7);
  meshes["side_skirts"] = mesh_side_skirts_7;
  colliders["side_skirts"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["panel"] ??= [];
  destructionGroups["panel"].push(node_side_skirts_7);

  const attachment_mantlet_8 = {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.36000000000000004], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "frontal-view"]};
  const endpoint_mantlet_8 = makeAttachmentEndpoint(attachment_mantlet_8);
  const node_mantlet_8 = new THREE.Group();
  node_mantlet_8.name = "Gun mantlet__pivot";
  if (endpoint_mantlet_8) {
    node_mantlet_8.position.copy(endpoint_mantlet_8.start);
    node_mantlet_8.rotation.set(0, 0, 0);
    node_mantlet_8.scale.set(1, 1, 1);
  } else {
    node_mantlet_8.position.set(0.0, 1.28, -1.75);
    node_mantlet_8.rotation.set(0.0, 0.0, 0.0);
    node_mantlet_8.scale.set(1.0, 1.0, 1.0);
  }
  node_mantlet_8.userData.sculptComponent = {"id": "mantlet", "name": "Gun mantlet", "level": "meso", "role": "socket", "importance": 0.72, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible gun mantlet has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "turret_shell", "attachment": {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.36000000000000004], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "frontal-view"]}, "dimensions": {"width": 1.2, "height": 0.85, "depth": 0.8, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 1.28, -1.75], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "socket", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "socket", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["mantlet-seam"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_mantlet_8.userData.actionProfile = {"animationRole": "socket", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "socket", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["turret_shell"] ?? root).add(node_mantlet_8);
  nodes["mantlet"] = node_mantlet_8;
  const mesh_mantlet_8Geometry = endpoint_mantlet_8
    ? new THREE.CylinderGeometry(endpoint_mantlet_8.endRadius, endpoint_mantlet_8.baseRadius, endpoint_mantlet_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_mantlet_8 = new THREE.Mesh(
    mesh_mantlet_8Geometry,
    materialMap["armor"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mantlet_8.name = "Gun mantlet";
  if (endpoint_mantlet_8) {
    mesh_mantlet_8.position.copy(endpoint_mantlet_8.midpoint);
    mesh_mantlet_8.quaternion.copy(endpoint_mantlet_8.quaternion);
  }
  mesh_mantlet_8.castShadow = options.castShadow ?? true;
  mesh_mantlet_8.receiveShadow = options.receiveShadow ?? true;
  mesh_mantlet_8.userData.sculptComponent = {"id": "mantlet", "name": "Gun mantlet", "level": "meso", "role": "socket", "importance": 0.72, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible gun mantlet has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "turret_shell", "attachment": {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.36000000000000004], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "frontal-view"]}, "dimensions": {"width": 1.2, "height": 0.85, "depth": 0.8, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 1.28, -1.75], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "socket", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "socket", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["mantlet-seam"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "frontal-view"], "details": [], "fidelityTier": "form-refinement"};
  node_mantlet_8.add(mesh_mantlet_8);
  meshes["mantlet"] = mesh_mantlet_8;
  colliders["mantlet"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["socket"] ??= [];
  destructionGroups["socket"].push(node_mantlet_8);

  const attachment_road_wheels_9 = {"parentId": "track_left", "parentSocket": "track_left-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.29700000000000004], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view"]};
  const endpoint_road_wheels_9 = makeAttachmentEndpoint(attachment_road_wheels_9);
  const node_road_wheels_9 = new THREE.Group();
  node_road_wheels_9.name = "Road wheel row__pivot";
  if (endpoint_road_wheels_9) {
    node_road_wheels_9.position.copy(endpoint_road_wheels_9.start);
    node_road_wheels_9.rotation.set(0, 0, 0);
    node_road_wheels_9.scale.set(1, 1, 1);
  } else {
    node_road_wheels_9.position.set(-2.65, -0.68, 0.0);
    node_road_wheels_9.rotation.set(0.0, 0.0, 0.0);
    node_road_wheels_9.scale.set(1.0, 1.0, 1.0);
  }
  node_road_wheels_9.userData.sculptComponent = {"id": "road_wheels", "name": "Road wheel row", "level": "micro", "role": "wheel", "importance": 0.72, "confidence": 0.86, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Visible road wheel row has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "track_left", "attachment": {"parentId": "track_left", "parentSocket": "track_left-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.29700000000000004], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view"]}, "dimensions": {"width": 7.4, "height": 0.74, "depth": 0.66, "units": "meters", "confidence": 0.84}, "transform": {"position": [-2.65, -0.68, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "wheel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["wheel-cadence", "wheel-hubs"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "form-refinement"};
  node_road_wheels_9.userData.actionProfile = {"animationRole": "wheel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}};
  (nodes["track_left"] ?? root).add(node_road_wheels_9);
  nodes["road_wheels"] = node_road_wheels_9;
  const mesh_road_wheels_9Geometry = endpoint_road_wheels_9
    ? new THREE.CylinderGeometry(endpoint_road_wheels_9.endRadius, endpoint_road_wheels_9.baseRadius, endpoint_road_wheels_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_road_wheels_9 = new THREE.Mesh(
    mesh_road_wheels_9Geometry,
    materialMap["dark-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_road_wheels_9.name = "Road wheel row";
  if (endpoint_road_wheels_9) {
    mesh_road_wheels_9.position.copy(endpoint_road_wheels_9.midpoint);
    mesh_road_wheels_9.quaternion.copy(endpoint_road_wheels_9.quaternion);
  }
  mesh_road_wheels_9.castShadow = options.castShadow ?? true;
  mesh_road_wheels_9.receiveShadow = options.receiveShadow ?? true;
  mesh_road_wheels_9.userData.sculptComponent = {"id": "road_wheels", "name": "Road wheel row", "level": "micro", "role": "wheel", "importance": 0.72, "confidence": 0.86, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Visible road wheel row has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "track_left", "attachment": {"parentId": "track_left", "parentSocket": "track_left-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.29700000000000004], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view"]}, "dimensions": {"width": 7.4, "height": 0.74, "depth": 0.66, "units": "meters", "confidence": 0.84}, "transform": {"position": [-2.65, -0.68, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "wheel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["wheel-cadence", "wheel-hubs"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "form-refinement"};
  node_road_wheels_9.add(mesh_road_wheels_9);
  meshes["road_wheels"] = mesh_road_wheels_9;
  colliders["road_wheels"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel"] ??= [];
  destructionGroups["wheel"].push(node_road_wheels_9);

  const attachment_track_links_10 = {"parentId": "track_left", "parentSocket": "track_left-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.35100000000000003], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view"]};
  const endpoint_track_links_10 = makeAttachmentEndpoint(attachment_track_links_10);
  const node_track_links_10 = new THREE.Group();
  node_track_links_10.name = "Track link belt__pivot";
  if (endpoint_track_links_10) {
    node_track_links_10.position.copy(endpoint_track_links_10.start);
    node_track_links_10.rotation.set(0, 0, 0);
    node_track_links_10.scale.set(1, 1, 1);
  } else {
    node_track_links_10.position.set(-2.65, -1.04, 0.0);
    node_track_links_10.rotation.set(0.0, 0.0, 0.0);
    node_track_links_10.scale.set(1.0, 1.0, 1.0);
  }
  node_track_links_10.userData.sculptComponent = {"id": "track_links", "name": "Track link belt", "level": "micro", "role": "link", "importance": 0.72, "confidence": 0.86, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Visible track link belt has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "track_left", "attachment": {"parentId": "track_left", "parentSocket": "track_left-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.35100000000000003], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view"]}, "dimensions": {"width": 8.6, "height": 0.5, "depth": 0.78, "units": "meters", "confidence": 0.84}, "transform": {"position": [-2.65, -1.04, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "link", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "link", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["track-tread-blocks"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "form-refinement"};
  node_track_links_10.userData.actionProfile = {"animationRole": "link", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "link", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["track_left"] ?? root).add(node_track_links_10);
  nodes["track_links"] = node_track_links_10;
  const mesh_track_links_10Geometry = endpoint_track_links_10
    ? new THREE.CylinderGeometry(endpoint_track_links_10.endRadius, endpoint_track_links_10.baseRadius, endpoint_track_links_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_track_links_10 = new THREE.Mesh(
    mesh_track_links_10Geometry,
    materialMap["dark-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_track_links_10.name = "Track link belt";
  if (endpoint_track_links_10) {
    mesh_track_links_10.position.copy(endpoint_track_links_10.midpoint);
    mesh_track_links_10.quaternion.copy(endpoint_track_links_10.quaternion);
  }
  mesh_track_links_10.castShadow = options.castShadow ?? true;
  mesh_track_links_10.receiveShadow = options.receiveShadow ?? true;
  mesh_track_links_10.userData.sculptComponent = {"id": "track_links", "name": "Track link belt", "level": "micro", "role": "link", "importance": 0.72, "confidence": 0.86, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Visible track link belt has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "track_left", "attachment": {"parentId": "track_left", "parentSocket": "track_left-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.35100000000000003], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["side-view"]}, "dimensions": {"width": 8.6, "height": 0.5, "depth": 0.78, "units": "meters", "confidence": 0.84}, "transform": {"position": [-2.65, -1.04, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "link", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "link", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["track-tread-blocks"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "form-refinement"};
  node_track_links_10.add(mesh_track_links_10);
  meshes["track_links"] = mesh_track_links_10;
  colliders["track_links"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["link"] ??= [];
  destructionGroups["link"].push(node_track_links_10);

  const attachment_suspension_rods_11 = {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.081], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "side-view"]};
  const endpoint_suspension_rods_11 = makeAttachmentEndpoint(attachment_suspension_rods_11);
  const node_suspension_rods_11 = new THREE.Group();
  node_suspension_rods_11.name = "Exposed suspension rods__pivot";
  if (endpoint_suspension_rods_11) {
    node_suspension_rods_11.position.copy(endpoint_suspension_rods_11.start);
    node_suspension_rods_11.rotation.set(0, 0, 0);
    node_suspension_rods_11.scale.set(1, 1, 1);
  } else {
    node_suspension_rods_11.position.set(0.0, 0.58, -1.65);
    node_suspension_rods_11.rotation.set(0.0, 0.0, 0.0);
    node_suspension_rods_11.scale.set(1.0, 1.0, 1.0);
  }
  node_suspension_rods_11.userData.sculptComponent = {"id": "suspension_rods", "name": "Exposed suspension rods", "level": "micro", "role": "tube", "importance": 0.72, "confidence": 0.86, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Visible exposed suspension rods has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.081], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "side-view"]}, "dimensions": {"width": 4.2, "height": 0.18, "depth": 0.18, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 0.58, -1.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "tube", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tube", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["suspension-rods"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "side-view"], "details": [], "fidelityTier": "form-refinement"};
  node_suspension_rods_11.userData.actionProfile = {"animationRole": "tube", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tube", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}};
  (nodes["hull_shell"] ?? root).add(node_suspension_rods_11);
  nodes["suspension_rods"] = node_suspension_rods_11;
  const mesh_suspension_rods_11Geometry = endpoint_suspension_rods_11
    ? new THREE.CylinderGeometry(endpoint_suspension_rods_11.endRadius, endpoint_suspension_rods_11.baseRadius, endpoint_suspension_rods_11.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  const mesh_suspension_rods_11 = new THREE.Mesh(
    mesh_suspension_rods_11Geometry,
    materialMap["dark-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_suspension_rods_11.name = "Exposed suspension rods";
  if (endpoint_suspension_rods_11) {
    mesh_suspension_rods_11.position.copy(endpoint_suspension_rods_11.midpoint);
    mesh_suspension_rods_11.quaternion.copy(endpoint_suspension_rods_11.quaternion);
  }
  mesh_suspension_rods_11.castShadow = options.castShadow ?? true;
  mesh_suspension_rods_11.receiveShadow = options.receiveShadow ?? true;
  mesh_suspension_rods_11.userData.sculptComponent = {"id": "suspension_rods", "name": "Exposed suspension rods", "level": "micro", "role": "tube", "importance": 0.72, "confidence": 0.86, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Visible exposed suspension rods has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.081], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "side-view"]}, "dimensions": {"width": 4.2, "height": 0.18, "depth": 0.18, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 0.58, -1.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "tube", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tube", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["suspension-rods"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "side-view"], "details": [], "fidelityTier": "form-refinement"};
  node_suspension_rods_11.add(mesh_suspension_rods_11);
  meshes["suspension_rods"] = mesh_suspension_rods_11;
  colliders["suspension_rods"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["tube"] ??= [];
  destructionGroups["tube"].push(node_suspension_rods_11);

  const attachment_sensor_cluster_12 = {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.35100000000000003], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["top-view", "front-three-quarter"]};
  const endpoint_sensor_cluster_12 = makeAttachmentEndpoint(attachment_sensor_cluster_12);
  const node_sensor_cluster_12 = new THREE.Group();
  node_sensor_cluster_12.name = "Roof sensor cluster__pivot";
  if (endpoint_sensor_cluster_12) {
    node_sensor_cluster_12.position.copy(endpoint_sensor_cluster_12.start);
    node_sensor_cluster_12.rotation.set(0, 0, 0);
    node_sensor_cluster_12.scale.set(1, 1, 1);
  } else {
    node_sensor_cluster_12.position.set(0.65, 2.14, 0.1);
    node_sensor_cluster_12.rotation.set(0.0, 0.0, 0.0);
    node_sensor_cluster_12.scale.set(1.0, 1.0, 1.0);
  }
  node_sensor_cluster_12.userData.sculptComponent = {"id": "sensor_cluster", "name": "Roof sensor cluster", "level": "micro", "role": "sensor", "importance": 0.72, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible roof sensor cluster has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "turret_shell", "attachment": {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.35100000000000003], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["top-view", "front-three-quarter"]}, "dimensions": {"width": 1.0, "height": 0.45, "depth": 0.78, "units": "meters", "confidence": 0.84}, "transform": {"position": [0.65, 2.14, 0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "sensor", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "sensor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sensor-housings"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["top-view", "front-three-quarter"], "details": [], "fidelityTier": "form-refinement"};
  node_sensor_cluster_12.userData.actionProfile = {"animationRole": "sensor", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "sensor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["turret_shell"] ?? root).add(node_sensor_cluster_12);
  nodes["sensor_cluster"] = node_sensor_cluster_12;
  const mesh_sensor_cluster_12Geometry = endpoint_sensor_cluster_12
    ? new THREE.CylinderGeometry(endpoint_sensor_cluster_12.endRadius, endpoint_sensor_cluster_12.baseRadius, endpoint_sensor_cluster_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_sensor_cluster_12 = new THREE.Mesh(
    mesh_sensor_cluster_12Geometry,
    materialMap["dark-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sensor_cluster_12.name = "Roof sensor cluster";
  if (endpoint_sensor_cluster_12) {
    mesh_sensor_cluster_12.position.copy(endpoint_sensor_cluster_12.midpoint);
    mesh_sensor_cluster_12.quaternion.copy(endpoint_sensor_cluster_12.quaternion);
  }
  mesh_sensor_cluster_12.castShadow = options.castShadow ?? true;
  mesh_sensor_cluster_12.receiveShadow = options.receiveShadow ?? true;
  mesh_sensor_cluster_12.userData.sculptComponent = {"id": "sensor_cluster", "name": "Roof sensor cluster", "level": "micro", "role": "sensor", "importance": 0.72, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible roof sensor cluster has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "turret_shell", "attachment": {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.35100000000000003], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["top-view", "front-three-quarter"]}, "dimensions": {"width": 1.0, "height": 0.45, "depth": 0.78, "units": "meters", "confidence": 0.84}, "transform": {"position": [0.65, 2.14, 0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "sensor", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "sensor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sensor-housings"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["top-view", "front-three-quarter"], "details": [], "fidelityTier": "form-refinement"};
  node_sensor_cluster_12.add(mesh_sensor_cluster_12);
  meshes["sensor_cluster"] = mesh_sensor_cluster_12;
  colliders["sensor_cluster"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sensor"] ??= [];
  destructionGroups["sensor"].push(node_sensor_cluster_12);

  const attachment_deck_vents_13 = {"parentId": "engine_deck", "parentSocket": "engine_deck-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.36000000000000004], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["top-view", "rear-three-quarter"]};
  const endpoint_deck_vents_13 = makeAttachmentEndpoint(attachment_deck_vents_13);
  const node_deck_vents_13 = new THREE.Group();
  node_deck_vents_13.name = "Deck vent fields__pivot";
  if (endpoint_deck_vents_13) {
    node_deck_vents_13.position.copy(endpoint_deck_vents_13.start);
    node_deck_vents_13.rotation.set(0, 0, 0);
    node_deck_vents_13.scale.set(1, 1, 1);
  } else {
    node_deck_vents_13.position.set(0.0, 1.47, 2.05);
    node_deck_vents_13.rotation.set(0.0, 0.0, 0.0);
    node_deck_vents_13.scale.set(1.0, 1.0, 1.0);
  }
  node_deck_vents_13.userData.sculptComponent = {"id": "deck_vents", "name": "Deck vent fields", "level": "micro", "role": "panel", "importance": 0.72, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible deck vent fields has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "engine_deck", "attachment": {"parentId": "engine_deck", "parentSocket": "engine_deck-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.36000000000000004], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["top-view", "rear-three-quarter"]}, "dimensions": {"width": 1.6, "height": 0.12, "depth": 0.8, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 1.47, 2.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["roof-vent-linework"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["top-view", "rear-three-quarter"], "details": [], "fidelityTier": "form-refinement"};
  node_deck_vents_13.userData.actionProfile = {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}};
  (nodes["engine_deck"] ?? root).add(node_deck_vents_13);
  nodes["deck_vents"] = node_deck_vents_13;
  const mesh_deck_vents_13Geometry = endpoint_deck_vents_13
    ? new THREE.CylinderGeometry(endpoint_deck_vents_13.endRadius, endpoint_deck_vents_13.baseRadius, endpoint_deck_vents_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_deck_vents_13 = new THREE.Mesh(
    mesh_deck_vents_13Geometry,
    materialMap["dark-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_deck_vents_13.name = "Deck vent fields";
  if (endpoint_deck_vents_13) {
    mesh_deck_vents_13.position.copy(endpoint_deck_vents_13.midpoint);
    mesh_deck_vents_13.quaternion.copy(endpoint_deck_vents_13.quaternion);
  }
  mesh_deck_vents_13.castShadow = options.castShadow ?? true;
  mesh_deck_vents_13.receiveShadow = options.receiveShadow ?? true;
  mesh_deck_vents_13.userData.sculptComponent = {"id": "deck_vents", "name": "Deck vent fields", "level": "micro", "role": "panel", "importance": 0.72, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible deck vent fields has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "engine_deck", "attachment": {"parentId": "engine_deck", "parentSocket": "engine_deck-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.36000000000000004], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["top-view", "rear-three-quarter"]}, "dimensions": {"width": 1.6, "height": 0.12, "depth": 0.8, "units": "meters", "confidence": 0.84}, "transform": {"position": [0, 1.47, 2.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["roof-vent-linework"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["top-view", "rear-three-quarter"], "details": [], "fidelityTier": "form-refinement"};
  node_deck_vents_13.add(mesh_deck_vents_13);
  meshes["deck_vents"] = mesh_deck_vents_13;
  colliders["deck_vents"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["panel"] ??= [];
  destructionGroups["panel"].push(node_deck_vents_13);

  const attachment_turret_canisters_14 = {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.5175], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "rear-three-quarter"]};
  const endpoint_turret_canisters_14 = makeAttachmentEndpoint(attachment_turret_canisters_14);
  const node_turret_canisters_14 = new THREE.Group();
  node_turret_canisters_14.name = "Turret side canister pair__pivot";
  if (endpoint_turret_canisters_14) {
    node_turret_canisters_14.position.copy(endpoint_turret_canisters_14.start);
    node_turret_canisters_14.rotation.set(0, 0, 0);
    node_turret_canisters_14.scale.set(1, 1, 1);
  } else {
    node_turret_canisters_14.position.set(1.84, 1.68, 0.05);
    node_turret_canisters_14.rotation.set(0.0, 0.0, 0.0);
    node_turret_canisters_14.scale.set(1.0, 1.0, 1.0);
  }
  node_turret_canisters_14.userData.sculptComponent = {"id": "turret_canisters", "name": "Turret side canister pair", "level": "micro", "role": "connector", "importance": 0.72, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Visible turret side canister pair has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "turret_shell", "attachment": {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.5175], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "rear-three-quarter"]}, "dimensions": {"width": 0.32, "height": 0.62, "depth": 1.15, "units": "meters", "confidence": 0.84}, "transform": {"position": [1.84, 1.68, 0.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["canister-ports", "canister-gloss"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "rear-three-quarter"], "details": [], "fidelityTier": "form-refinement"};
  node_turret_canisters_14.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["turret_shell"] ?? root).add(node_turret_canisters_14);
  nodes["turret_canisters"] = node_turret_canisters_14;
  const mesh_turret_canisters_14Geometry = endpoint_turret_canisters_14
    ? new THREE.CylinderGeometry(endpoint_turret_canisters_14.endRadius, endpoint_turret_canisters_14.baseRadius, endpoint_turret_canisters_14.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  const mesh_turret_canisters_14 = new THREE.Mesh(
    mesh_turret_canisters_14Geometry,
    materialMap["dark-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_turret_canisters_14.name = "Turret side canister pair";
  if (endpoint_turret_canisters_14) {
    mesh_turret_canisters_14.position.copy(endpoint_turret_canisters_14.midpoint);
    mesh_turret_canisters_14.quaternion.copy(endpoint_turret_canisters_14.quaternion);
  }
  mesh_turret_canisters_14.castShadow = options.castShadow ?? true;
  mesh_turret_canisters_14.receiveShadow = options.receiveShadow ?? true;
  mesh_turret_canisters_14.userData.sculptComponent = {"id": "turret_canisters", "name": "Turret side canister pair", "level": "micro", "role": "connector", "importance": 0.72, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Visible turret side canister pair has discrete hard faces and a bounded rigid volume in the reference views.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "turret_shell", "attachment": {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.5175], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "rear-three-quarter"]}, "dimensions": {"width": 0.32, "height": 0.62, "depth": 1.15, "units": "meters", "confidence": 0.84}, "transform": {"position": [1.84, 1.68, 0.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "dark-metal", "materialLayers": ["dark-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["canister-ports", "canister-gloss"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 39, 42, 1.0)", "secondaryAlbedo": "rgba(16, 18, 20, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 39, 42, 1.0)"}, {"position": 1, "color": "rgba(16, 18, 20, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "rear-three-quarter"], "details": [], "fidelityTier": "form-refinement"};
  node_turret_canisters_14.add(mesh_turret_canisters_14);
  meshes["turret_canisters"] = mesh_turret_canisters_14;
  colliders["turret_canisters"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["connector"] ??= [];
  destructionGroups["connector"].push(node_turret_canisters_14);

  const attachment_smoke_launcher_pods_15 = {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "rear-three-quarter"]};
  const endpoint_smoke_launcher_pods_15 = makeAttachmentEndpoint(attachment_smoke_launcher_pods_15);
  const node_smoke_launcher_pods_15 = new THREE.Group();
  node_smoke_launcher_pods_15.name = "Smoke launcher pods__pivot";
  if (endpoint_smoke_launcher_pods_15) {
    node_smoke_launcher_pods_15.position.copy(endpoint_smoke_launcher_pods_15.start);
    node_smoke_launcher_pods_15.rotation.set(0, 0, 0);
    node_smoke_launcher_pods_15.scale.set(1, 1, 1);
  } else {
    node_smoke_launcher_pods_15.position.set(1.35, 1.72, -0.1);
    node_smoke_launcher_pods_15.rotation.set(0.0, 0.0, 0.0);
    node_smoke_launcher_pods_15.scale.set(1.0, 1.0, 1.0);
  }
  node_smoke_launcher_pods_15.userData.sculptComponent = {"id": "smoke_launcher_pods", "name": "Smoke launcher pods", "level": "meso", "role": "panel", "importance": 0.68, "confidence": 0.74, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The visible smoke launcher pods is a separate shallow armored module attached to the hull.", "geometryDescriptor": {"topologyIntent": "shallow rigid armor module", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "turret_shell", "attachment": {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "rear-three-quarter"]}, "dimensions": {"width": 0.92, "height": 0.42, "depth": 0.38, "units": "meters", "confidence": 0.74}, "transform": {"position": [1.35, 1.72, -0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "smoke_launcher_pods", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["smoke_launcher_pods-seam"], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.2, "bumpAmplitude": 0.06}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "rear-three-quarter"], "details": [], "fidelityTier": "structural-pass"};
  node_smoke_launcher_pods_15.userData.actionProfile = {"animationRole": "detachable-panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "smoke_launcher_pods", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["turret_shell"] ?? root).add(node_smoke_launcher_pods_15);
  nodes["smoke_launcher_pods"] = node_smoke_launcher_pods_15;
  const mesh_smoke_launcher_pods_15Geometry = endpoint_smoke_launcher_pods_15
    ? new THREE.CylinderGeometry(endpoint_smoke_launcher_pods_15.endRadius, endpoint_smoke_launcher_pods_15.baseRadius, endpoint_smoke_launcher_pods_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_smoke_launcher_pods_15 = new THREE.Mesh(
    mesh_smoke_launcher_pods_15Geometry,
    materialMap["armor"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_smoke_launcher_pods_15.name = "Smoke launcher pods";
  if (endpoint_smoke_launcher_pods_15) {
    mesh_smoke_launcher_pods_15.position.copy(endpoint_smoke_launcher_pods_15.midpoint);
    mesh_smoke_launcher_pods_15.quaternion.copy(endpoint_smoke_launcher_pods_15.quaternion);
  }
  mesh_smoke_launcher_pods_15.castShadow = options.castShadow ?? true;
  mesh_smoke_launcher_pods_15.receiveShadow = options.receiveShadow ?? true;
  mesh_smoke_launcher_pods_15.userData.sculptComponent = {"id": "smoke_launcher_pods", "name": "Smoke launcher pods", "level": "meso", "role": "panel", "importance": 0.68, "confidence": 0.74, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The visible smoke launcher pods is a separate shallow armored module attached to the hull.", "geometryDescriptor": {"topologyIntent": "shallow rigid armor module", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "turret_shell", "attachment": {"parentId": "turret_shell", "parentSocket": "turret_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "rear-three-quarter"]}, "dimensions": {"width": 0.92, "height": 0.42, "depth": 0.38, "units": "meters", "confidence": 0.74}, "transform": {"position": [1.35, 1.72, -0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "smoke_launcher_pods", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["smoke_launcher_pods-seam"], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.2, "bumpAmplitude": 0.06}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "rear-three-quarter"], "details": [], "fidelityTier": "structural-pass"};
  node_smoke_launcher_pods_15.add(mesh_smoke_launcher_pods_15);
  meshes["smoke_launcher_pods"] = mesh_smoke_launcher_pods_15;
  colliders["smoke_launcher_pods"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["smoke_launcher_pods"] ??= [];
  destructionGroups["smoke_launcher_pods"].push(node_smoke_launcher_pods_15);

  const attachment_rear_port_modules_16 = {"parentId": "engine_deck", "parentSocket": "engine_deck-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["rear-three-quarter", "top-view"]};
  const endpoint_rear_port_modules_16 = makeAttachmentEndpoint(attachment_rear_port_modules_16);
  const node_rear_port_modules_16 = new THREE.Group();
  node_rear_port_modules_16.name = "Rear port modules__pivot";
  if (endpoint_rear_port_modules_16) {
    node_rear_port_modules_16.position.copy(endpoint_rear_port_modules_16.start);
    node_rear_port_modules_16.rotation.set(0, 0, 0);
    node_rear_port_modules_16.scale.set(1, 1, 1);
  } else {
    node_rear_port_modules_16.position.set(0.0, 1.25, 2.9);
    node_rear_port_modules_16.rotation.set(0.0, 0.0, 0.0);
    node_rear_port_modules_16.scale.set(1.0, 1.0, 1.0);
  }
  node_rear_port_modules_16.userData.sculptComponent = {"id": "rear_port_modules", "name": "Rear port modules", "level": "meso", "role": "panel", "importance": 0.68, "confidence": 0.74, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The visible rear port modules is a separate shallow armored module attached to the hull.", "geometryDescriptor": {"topologyIntent": "shallow rigid armor module", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "engine_deck", "attachment": {"parentId": "engine_deck", "parentSocket": "engine_deck-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["rear-three-quarter", "top-view"]}, "dimensions": {"width": 0.92, "height": 0.42, "depth": 0.38, "units": "meters", "confidence": 0.74}, "transform": {"position": [0, 1.25, 2.9], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "rear_port_modules", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["rear_port_modules-seam"], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.2, "bumpAmplitude": 0.06}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["rear-three-quarter", "top-view"], "details": [], "fidelityTier": "structural-pass"};
  node_rear_port_modules_16.userData.actionProfile = {"animationRole": "detachable-panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "rear_port_modules", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["engine_deck"] ?? root).add(node_rear_port_modules_16);
  nodes["rear_port_modules"] = node_rear_port_modules_16;
  const mesh_rear_port_modules_16Geometry = endpoint_rear_port_modules_16
    ? new THREE.CylinderGeometry(endpoint_rear_port_modules_16.endRadius, endpoint_rear_port_modules_16.baseRadius, endpoint_rear_port_modules_16.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_port_modules_16 = new THREE.Mesh(
    mesh_rear_port_modules_16Geometry,
    materialMap["armor"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_port_modules_16.name = "Rear port modules";
  if (endpoint_rear_port_modules_16) {
    mesh_rear_port_modules_16.position.copy(endpoint_rear_port_modules_16.midpoint);
    mesh_rear_port_modules_16.quaternion.copy(endpoint_rear_port_modules_16.quaternion);
  }
  mesh_rear_port_modules_16.castShadow = options.castShadow ?? true;
  mesh_rear_port_modules_16.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_port_modules_16.userData.sculptComponent = {"id": "rear_port_modules", "name": "Rear port modules", "level": "meso", "role": "panel", "importance": 0.68, "confidence": 0.74, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The visible rear port modules is a separate shallow armored module attached to the hull.", "geometryDescriptor": {"topologyIntent": "shallow rigid armor module", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "engine_deck", "attachment": {"parentId": "engine_deck", "parentSocket": "engine_deck-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["rear-three-quarter", "top-view"]}, "dimensions": {"width": 0.92, "height": 0.42, "depth": 0.38, "units": "meters", "confidence": 0.74}, "transform": {"position": [0, 1.25, 2.9], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "rear_port_modules", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["rear_port_modules-seam"], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.2, "bumpAmplitude": 0.06}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["rear-three-quarter", "top-view"], "details": [], "fidelityTier": "structural-pass"};
  node_rear_port_modules_16.add(mesh_rear_port_modules_16);
  meshes["rear_port_modules"] = mesh_rear_port_modules_16;
  colliders["rear_port_modules"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rear_port_modules"] ??= [];
  destructionGroups["rear_port_modules"].push(node_rear_port_modules_16);

  const attachment_front_track_fenders_17 = {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "frontal-view"]};
  const endpoint_front_track_fenders_17 = makeAttachmentEndpoint(attachment_front_track_fenders_17);
  const node_front_track_fenders_17 = new THREE.Group();
  node_front_track_fenders_17.name = "Front track fender blocks__pivot";
  if (endpoint_front_track_fenders_17) {
    node_front_track_fenders_17.position.copy(endpoint_front_track_fenders_17.start);
    node_front_track_fenders_17.rotation.set(0, 0, 0);
    node_front_track_fenders_17.scale.set(1, 1, 1);
  } else {
    node_front_track_fenders_17.position.set(-3.35, 0.18, -1.95);
    node_front_track_fenders_17.rotation.set(0.0, 0.0, 0.0);
    node_front_track_fenders_17.scale.set(1.0, 1.0, 1.0);
  }
  node_front_track_fenders_17.userData.sculptComponent = {"id": "front_track_fenders", "name": "Front track fender blocks", "level": "meso", "role": "fender", "importance": 0.68, "confidence": 0.74, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The visible front track fender blocks is a separate shallow rigid armor module attached to the hull.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "frontal-view"]}, "dimensions": {"width": 1.1, "height": 0.62, "depth": 1.1, "units": "meters", "confidence": 0.74}, "transform": {"position": [-3.35, 0.18, -1.95], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "fender", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "front_track_fenders", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["front_track_fenders-seam", "front_track_fenders-chamfer"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "frontal-view"], "details": [], "fidelityTier": "structural-pass"};
  node_front_track_fenders_17.userData.actionProfile = {"animationRole": "fender", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "front_track_fenders", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["hull_shell"] ?? root).add(node_front_track_fenders_17);
  nodes["front_track_fenders"] = node_front_track_fenders_17;
  const mesh_front_track_fenders_17Geometry = endpoint_front_track_fenders_17
    ? new THREE.CylinderGeometry(endpoint_front_track_fenders_17.endRadius, endpoint_front_track_fenders_17.baseRadius, endpoint_front_track_fenders_17.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_track_fenders_17 = new THREE.Mesh(
    mesh_front_track_fenders_17Geometry,
    materialMap["armor"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_track_fenders_17.name = "Front track fender blocks";
  if (endpoint_front_track_fenders_17) {
    mesh_front_track_fenders_17.position.copy(endpoint_front_track_fenders_17.midpoint);
    mesh_front_track_fenders_17.quaternion.copy(endpoint_front_track_fenders_17.quaternion);
  }
  mesh_front_track_fenders_17.castShadow = options.castShadow ?? true;
  mesh_front_track_fenders_17.receiveShadow = options.receiveShadow ?? true;
  mesh_front_track_fenders_17.userData.sculptComponent = {"id": "front_track_fenders", "name": "Front track fender blocks", "level": "meso", "role": "fender", "importance": 0.68, "confidence": 0.74, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The visible front track fender blocks is a separate shallow rigid armor module attached to the hull.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["front-three-quarter", "frontal-view"]}, "dimensions": {"width": 1.1, "height": 0.62, "depth": 1.1, "units": "meters", "confidence": 0.74}, "transform": {"position": [-3.35, 0.18, -1.95], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "fender", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "front_track_fenders", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["front_track_fenders-seam", "front_track_fenders-chamfer"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["front-three-quarter", "frontal-view"], "details": [], "fidelityTier": "structural-pass"};
  node_front_track_fenders_17.add(mesh_front_track_fenders_17);
  meshes["front_track_fenders"] = mesh_front_track_fenders_17;
  colliders["front_track_fenders"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["front_track_fenders"] ??= [];
  destructionGroups["front_track_fenders"].push(node_front_track_fenders_17);

  const attachment_rear_engine_armor_18 = {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["rear-three-quarter", "top-view"]};
  const endpoint_rear_engine_armor_18 = makeAttachmentEndpoint(attachment_rear_engine_armor_18);
  const node_rear_engine_armor_18 = new THREE.Group();
  node_rear_engine_armor_18.name = "Rear engine armor blocks__pivot";
  if (endpoint_rear_engine_armor_18) {
    node_rear_engine_armor_18.position.copy(endpoint_rear_engine_armor_18.start);
    node_rear_engine_armor_18.rotation.set(0, 0, 0);
    node_rear_engine_armor_18.scale.set(1, 1, 1);
  } else {
    node_rear_engine_armor_18.position.set(3.15, 0.24, 1.95);
    node_rear_engine_armor_18.rotation.set(0.0, 0.0, 0.0);
    node_rear_engine_armor_18.scale.set(1.0, 1.0, 1.0);
  }
  node_rear_engine_armor_18.userData.sculptComponent = {"id": "rear_engine_armor", "name": "Rear engine armor blocks", "level": "meso", "role": "armor-block", "importance": 0.68, "confidence": 0.74, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The visible rear engine armor blocks is a separate shallow rigid armor module attached to the hull.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["rear-three-quarter", "top-view"]}, "dimensions": {"width": 1.1, "height": 0.62, "depth": 1.1, "units": "meters", "confidence": 0.74}, "transform": {"position": [3.15, 0.24, 1.95], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "armor-block", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "rear_engine_armor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["rear_engine_armor-seam", "rear_engine_armor-chamfer"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["rear-three-quarter", "top-view"], "details": [], "fidelityTier": "structural-pass"};
  node_rear_engine_armor_18.userData.actionProfile = {"animationRole": "armor-block", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "rear_engine_armor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}};
  (nodes["hull_shell"] ?? root).add(node_rear_engine_armor_18);
  nodes["rear_engine_armor"] = node_rear_engine_armor_18;
  const mesh_rear_engine_armor_18Geometry = endpoint_rear_engine_armor_18
    ? new THREE.CylinderGeometry(endpoint_rear_engine_armor_18.endRadius, endpoint_rear_engine_armor_18.baseRadius, endpoint_rear_engine_armor_18.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_engine_armor_18 = new THREE.Mesh(
    mesh_rear_engine_armor_18Geometry,
    materialMap["armor"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_engine_armor_18.name = "Rear engine armor blocks";
  if (endpoint_rear_engine_armor_18) {
    mesh_rear_engine_armor_18.position.copy(endpoint_rear_engine_armor_18.midpoint);
    mesh_rear_engine_armor_18.quaternion.copy(endpoint_rear_engine_armor_18.quaternion);
  }
  mesh_rear_engine_armor_18.castShadow = options.castShadow ?? true;
  mesh_rear_engine_armor_18.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_engine_armor_18.userData.sculptComponent = {"id": "rear_engine_armor", "name": "Rear engine armor blocks", "level": "meso", "role": "armor-block", "importance": 0.68, "confidence": 0.74, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The visible rear engine armor blocks is a separate shallow rigid armor module attached to the hull.", "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "hull_shell", "attachment": {"parentId": "hull_shell", "parentSocket": "hull_shell-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["rear-three-quarter", "top-view"]}, "dimensions": {"width": 1.1, "height": 0.62, "depth": 1.1, "units": "meters", "confidence": 0.74}, "transform": {"position": [3.15, 0.24, 1.95], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "armor-block", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "rear_engine_armor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}}, "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["rear_engine_armor-seam", "rear_engine_armor-chamfer"], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": ["rear-three-quarter", "top-view"], "details": [], "fidelityTier": "structural-pass"};
  node_rear_engine_armor_18.add(mesh_rear_engine_armor_18);
  meshes["rear_engine_armor"] = mesh_rear_engine_armor_18;
  colliders["rear_engine_armor"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rear_engine_armor"] ??= [];
  destructionGroups["rear_engine_armor"].push(node_rear_engine_armor_18);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"minimumTextureResolution": 1024, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7}}, "neutralLight": "readable under neutral turntable light", "grazingLight": "bevels and panel relief must break highlights", "referenceLight": "olive armor and dark hardware separation preserved"};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createFuturisticMBTTankLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Futuristic MBT Tank look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = ["Key: large soft neutral source from upper front-left, 3.2 intensity, grazing across armor chamfers.", "Fill: cool low-level environment from camera-right, 0.7 intensity, preserves dark track cavities.", "Rim: narrow cool back light from upper rear, 2.0 intensity, separates turret and engine deck silhouette.", "Exposure 1.05 with ACES filmic tone mapping and restrained contrast.", "Contact shadow: soft ground shadow and ambient occlusion inside track loops, under skirts, and at turret ring."];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"minimumTextureResolution": 1024, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7}}, "neutralLight": "readable under neutral turntable light", "grazingLight": "bevels and panel relief must break highlights", "referenceLight": "olive armor and dark hardware separation preserved"};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createFuturisticMBTTankEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameFuturisticMBTTankCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createFuturisticMBTTankPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureFuturisticMBTTankRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createFuturisticMBTTankInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
