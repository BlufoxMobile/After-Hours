// Shared LOOKDEV STAGE for agents testing a model/effect before gfx.js/world.js exist.
// Approximates the game's look: dark navy store at night, IBL, ACES, bloom, gameplay camera.
// usage (in a harness entry):  import { makeStage } from '../../tools/stage.js';
//   const st = makeStage({ camera: 'game' | 'close', target: [0,0.6,0] });
//   st.scene.add(myObj); window.__step = (t) => { ...pose...; st.render(); };
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function makeStage(opts = {}) {
  const el = document.getElementById('app') || document.body;
  const r = new THREE.WebGLRenderer({ antialias: true });
  r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  r.setSize(innerWidth, innerHeight);
  r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
  r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
  el.appendChild(r.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b1a);
  scene.fog = new THREE.Fog(0x070b1a, 22, 48);
  const pm = new THREE.PMREMGenerator(r);
  const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env; scene.environmentIntensity = 0.35;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x141b33, roughness: 0.35, metalness: 0.2 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(40, 20, 0x2a3566, 0x1a2244); grid.position.y = 0.002; scene.add(grid);
  scene.add(new THREE.HemisphereLight(0x6f86ff, 0x120a22, 0.6));
  const key = new THREE.DirectionalLight(0xdfe6ff, 1.6); key.position.set(4, 10, 6); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 });
  scene.add(key);
  const rim1 = new THREE.PointLight(0xff3ec8, 12, 14); rim1.position.set(-5, 3, -4); scene.add(rim1);
  const rim2 = new THREE.PointLight(0x3ee8ff, 12, 14); rim2.position.set(5, 3, -3); scene.add(rim2);
  const cam = new THREE.PerspectiveCamera(opts.fov || 40, innerWidth / innerHeight, 0.1, 100);
  const tgt = new THREE.Vector3(...(opts.target || [0, 0.5, 0]));
  if (opts.camera === 'close') cam.position.set(tgt.x + 0, tgt.y + 1.6, tgt.z + 4.2);
  else { // gameplay framing: ~57deg pitch, ~10.5 m wide in portrait
    const pitch = 57 * Math.PI / 180, dist = opts.dist || 22;
    cam.position.set(tgt.x, tgt.y + Math.sin(pitch) * dist, tgt.z + Math.cos(pitch) * dist);
  }
  cam.lookAt(tgt);
  const comp = new EffectComposer(r);
  comp.addPass(new RenderPass(scene, cam));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.5, 0.9);
  comp.addPass(bloom); comp.addPass(new OutputPass());
  return { renderer: r, scene, camera: cam, bloom, env, key, render: () => comp.render(), THREE };
}
