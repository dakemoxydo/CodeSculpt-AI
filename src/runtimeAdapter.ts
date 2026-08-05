import * as THREE from 'three';
import {
  createFuturisticMBTTankModel,
  type ProceduralModelOptions,
  type ProceduralModelRuntime,
} from './generatedModel';

export type ModelRuntime = {
  root: THREE.Group;
  nodes: Record<string, THREE.Object3D>;
  meshes: THREE.Object3D[];
  componentOrder: string[];
  selectedId: string | null;
  setExplode(amount: number): void;
  setWireframe(enabled: boolean): void;
  setSelected(id: string | null): void;
  tick(deltaSeconds: number): void;
  dispose(): void;
};

type SelectableMaterial = THREE.Material & {
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  color?: THREE.Color;
  wireframe?: boolean;
};

type MaterialState = {
  material: SelectableMaterial;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  color?: THREE.Color;
  wireframe?: boolean;
};

const EXPLODE_VECTORS: Record<string, THREE.Vector3> = {
  hull_shell: new THREE.Vector3(0, -0.12, 0),
  track_left: new THREE.Vector3(-1.1, -0.12, 0),
  track_right: new THREE.Vector3(1.1, -0.12, 0),
  turret_shell: new THREE.Vector3(0, 0.65, 0),
  main_barrel: new THREE.Vector3(0, 0.15, -0.85),
  hull_glacis: new THREE.Vector3(0, 0.08, -0.45),
  engine_deck: new THREE.Vector3(0, 0.28, 0.5),
  side_skirts: new THREE.Vector3(0, 0.08, 0),
  mantlet: new THREE.Vector3(0, 0.32, -0.18),
  road_wheels: new THREE.Vector3(0, -0.4, 0),
  track_links: new THREE.Vector3(0, -0.08, 0),
  suspension_rods: new THREE.Vector3(0, -0.2, 0),
  sensor_cluster: new THREE.Vector3(0, 0.85, 0),
  deck_vents: new THREE.Vector3(0, 0.5, 0.45),
  turret_canisters: new THREE.Vector3(0, 0.55, 0.28),
  smoke_launcher_pods: new THREE.Vector3(0, 0.62, 0.1),
  rear_port_modules: new THREE.Vector3(0, 0.42, 0.7),
  front_track_fenders: new THREE.Vector3(0, 0.3, -0.55),
  rear_engine_armor: new THREE.Vector3(0, 0.36, 0.72),
};

function uniqueMeshes(root: THREE.Object3D): THREE.Object3D[] {
  const meshes: THREE.Object3D[] = [];
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh || (object as THREE.InstancedMesh).isInstancedMesh) meshes.push(object);
  });
  return meshes;
}

function componentIdFor(object: THREE.Object3D): string | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    const component = current.userData.sculptComponent as { id?: unknown } | undefined;
    if (component && typeof component.id === 'string') return component.id;
    if (typeof current.userData.componentId === 'string') return current.userData.componentId;
    current = current.parent;
  }
  return null;
}

function setMaterialWireframe(material: SelectableMaterial, enabled: boolean): void {
  if ('wireframe' in material && typeof material.wireframe === 'boolean') material.wireframe = enabled;
}

function setMaterialSelected(material: SelectableMaterial, selected: boolean, base: MaterialState): void {
  if (material.emissive && base.emissive) {
    material.emissive.copy(selected ? new THREE.Color('#9bd67d') : base.emissive);
    if (typeof material.emissiveIntensity === 'number') {
      material.emissiveIntensity = selected ? Math.max(0.7, base.emissiveIntensity ?? 0.15) : (base.emissiveIntensity ?? 0.15);
    }
  } else if (material.color) {
    material.color.set(selected ? '#9bd67d' : '#ffffff');
  }
}

