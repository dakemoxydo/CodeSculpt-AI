import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createObjectRuntime, type ModelRuntime } from './runtimeAdapter';
import './styles.css';

const mount = document.querySelector<HTMLDivElement>('#canvas-wrap');
if (!mount) throw new Error('Canvas mount not found');

const scene = new THREE.Scene();
scene.background = new THREE.Color('#202020');
scene.fog = new THREE.Fog('#202020', 18, 34);

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
camera.position.set(-10.8, 7.4, -12.6);
camera.lookAt(0, 1.3, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.86;
mount.appendChild(renderer.domElement);

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environmentTexture = pmrem.fromScene(room, 0.04).texture;
scene.environment = environmentTexture;
room.dispose();
pmrem.dispose();

const ambient = new THREE.HemisphereLight('#c7d2bb', '#162019', 1.25);
scene.add(ambient);
const key = new THREE.DirectionalLight('#e4f0d5', 2.7);
key.position.set(-7, 12, -8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -10;
key.shadow.camera.right = 10;
key.shadow.camera.top = 10;
key.shadow.camera.bottom = -10;
key.shadow.bias = -0.0002;
scene.add(key);
const rim = new THREE.DirectionalLight('#83a8a2', 1.5);
rim.position.set(8, 6, 10);
scene.add(rim);
const lowFill = new THREE.PointLight('#d19c64', 2.8, 18, 2);
lowFill.position.set(-5, 2.5, -7);
scene.add(lowFill);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(22, 64),
  new THREE.MeshStandardMaterial({ color: '#111711', roughness: 0.92, metalness: 0.08 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(32, 32, '#2a3c2a', '#172219');
grid.position.y = -0.19;
const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
gridMaterials.forEach((material) => {
  material.transparent = true;
  material.opacity = 0.3;
});
scene.add(grid);

const runtime: ModelRuntime = createObjectRuntime();
scene.add(runtime.root);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.minDistance = 6.5;
controls.maxDistance = 25;
controls.target.set(0, 1.2, 0);
controls.maxPolarAngle = Math.PI * 0.47;
controls.minPolarAngle = Math.PI * 0.12;

const explodeInput = document.querySelector<HTMLInputElement>('#explode');
const explodeValue = document.querySelector<HTMLOutputElement>('#explode-value');
const resetButton = document.querySelector<HTMLButtonElement>('#reset-view');
const topButton = document.querySelector<HTMLButtonElement>('#top-view');
const frontButton = document.querySelector<HTMLButtonElement>('#front-view');
const sideButton = document.querySelector<HTMLButtonElement>('#side-view');
const orbitToggle = document.querySelector<HTMLInputElement>('#auto-orbit');
const wireframeToggle = document.querySelector<HTMLInputElement>('#wireframe');
const selectedName = document.querySelector<HTMLElement>('#selected-name');
const selectedRole = document.querySelector<HTMLElement>('#selected-role');
const selectedIndex = document.querySelector<HTMLElement>('#selected-index');
const triCount = document.querySelector<HTMLElement>('#tri-count');
const nodeCount = document.querySelector<HTMLElement>('#node-count');
const viewLabel = document.querySelector<HTMLElement>('#view-label');
const fpsLabel = document.querySelector<HTMLElement>('#fps');
const statusChip = document.querySelector<HTMLElement>('#asset-status');

nodeCount && (nodeCount.textContent = String(runtime.componentOrder.length));
const totalTriangles = runtime.meshes.reduce((total, object) => {
  const geometry = (object as THREE.Mesh).geometry;
  const index = geometry?.index;
  return total + (index ? index.count / 3 : (geometry?.attributes.position?.count ?? 0) / 3);
}, 0);
triCount && (triCount.textContent = totalTriangles > 999 ? String(Math.round(totalTriangles / 1000)) + 'K' : String(Math.round(totalTriangles)));

async function updatePipelineStatus(): Promise<void> {
  if (!statusChip) return;
  try {
    const response = await fetch('/pipeline-status.json', { cache: 'no-store' });
    const status = await response.json() as { ready?: boolean; pass?: string };
    const ready = Boolean(status.ready);
    statusChip.classList.toggle('status-chip--ready', ready);
    statusChip.classList.toggle('status-chip--review', !ready);
    statusChip.innerHTML = '<span class="status-dot"></span> ' + (ready ? 'ASSET READY' : 'REVIEW / ' + String(status.pass ?? 'BLOCKOUT').toUpperCase());
  } catch {
    statusChip.classList.add('status-chip--review');
    statusChip.innerHTML = '<span class="status-dot"></span> REVIEW REQUIRED';
  }
}
void updatePipelineStatus();

function updateRangeFill(): void {
  if (!explodeInput) return;
  const percent = Number(explodeInput.value);
  explodeInput.style.background = 'linear-gradient(90deg, var(--olive) 0%, var(--olive) ' + percent + '%, var(--faint) ' + percent + '%, var(--faint) 100%)';
}

function setExplodeFromInput(): void {
  const amount = Number(explodeInput?.value ?? 0);
  runtime.setExplode(amount / 100);
  if (explodeValue) explodeValue.value = String(amount) + '%';
  updateRangeFill();
}

function resetView(): void {
  runtime.setExplode(0);
  if (explodeInput) explodeInput.value = '0';
  setExplodeFromInput();
  controls.target.set(0, 1.2, 0);
  camera.position.set(-10.8, 7.4, -12.6);
  controls.update();
  if (viewLabel) viewLabel.textContent = 'ISOMETRIC / 3-4';
}

explodeInput?.addEventListener('input', setExplodeFromInput);
resetButton?.addEventListener('click', resetView);
topButton?.addEventListener('click', () => {
  controls.target.set(0, 1, 0);
  camera.position.set(0, 18, 0.01);
  controls.update();
  if (viewLabel) viewLabel.textContent = 'ORTHOGRAPHIC / TOP';
});
frontButton?.addEventListener('click', () => {
  controls.target.set(0, 1.3, 0);
  camera.position.set(0, 3.3, -18);
  controls.update();
  if (viewLabel) viewLabel.textContent = 'ORTHOGRAPHIC / FRONT';
});
sideButton?.addEventListener('click', () => {
  controls.target.set(0, 1.3, 0);
  camera.position.set(18, 3.5, 0);
  controls.update();
  if (viewLabel) viewLabel.textContent = 'ORTHOGRAPHIC / SIDE';
});
orbitToggle?.addEventListener('change', () => {
  controls.autoRotate = Boolean(orbitToggle.checked);
  controls.autoRotateSpeed = 0.8;
});
wireframeToggle?.addEventListener('change', () => runtime.setWireframe(Boolean(wireframeToggle.checked)));

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown', (event) => {
  const bounds = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(runtime.meshes, false)[0];
  if (!hit) {
    runtime.setSelected(null);
    updateSelected(null);
    return;
  }
  let target: THREE.Object3D | null = hit.object;
  while (target && !target.userData.componentId) target = target.parent;
  const id = target?.userData.componentId as string | undefined;
  runtime.setSelected(id ?? null);
  updateSelected(id ?? null);
});

function updateSelected(id: string | null): void {
  if (!selectedName || !selectedRole || !selectedIndex) return;
  if (!id) {
    selectedName.textContent = 'Whole assembly';
    selectedRole.textContent = 'root / transformable';
    selectedIndex.textContent = '00';
    return;
  }
  const node = runtime.nodes[id];
  const index = runtime.componentOrder.indexOf(id);
  selectedName.textContent = String(node?.userData.label ?? id);
  selectedRole.textContent = id + ' / explodable node';
  selectedIndex.textContent = String(Math.max(index, 0)).padStart(2, '0');
}

const resize = (): void => {
  const width = mount.clientWidth;
  const height = mount.clientHeight;
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
};
const observer = new ResizeObserver(resize);
observer.observe(mount);
resize();
setExplodeFromInput();

let previous = performance.now();
let frames = 0;
let fpsTime = previous;
function animate(now: number): void {
  const delta = Math.min((now - previous) / 1000, 0.05);
  previous = now;
  frames += 1;
  if (now - fpsTime > 1000) {
    if (fpsLabel) fpsLabel.textContent = String(Math.round(frames / ((now - fpsTime) / 1000))) + ' FPS';
    frames = 0;
    fpsTime = now;
  }
  runtime.tick(delta);
  controls.update(delta);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

window.addEventListener('beforeunload', () => {
  observer.disconnect();
  runtime.dispose();
  floor.geometry.dispose();
  (floor.material as THREE.Material).dispose();
  grid.geometry.dispose();
  gridMaterials.forEach((material) => material.dispose());
  environmentTexture.dispose();
  renderer.dispose();
});

