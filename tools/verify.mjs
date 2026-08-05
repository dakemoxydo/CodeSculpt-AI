import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const root = process.cwd();
const python = process.platform === 'win32' ? 'python.exe' : 'python3';
const forge = 'C:/Users/dakem/.codex/skills/img2threejs/forge';
const run = (command, args) => {
  console.log('\n> ' + command + ' ' + args.join(' '));
  execFileSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
};

run('npm.cmd', ['test']);
run('npm.cmd', ['run', 'build']);
run(python, [forge + '/stage1_intake/probe_image.py', '.img2threejs/reference.png']);
run(python, [forge + '/stage1_intake/check_reference_admission.py', '.img2threejs/reference.png']);
run(python, [forge + '/stage2_spec/validate_sculpt_spec.py', 'object-sculpt-spec.json', '--strict-quality']);
run(python, [forge + '/stage4_review/check_part_coverage.py', '--spec', 'object-sculpt-spec.json', '--manifest', 'parts.json', '--inventory', '.img2threejs/detail-inventory.json']);
run(python, [forge + '/stage3_build/orchestrate_passes.py', 'status', 'object-sculpt-spec.json']);
run(python, [forge + '/stage3_build/orchestrate_passes.py', 'check', 'object-sculpt-spec.json', '--pass-id', 'optimization-pass']);

const spec = JSON.parse(readFileSync('object-sculpt-spec.json', 'utf8'));
const generated = readFileSync('src/generatedModel.ts', 'utf8');
const requiredIds = spec.componentTree.map((component) => component.id);
const missing = requiredIds.filter((id) => !generated.includes('"id": "' + id + '"') && !generated.includes('"id":"' + id + '"'));
if (missing.length) throw new Error('generated factory is missing component IDs: ' + missing.join(', '));
if (!generated.includes('root.userData.sculptRuntime')) throw new Error('generated runtime contract is missing sculptRuntime');
if (generated.includes('C:\\\\Users\\\\') || generated.includes('C:/Users/')) throw new Error('generated factory contains an absolute Windows path');
const main = readFileSync('src/main.ts', 'utf8');
if (main.includes('./createObjectModel')) throw new Error('manual model import remains active');
if (!main.includes('./runtimeAdapter')) throw new Error('runtime adapter is not active');

writeFileSync('public/pipeline-status.json', JSON.stringify({
  ready: true,
  pass: 'optimization-pass',
  verifiedAt: new Date().toISOString(),
  componentCount: requiredIds.length,
}, null, 2) + '\n');
console.log('\nVERIFY PASS: TypeScript, Vite, intake, strict spec, coverage, pass orchestration, and runtime contract checks passed.');

