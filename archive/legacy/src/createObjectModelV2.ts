import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export type ModelRuntime = {
  root: THREE.Group;
  nodes: Record<string, THREE.Group>;
  meshes: THREE.Object3D[];
  componentOrder: string[];
  setExplode: (amount: number) => void;
  setWireframe: (enabled: boolean) => void;
  setSelected: (id: string | null) => void;
  selectedId: () => string | null;
  dispose: () => void;
};

const TAU = Math.PI * 2;

function makeMaterials() {
  const armor = new THREE.MeshPhysicalMaterial({ color: '#4e6040', roughness: 0.72, metalness: 0.2, clearcoat: 0.08, clearcoatRoughness: 0.44 });
  const armorLight = new THREE.MeshPhysicalMaterial({ color: '#71835a', roughness: 0.64, metalness: 0.18, clearcoat: 0.1, clearcoatRoughness: 0.4 });
  const armorEdge = new THREE.MeshPhysicalMaterial({ color: '#87956c', roughness: 0.58, metalness: 0.2 });
  const armorDark = new THREE.MeshPhysicalMaterial({ color: '#2e3a28', roughness: 0.82, metalness: 0.22 });
  const cavity = new THREE.MeshStandardMaterial({ color: '#101615', roughness: 0.96, metalness: 0.08 });
  const metal = new THREE.MeshPhysicalMaterial({ color: '#252c2c', roughness: 0.46, metalness: 0.82, clearcoat: 0.14 });
  const metalLight = new THREE.MeshPhysicalMaterial({ color: '#58615c', roughness: 0.36, metalness: 0.88 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#151918', roughness: 0.94, metalness: 0.04 });
  const glass = new THREE.MeshPhysicalMaterial({ color: '#5d7b7a', roughness: 0.18, metalness: 0.12, transmission: 0.12, transparent: true, opacity: 0.9 });
  const glow = new THREE.MeshStandardMaterial({ color: '#91bbae', emissive: '#457f75', emissiveIntensity: 0.55, roughness: 0.24 });
  return { armor, armorLight, armorEdge, armorDark, cavity, metal, metalLight, rubber, glass, glow };
}

function roundedBox(width: number, height: number, depth: number, radius = 0.08) {
  return new RoundedBoxGeometry(width, height, depth, 3, Math.min(radius, Math.min(width, height, depth) * 0.44));
}

function prism(profile: Array<[number, number]>, depth: number, bevel = 0.035) {
  const shape = new THREE.Shape();
  profile.forEach(([x, y], index) => index === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSegments: 2, bevelSize: bevel, bevelThickness: bevel, curveSegments: 2 });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function cylinder(radius: number, length: number, segments = 16) {
  return new THREE.CylinderGeometry(radius, radius, length, segments, 1, false);
}

function addMesh(group: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, name: string, meshes: THREE.Object3D[]) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.componentId = group.userData.componentId;
  group.add(mesh);
  meshes.push(mesh);
  return mesh;
}

function addInstanced(group: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, count: number, matrices: THREE.Matrix4[], name: string, meshes: THREE.Object3D[]) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.userData.componentId = group.userData.componentId;
  group.add(mesh);
  meshes.push(mesh);
  return mesh;
}

function addCylinder(group: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, name: string, position: [number, number, number], rotation: [number, number, number], meshes: THREE.Object3D[]) {
  const mesh = addMesh(group, geometry, material, name, meshes);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  return mesh;
}