export function createObjectRuntime(options: ProceduralModelOptions = {}): ModelRuntime {
  const root = createFuturisticMBTTankModel({
    textureSize: 1024,
    qualityPriority: 'reference-fidelity',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  const generated = root.userData.sculptRuntime as ProceduralModelRuntime | undefined;
  if (!generated) throw new Error('Generated model did not expose root.userData.sculptRuntime');

  const nodes = generated.nodes;
  const meshes = uniqueMeshes(root);
  const componentOrder = Object.keys(nodes);
  const basePositions = new Map<string, THREE.Vector3>();
  const explodeVectors = new Map<string, THREE.Vector3>();
  const materialStates: MaterialState[] = [];
  const uniqueMaterials = new Set<THREE.Material>();
  let selectedId: string | null = null;
  let explodeAmount = 0;

  for (const id of componentOrder) {
    const node = nodes[id];
    node.userData.componentId = id;
    const component = node.userData.sculptComponent as { name?: string } | undefined;
    node.userData.label = component?.name ?? id;
    basePositions.set(id, node.position.clone());
    explodeVectors.set(id, EXPLODE_VECTORS[id]?.clone() ?? new THREE.Vector3());
  }

  for (const object of meshes) {
    const id = componentIdFor(object);
    if (id) object.userData.componentId = id;
    const rawMaterial = (object as THREE.Mesh).material;
    const materials = Array.isArray(rawMaterial) ? rawMaterial : [rawMaterial];
    const cloned = materials.map((material) => {
      const copy = material.clone() as SelectableMaterial;
      const state: MaterialState = {
        material: copy,
        emissive: copy.emissive?.clone(),
        emissiveIntensity: copy.emissiveIntensity,
        wireframe: copy.wireframe,
      };
      materialStates.push(state);
      uniqueMaterials.add(copy);
      return copy;
    });
    (object as THREE.Mesh).material = Array.isArray(rawMaterial) ? cloned : cloned[0];
  }

  const setExplode = (amount: number): void => {
    explodeAmount = THREE.MathUtils.clamp(amount, 0, 1);
    for (const id of componentOrder) {
      const node = nodes[id];
      const base = basePositions.get(id);
      const vector = explodeVectors.get(id);
      if (base && vector) node.position.copy(base).addScaledVector(vector, explodeAmount);
    }
    root.userData.explodeAmount = explodeAmount;
  };

  const setWireframe = (enabled: boolean): void => {
    for (const state of materialStates) setMaterialWireframe(state.material, enabled);
    root.userData.wireframe = enabled;
  };

  const setSelected = (id: string | null): void => {
    selectedId = id && nodes[id] ? id : null;
    for (const object of meshes) {
      const objectId = componentIdFor(object);
      const rawMaterial = (object as THREE.Mesh).material;
      const materials = Array.isArray(rawMaterial) ? rawMaterial : [rawMaterial];
      for (const material of materials) {
        const state = materialStates.find((entry) => entry.material === material);
        if (state) setMaterialSelected(material as SelectableMaterial, objectId === selectedId, state);
      }
    }
    root.userData.selectedId = selectedId;
  };

  const tick = (deltaSeconds: number): void => {
    root.userData.lastDeltaSeconds = deltaSeconds;
  };

  const dispose = (): void => {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      const rawMaterial = mesh.material;
      const materialList = Array.isArray(rawMaterial) ? rawMaterial : rawMaterial ? [rawMaterial] : [];
      for (const material of materialList) {
        materials.add(material);
        const record = material as THREE.MeshStandardMaterial;
        for (const key of ['map', 'roughnessMap', 'normalMap', 'aoMap', 'bumpMap', 'displacementMap', 'alphaMap', 'emissiveMap', 'metalnessMap']) {
          const texture = record[key as keyof THREE.MeshStandardMaterial] as unknown;
          if (texture instanceof THREE.Texture) textures.add(texture);
        }
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    textures.forEach((texture) => texture.dispose());
    materials.forEach((material) => material.dispose());
    root.clear();
  };

  root.userData.runtimeAdapter = 'generated-factory';
  root.userData.actionReady = true;
  root.userData.sockets = generated.sockets;
  root.userData.colliders = generated.colliders;
  root.userData.destructionGroups = generated.destructionGroups;
  setExplode(0);
  setWireframe(Boolean(options.wireframe));
  setSelected(null);

  return {
    root,
    nodes,
    meshes,
    componentOrder,
    get selectedId() { return selectedId; },
    setExplode,
    setWireframe,
    setSelected,
    tick,
    dispose,
  };
}