export function createObjectModel(): ModelRuntime {
  const materials = makeMaterials();
  const root = new THREE.Group();
  root.name = 'mbt-01-root';
  root.userData.sculptRuntime = { explodable: true, clickable: true, reference: 'futuristic-mbt-tank', profile: 'generic' };
  const nodes: Record<string, THREE.Group> = {};
  const meshes: THREE.Object3D[] = [];
  const componentOrder: string[] = [];
  let selected: string | null = null;

  function part(id: string, label: string, parent: THREE.Object3D = root, position: [number, number, number] = [0, 0, 0], explode: [number, number, number] = [0, 0, 0]) {
    const group = new THREE.Group();
    group.name = id;
    group.position.set(...position);
    group.userData.componentId = id;
    group.userData.label = label;
    group.userData.basePosition = group.position.clone();
    group.userData.explodeVector = new THREE.Vector3(...explode);
    parent.add(group);
    nodes[id] = group;
    componentOrder.push(id);
    return group;
  }

  function panel(group: THREE.Group, x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material, name: string, meshesRef = meshes) {
    const mesh = addMesh(group, roundedBox(w, h, d, 0.06), material, name, meshesRef);
    mesh.position.set(x, y, z);
    return mesh;
  }

  const hull = part('hull_shell', 'Low armored hull', root, [0, 1.08, 0]);
  addMesh(hull, roundedBox(4.15, 1.28, 7.35, 0.18), materials.armor, 'lower-hull-shell', meshes);
  const upper = addMesh(hull, prism([[-2.04, -0.26], [2.04, -0.26], [1.78, 0.44], [1.26, 0.58], [-1.26, 0.58], [-1.78, 0.44]], 3.58, 0.075), materials.armorLight, 'tapered-upper-deck', meshes);
  upper.position.set(0, 0.62, 0.08);
  const deckSeam = panel(hull, 0, 0.94, -0.02, 4.7, 0.07, 2.62, materials.armorDark, 'deck-central-seam');
  deckSeam.rotation.y = Math.PI / 2;

  const glacis = part('hull_glacis', 'Split angular glacis', hull, [0, 0.02, -2.28], [0, 0, -0.38]);
  addMesh(glacis, prism([[-2.05, -0.43], [2.05, -0.43], [1.7, 0.2], [1.05, 0.42], [-1.05, 0.42], [-1.7, 0.2]], 1.36, 0.065), materials.armorLight, 'glacis-main-wedge', meshes);
  const leftGlacis = addMesh(glacis, prism([[-1.7, -0.2], [-0.08, -0.2], [-0.08, 0.28], [-1.12, 0.38], [-1.7, 0.16]], 0.06, 0.018), materials.armorEdge, 'glacis-left-facet', meshes);
  leftGlacis.position.set(-0.08, 0.04, -0.7);
  const rightGlacis = leftGlacis.clone();
  rightGlacis.name = 'glacis-right-facet';
  rightGlacis.position.x = 0.08;
  rightGlacis.scale.x = -1;
  glacis.add(rightGlacis);
  meshes.push(rightGlacis);
  const centerSpine = panel(glacis, 0, 0.25, -0.68, 0.42, 0.12, 1.32, materials.armorDark, 'glacis-center-spine');
  centerSpine.rotation.x = -0.16;
  for (const side of [-1, 1]) {
    panel(glacis, side * 0.94, 0.22, -0.7, 0.12, 0.1, 0.98, materials.armorDark, 'glacis-seam');
    const light = panel(glacis, side * 1.42, 0.2, -0.72, 0.28, 0.15, 0.1, materials.glow, 'front-status-light');
    light.userData.componentId = glacis.userData.componentId;
  }

  const sideSkirts = part('side_skirts', 'Faceted side armor skirts', root, [0, 1.08, 0], [0, 0.08, 0]);
  for (const side of [-1, 1] as const) {
    const skirt = part(side < 0 ? 'side_skirt_left' : 'side_skirt_right', side < 0 ? 'Left side armor' : 'Right side armor', sideSkirts, [0, 0, 0], [side * 0.46, 0, 0]);
    for (let segment = 0; segment < 5; segment += 1) {
      const z = -2.7 + segment * 1.35;
      panel(skirt, side * 2.28, 0.4, z, 0.3, 0.34, 1.04, materials.armorDark, 'segmented-side-skirt');
    }
    for (let index = 0; index < 7; index += 1) {
      const z = -2.72 + index * 0.9;
      const bolt = addCylinder(skirt, cylinder(0.062, 0.09, 10), materials.metalLight, 'skirt-fastener', [side * 2.43, 0.25, z], [0, 0, Math.PI / 2], meshes);
      bolt.userData.componentId = skirt.userData.componentId;
    }
    for (const z of [-2.35, -0.85, 0.72, 2.08]) {
      const brace = panel(skirt, side * 2.39, 0.34, z, 0.07, 0.42, 0.46, materials.armor, 'skirt-brace');
      brace.rotation.y = side * 0.13;
    }
  }

  const suspension = part('suspension_rods', 'Exposed suspension actuators', root, [0, 0, -0.12], [0, -0.12, -0.18]);
  for (const side of [-1, 1]) {
    for (const z of [-1.78, -0.62, 0.62, 1.78]) {
      const rod = addCylinder(suspension, cylinder(0.075, 0.92, 12), materials.metalLight, 'suspension-actuator', [side * 2.17, 0.47, z], [Math.PI / 2, 0, 0], meshes);
      rod.rotation.z = side * 0.16;
      addCylinder(suspension, cylinder(0.12, 0.18, 12), materials.armorDark, 'suspension-collar', [side * 2.17, 0.47, z - 0.47], [Math.PI / 2, 0, 0], meshes);
    }
  }

  const engine = part('engine_deck', 'Rear engine deck', hull, [0, 0.78, 1.72], [0, 0, 0.45]);
  addMesh(engine, roundedBox(4.7, 0.46, 2.25, 0.08), materials.armor, 'engine-deck-shell', meshes);
  const vents = part('deck_vents', 'Engine ventilation grilles', engine, [0, 0.25, 0.06], [0, 0.08, 0.28]);
  for (const x of [-1.55, -0.92, 0.92, 1.55]) {
    for (let index = 0; index < 4; index += 1) {
      panel(vents, x, 0.02, -0.46 + index * 0.28, 0.18, 0.045, 0.16, materials.cavity, 'deck-vent-slot');
    }
  }
  const rear = part('rear_port_modules', 'Rear access and exhaust modules', engine, [0, -0.08, 1.08], [0, 0, 0.35]);
  for (const x of [-1.42, 0, 1.42]) {
    panel(rear, x, 0, 0, 0.88, 0.42, 0.12, materials.armorDark, 'rear-access-plate');
    panel(rear, x, 0.03, -0.08, 0.58, 0.1, 0.035, materials.glass, 'rear-access-slot');
  }

  function createTrack(id: string, side: -1 | 1) {
    const track = part(id, side < 0 ? 'Left track assembly' : 'Right track assembly', root, [side * 2.66, 0.46, 0], [side * 0.84, -0.1, 0]);
    const trackLinks = part(side < 0 ? 'track_links_left' : 'track_links_right', 'Raised track links', track, [0, 0, 0], [side * 0.22, -0.04, 0]);
    const linkGeo = roundedBox(0.42, 0.2, 0.56, 0.045);
    const matrices: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    const count = 48;
    for (let index = 0; index < count; index += 1) {
      const t = index / count;
      const angle = t * TAU;
      const z = Math.cos(angle) * 3.18;
      const y = 0.52 + Math.sin(angle) * 0.67;
      const tangent = Math.atan2(Math.cos(angle), -Math.sin(angle));
      dummy.position.set(side * 0.22, y, z);
      dummy.rotation.x = tangent;
      dummy.rotation.z = side * 0.05;
      dummy.updateMatrix();
      matrices.push(dummy.matrix.clone());
    }
    addInstanced(trackLinks, linkGeo, materials.rubber, count, matrices, 'raised-track-tread', meshes);
    const wheels = part(side < 0 ? 'road_wheels_left' : 'road_wheels_right', 'Road wheel row', track, [0, 0, 0], [side * 0.3, -0.04, 0]);
    const wheelGeo = cylinder(0.53, 0.36, 20);
    const hubGeo = cylinder(0.19, 0.4, 14);
    for (let index = 0; index < 6; index += 1) {
      const z = -2.66 + index * 1.06;
      addCylinder(wheels, wheelGeo, materials.metal, `road-wheel-${index + 1}`, [side * 0.22, 0.5, z], [0, 0, Math.PI / 2], meshes);
      addCylinder(wheels, cylinder(0.38, 0.4, 20), materials.rubber, `wheel-tire-${index + 1}`, [side * 0.24, 0.5, z], [0, 0, Math.PI / 2], meshes);
      addCylinder(wheels, hubGeo, materials.metalLight, `wheel-hub-${index + 1}`, [side * 0.43, 0.5, z], [0, 0, Math.PI / 2], meshes);
      addCylinder(wheels, cylinder(0.08, 0.43, 12), materials.cavity, `wheel-hub-cap-${index + 1}`, [side * 0.47, 0.5, z], [0, 0, Math.PI / 2], meshes);
    }
    const idler = addCylinder(wheels, cylinder(0.43, 0.36, 18), materials.metal, 'front-idler', [side * 0.22, 0.53, -3.16], [0, 0, Math.PI / 2], meshes);
    const sprocket = addCylinder(wheels, cylinder(0.46, 0.36, 18), materials.metal, 'rear-drive-sprocket', [side * 0.22, 0.53, 3.16], [0, 0, Math.PI / 2], meshes);
    idler.userData.componentId = wheels.userData.componentId;
    sprocket.userData.componentId = wheels.userData.componentId;
    return track;
  }
  createTrack('track_left', -1);
  createTrack('track_right', 1);

  const turret = part('turret_shell', 'Low faceted rotating turret', root, [0, 2.42, -0.26], [0, 1.18, 0]);
  addMesh(turret, prism([[-1.72, -0.48], [1.72, -0.48], [1.5, 0.22], [1.04, 0.48], [-1.04, 0.48], [-1.5, 0.22]], 3.16, 0.095), materials.armor, 'turret-low-faceted-shell', meshes);
  const turretCheeks = addMesh(turret, prism([[-1.5, -0.25], [1.5, -0.25], [1.12, 0.37], [-1.12, 0.37]], 2.56, 0.06), materials.armorLight, 'turret-upper-cheeks', meshes);
  turretCheeks.position.y = 0.12;
  const turretRoof = panel(turret, 0, 0.52, 0.02, 2.46, 0.2, 2.22, materials.armorEdge, 'turret-roof-plate');
  turretRoof.rotation.y = 0.02;
  addCylinder(turret, cylinder(1.56, 0.16, 32), materials.armorDark, 'turret-ring', [0, -0.55, 0], [0, 0, 0], meshes);
  const mantlet = part('mantlet', 'Angular gun mantlet', turret, [0, -0.02, -1.58], [0, 0.12, -0.35]);
  addMesh(mantlet, prism([[-0.82, -0.34], [0.82, -0.34], [0.72, 0.36], [-0.72, 0.36]], 0.62, 0.1), materials.armorDark, 'mantlet-angular-block', meshes);
  panel(mantlet, 0, 0, -0.34, 1.08, 0.5, 0.08, materials.cavity, 'mantlet-shadow');

  const barrel = part('main_barrel', 'Stepped main cannon', turret, [0, 0.03, -2.05], [0, 0, -0.55]);
  addCylinder(barrel, cylinder(0.2, 4.2, 20), materials.metalLight, 'barrel-core', [0, 0, -1.0], [Math.PI / 2, 0, 0], meshes);
  addCylinder(barrel, cylinder(0.34, 0.7, 20), materials.armorDark, 'barrel-base-collar', [0, 0, 0.83], [Math.PI / 2, 0, 0], meshes);
  addCylinder(barrel, cylinder(0.25, 0.3, 20), materials.metal, 'barrel-mid-ring', [0, 0, -1.76], [Math.PI / 2, 0, 0], meshes);
  addCylinder(barrel, cylinder(0.3, 0.62, 20), materials.metal, 'barrel-muzzle', [0, 0, -2.27], [Math.PI / 2, 0, 0], meshes);
  addCylinder(barrel, cylinder(0.16, 0.035, 20), materials.cavity, 'muzzle-bore', [0, 0, -2.6], [Math.PI / 2, 0, 0], meshes);
  const coax = part('coaxial_barrel', 'Coaxial gun', mantlet, [0.52, -0.08, -0.38], [0.2, 0, -0.22]);
  addCylinder(coax, cylinder(0.07, 0.72, 14), materials.metalLight, 'coaxial-gun', [0, 0, -0.36], [Math.PI / 2, 0, 0], meshes);

  const sensors = part('sensor_cluster', 'Asymmetric roof sensor cluster', turret, [0.58, 0.82, 0.12], [0.28, 0.25, 0]);
  panel(sensors, 0, 0, 0, 0.78, 0.42, 0.72, materials.armorDark, 'sensor-housing');
  panel(sensors, 0, 0.05, -0.38, 0.44, 0.18, 0.05, materials.glass, 'sensor-window');
  addCylinder(sensors, cylinder(0.045, 0.64, 10), materials.metalLight, 'sensor-antenna', [0.2, 0.5, 0.1], [0, 0, 0], meshes);
  const hatch = part('commander_hatch', 'Commander hatch', turret, [-0.78, 0.74, 0.2], [-0.25, 0.24, 0]);
  addCylinder(hatch, cylinder(0.42, 0.1, 24), materials.armorDark, 'commander-hatch-ring', [0, 0, 0], [0, 0, 0], meshes);
  panel(hatch, 0, 0.08, 0, 0.48, 0.09, 0.42, materials.armorLight, 'commander-hatch-lid');

  const canisters = part('turret_canisters', 'Twin turret side canisters', turret, [1.58, -0.02, 0.06], [0.5, 0.14, 0]);
  for (const z of [-0.28, 0.28]) {
    addCylinder(canisters, cylinder(0.15, 1.18, 18), materials.metalLight, 'side-canister', [0, z, 0], [Math.PI / 2, 0, 0], meshes);
    addCylinder(canisters, cylinder(0.17, 0.06, 18), materials.metal, 'canister-cap', [0, z, -0.62], [Math.PI / 2, 0, 0], meshes);
    panel(canisters, -0.06, z, 0.18, 0.1, 0.06, 0.16, materials.armorDark, 'canister-bracket');
  }
  const smoke = part('smoke_launcher_pods', 'Smoke launcher pods', turret, [-1.38, 0.18, -0.08], [-0.3, 0.1, 0]);
  for (let index = 0; index < 3; index += 1) addCylinder(smoke, cylinder(0.13, 0.6, 14), materials.metal, 'smoke-pod', [0, (index - 1) * 0.23, 0], [Math.PI / 2, 0, -0.28], meshes);

  nodes[root.name] = root;
  componentOrder.unshift(root.name);
  const originalMaterials = new Map<THREE.Mesh | THREE.InstancedMesh, THREE.Material>();
  meshes.forEach((object) => { if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) originalMaterials.set(object, object.material as THREE.Material); });

  function setExplode(amount: number) {
    const value = THREE.MathUtils.clamp(amount, 0, 1);
    Object.values(nodes).forEach((group) => {
      if (group.userData.basePosition && group.userData.explodeVector) group.position.copy(group.userData.basePosition).addScaledVector(group.userData.explodeVector, value);
    });
  }
  function setWireframe(enabled: boolean) {
    meshes.forEach((object) => {
      const material = object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh ? object.material : null;
      (Array.isArray(material) ? material : [material]).forEach((item) => { if (item && 'wireframe' in item) item.wireframe = enabled; });
    });
  }
  function setSelected(id: string | null) {
    if (selected && nodes[selected]) nodes[selected].userData.selected = false;
    selected = id && nodes[id] ? id : null;
    if (selected) nodes[selected].userData.selected = true;
    meshes.forEach((object) => {
      const material = object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh ? object.material : null;
      const match = Boolean(selected && object.userData.componentId === selected);
      (Array.isArray(material) ? material : [material]).forEach((item) => { if (item && 'emissiveIntensity' in item) item.emissiveIntensity = match ? 0.38 : 0; });
    });
  }
  function dispose() {
    meshes.forEach((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
        object.geometry.dispose();
        const material = object.material;
        (Array.isArray(material) ? material : [material]).forEach((item) => item.dispose());
      }
    });
    void originalMaterials;
  }
  return { root, nodes, meshes, componentOrder, setExplode, setWireframe, setSelected, selectedId: () => selected, dispose };
}
