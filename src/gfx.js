// =====================================================================================
// AFTER HOURS 3D — gfx.js (WORLD agent)
// Renderer, camera rig, post chain (MSAA HDR → bloom → grade/tonemap/vignette), quality
// tiers + frame-pacing watchdog, fitted/texel-snapped key-light shadows.
// =====================================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ROOM } from './layout.js';

// ---------------------------------------------------------------------------- tiers
// pr = pixel-ratio cap, px = max rendered pixels, msaa = HDR target samples,
// bloom = bloom on / resolution scale (UnrealBloom already works at 1/2 res internally),
// shadow = key-light shadow map size (0 = none; FX draws blob contact shadows regardless).
const TIERS = [
  { pr: 1.0,  px: 0.9e6, post: false, msaa: 0, bloom: 0,    shadow: 0,    pointLights: false },
  { pr: 1.25, px: 1.5e6, post: true,  msaa: 4, bloom: 0.5,  shadow: 1024, pointLights: true },
  { pr: 1.6,  px: 2.6e6, post: true,  msaa: 4, bloom: 1.0,  shadow: 1024, pointLights: true },
  { pr: 2.0,  px: 4.4e6, post: true,  msaa: 4, bloom: 1.0,  shadow: 2048, pointLights: true },
];

// ---------------------------------------------------------------------------- bloom (no final blend)
// UnrealBloom that stops after compositing its mips: the final grade pass adds the bloom texture
// itself (saves one full-screen blend into the multisampled target).
class BloomLite extends UnrealBloomPass {
  constructor(res, strength, radius, threshold) {
    super(res, strength, radius, threshold);
    this.needsSwap = false;
    this.scale = 1;
  }
  setSize(w, h) { super.setSize(Math.max(2, Math.round(w * this.scale)), Math.max(2, Math.round(h * this.scale))); }
  get texture() { return this.renderTargetsHorizontal[0].texture; }
  render(renderer, writeBuffer, readBuffer) {
    if (!this.enabled) return;
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.getClearColor(this._oldClearColor);
    this._oldClearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(this.clearColor, 0);
    const q = this._fsQuad;
    this.highPassUniforms.tDiffuse.value = readBuffer.texture;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    q.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright); renderer.clear(); q.render(renderer);
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i];
      q.material = m;
      m.uniforms.colorTexture.value = input.texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]); renderer.clear(); q.render(renderer);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]); renderer.clear(); q.render(renderer);
      input = this.renderTargetsVertical[i];
    }
    q.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]); renderer.clear(); q.render(renderer);
    renderer.setClearColor(this._oldClearColor, this._oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }
}

// ---------------------------------------------------------------------------- final pass
// HDR scene + bloom → exposure → grade (tint / saturation) → ACES → sRGB → contrast → vignette → dither.
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, tBloom: { value: null }, uBloom: { value: 1 },
    toneMappingExposure: { value: 1 },
    uTint: { value: new THREE.Color(1, 1, 1) }, uSat: { value: 1 }, uContrast: { value: 1 },
    uVig: { value: 0.35 }, uVigColor: { value: new THREE.Color(0, 0, 0.01) }, uAspect: { value: 1 },
    uLift: { value: new THREE.Color(0, 0, 0) }, uTime: { value: 0 },
  },
  vertexShader: /* glsl */`
    precision highp float;
    uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
    attribute vec3 position; attribute vec2 uv; varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse; uniform sampler2D tBloom; uniform float uBloom;
    uniform vec3 uTint; uniform float uSat; uniform float uContrast; uniform float uVig;
    uniform vec3 uVigColor; uniform float uAspect; uniform vec3 uLift; uniform float uTime;
    #include <tonemapping_pars_fragment>
    #include <colorspace_pars_fragment>
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      if (uBloom > 0.0) c += texture2D(tBloom, vUv).rgb * uBloom;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = max(mix(vec3(l), c, uSat) * uTint + uLift, 0.0);
      c = ACESFilmicToneMapping(c);
      vec4 o = sRGBTransferOETF(vec4(c, 1.0));
      o.rgb = clamp((o.rgb - 0.5) * uContrast + 0.5, 0.0, 1.0);
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0) / max(uAspect, 1.0) * 1.9;
      float v = smoothstep(0.35, 1.25, dot(d, d));
      o.rgb = mix(o.rgb, uVigColor, v * uVig);
      o.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
      gl_FragColor = vec4(o.rgb, 1.0);
    }`,
};

class FinalPass extends Pass {
  constructor(bloom) {
    super();
    this.bloom = bloom;
    this.uniforms = THREE.UniformsUtils.clone(FinalShader.uniforms);
    this.material = new THREE.RawShaderMaterial({
      uniforms: this.uniforms, vertexShader: FinalShader.vertexShader, fragmentShader: FinalShader.fragmentShader,
      defines: { ACES_FILMIC_TONE_MAPPING: '', SRGB_TRANSFER: '' }, depthTest: false, depthWrite: false,
    });
    this._q = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    const b = this.bloom && this.bloom.enabled;
    this.uniforms.tBloom.value = b ? this.bloom.texture : null;
    this.uniforms.uBloom.value = b ? 1 : 0;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._q.render(renderer);
  }
}

// ---------------------------------------------------------------------------- helpers
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
// critically damped spring (SmoothDamp); state = {v}
function damp(cur, target, st, key, smoothTime, dt) {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (st[key] + omega * change) * dt;
  st[key] = (st[key] - omega * temp) * exp;
  return target + (change + temp) * exp;
}

// ---------------------------------------------------------------------------- createGfx
export function createGfx(container, opts = {}) {
  const touch = (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window);
  let q = opts.quality != null ? clamp(opts.quality | 0, 0, 3) : (touch ? 2 : 3);
  const startQ = q;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false, stencil: false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = TIERS[q].shadow > 0;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  const canvas = renderer.domElement;
  canvas.style.cssText = 'display:block;position:absolute;inset:0;width:100%;height:100%;touch-action:none;outline:none;';
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(canvas);
  // CSS vignette for q0 (no post chain)
  const cssVig = document.createElement('div');
  cssVig.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none;background:radial-gradient(ellipse at 50% 50%, rgba(0,0,6,0) 55%, rgba(0,0,6,0.55) 100%);';
  container.appendChild(cssVig);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03040a);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 160);
  scene.add(camera);

  // ---- key light (owned here so its shadow camera can be fitted to the view; world drives colour/intensity)
  const key = new THREE.DirectionalLight(0xdfe7ff, 1.6);
  key.name = 'gfxKeyLight';
  key.castShadow = TIERS[q].shadow > 0;
  key.shadow.mapSize.set(TIERS[q].shadow || 512, TIERS[q].shadow || 512);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = 2;
  key.shadow.camera.near = 1; key.shadow.camera.far = 70;
  key.shadow.camera.up.set(0, 0, -1); // must match the snapping basis below
  scene.add(key); scene.add(key.target);
  const keyDir = new THREE.Vector3(0.32, 1, 0.42).normalize(); // direction TOWARD the light

  // ---- post
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: TIERS[q].msaa });
  rt.texture.name = 'gfx.hdr';
  const composer = new EffectComposer(renderer, rt);
  const renderPass = new RenderPass(scene, camera);
  let sceneCalls = 0, sceneTris = 0;
  { const r0 = renderPass.render.bind(renderPass); renderPass.render = (...a) => { r0(...a); sceneCalls = renderer.info.render.calls; sceneTris = renderer.info.render.triangles; }; }
  const bloom = new BloomLite(new THREE.Vector2(256, 256), 0.5, 0.5, 1.0);
  const finalPass = new FinalPass(bloom);
  composer.addPass(renderPass); composer.addPass(bloom); composer.addPass(finalPass);

  // grade values: world writes these per mood (exposure, tint, sat, contrast, vignette, lift)
  const grade = {
    exposure: 1.0, tint: new THREE.Color(1, 1, 1), sat: 1.05, contrast: 1.04, vignette: 0.4,
    vigColor: new THREE.Color(0.0, 0.0, 0.012), lift: new THREE.Color(0, 0, 0), bloom: 0.5, bloomThreshold: 1.0, bloomRadius: 0.5,
  };

  // ---- sizing
  let W = 1, H = 1, PR = 1;
  const rig = { fovV: 38, pitch: 57 * DEG, dist: 20, groundTop: -10, groundBot: 6, halfW: 5, aspect: 1 };
  function measure() {
    const r = container.getBoundingClientRect();
    return [Math.max(1, Math.round(r.width || container.clientWidth || innerWidth)), Math.max(1, Math.round(r.height || container.clientHeight || innerHeight))];
  }
  function resize() {
    [W, H] = measure();
    const T = TIERS[q];
    let pr = Math.min(window.devicePixelRatio || 1, T.pr);
    if (W * H * pr * pr > T.px) pr = Math.sqrt(T.px / (W * H));
    PR = Math.max(0.5, pr);
    renderer.setPixelRatio(PR);
    renderer.setSize(W, H, false);
    composer.setPixelRatio(PR);
    composer.setSize(W, H);
    camera.aspect = W / H;
    finalPass.uniforms.uAspect.value = W / H;
    computeRig();
    camera.updateProjectionMatrix();
  }
  // Camera distance so that: portrait ≈ 10.6 m wide at the fox, landscape ≈ 11.5 m of visible floor depth.
  function computeRig() {
    const a = W / H;
    rig.aspect = a;
    rig.fovV = a < 1 ? 40 : 36;
    camera.fov = rig.fovV;
    const h = rig.fovV * DEG / 2, p = rig.pitch;
    const depthPerD = Math.sin(p) * (1 / Math.tan(p - h) - 1 / Math.tan(p + h));
    const dDepth = 11.5 / depthPerD;
    const dWidth = 9.8 / (2 * Math.tan(h) * a);
    rig.dist = Math.max(dDepth, dWidth);
  }

  let dirty = false; // set by resize events / ResizeObserver
  // ---- camera rig state
  const cam = {
    tx: 0, tz: 4, vx: 0, vz: 0, // smoothed target (ground point at screen centre)
    sp: { x: 0, z: 0, lx: 0, lz: 0, zoom: 0 },
    lx: 0, lz: 0, px: null, pz: null, zoom: 1,
    focus: null, // {x,z,zoom,dur,t}
    mode: 'follow',
    basePos: new THREE.Vector3(0, 20, 20), baseLook: new THREE.Vector3(),
  };
  const shake = new THREE.Vector3();

  function viewLimits(dist) {
    // ground-plane framing limits for a target T (see report): top-edge ray must hit the back wall
    // below its top, bottom edge must not go more than ~2 m past the storefront, sides ≤ ~0.9 m past walls.
    const p = rig.pitch, h = rig.fovV * DEG / 2;
    const cy = dist * Math.sin(p), cz = dist * Math.cos(p);
    const Hv = 6.3; // visible wall height at the back (wall is 6.4 m + cap)
    const zMin = ROOM.backZ - cz + (cy - Hv) / Math.tan(p - h);
    const zMax = ROOM.frontZ + 1.1 - cz + cy / Math.tan(p + h);
    const halfW = dist * Math.tan(h) * rig.aspect;
    const xLim = Math.max(0, ROOM.wallX + 0.9 - halfW);
    return { zMin, zMax, xLim, halfW };
  }

  function follow(x, z, dt, o) {
    if (dirty) { dirty = false; resize(); }
    cam.mode = 'follow';
    dt = clamp(dt || 0, 0, 0.1);
    const zoomIn = (o && o.zoom) || 1;
    // look-ahead: from explicit lead or from the fox's own motion
    let lx, lz;
    if (o && o.lead) { lx = o.lead.x; lz = o.lead.z; }
    else if (cam.px != null && dt > 0) { lx = (x - cam.px) / dt * 0.28; lz = (z - cam.pz) / dt * 0.28; }
    else { lx = 0; lz = 0; }
    const ll = Math.hypot(lx, lz), lmax = 1.3;
    if (ll > lmax) { lx *= lmax / ll; lz *= lmax / ll; }
    cam.px = x; cam.pz = z;
    const snap = o && o.snap;
    if (snap) { cam.lx = lx; cam.lz = lz; cam.sp.lx = cam.sp.lz = 0; }
    else { cam.lx = damp(cam.lx, lx, cam.sp, 'lx', 0.45, dt); cam.lz = damp(cam.lz, lz, cam.sp, 'lz', 0.45, dt); }

    // focus (boss intro push-in)
    let fw = 0, fx = 0, fz = 0, fzoom = 1;
    const F = cam.focus;
    if (F) {
      F.t += dt;
      const inT = 0.7, outT = 0.9;
      if (F.t < inT) fw = smooth(F.t / inT);
      else if (F.t < inT + F.dur) fw = 1;
      else if (F.t < inT + F.dur + outT) fw = 1 - smooth((F.t - inT - F.dur) / outT);
      else { cam.focus = null; fw = 0; }
      fx = F.x; fz = F.z; fzoom = F.zoom;
    }
    cam.zoom = snap ? zoomIn : damp(cam.zoom, zoomIn, cam.sp, 'zoom', 0.5, dt);
    const zoom = cam.zoom * lerp(1, fzoom, fw);
    const dist = rig.dist / zoom;
    const L = viewLimits(dist);
    // fox slightly below screen centre: aim a little up-screen of it
    const ahead = 0.055 * (dist * Math.sin(rig.pitch)) * (1 / Math.tan(rig.pitch - rig.fovV * DEG / 2) - 1 / Math.tan(rig.pitch + rig.fovV * DEG / 2));
    let tx = x + cam.lx, tz = z + cam.lz - ahead;
    tx = lerp(tx, fx, fw); tz = lerp(tz, fz, fw);
    tx = clamp(tx, -L.xLim, L.xLim);
    // room shorter than the view (portrait): favour the back wall (C³ sign) and let the street show below
    // portrait: let the camera follow the fox in depth too, so the fox never sinks under the player's thumb
    // (allows up to ~2.5 m more street below the storefront than the strict room clamp)
    tz = L.zMin > L.zMax ? clamp(tz, L.zMax, L.zMin + 2.5) : clamp(tz, L.zMin, L.zMax + (rig.aspect < 1 ? 2.5 : 0));
    if (snap) { cam.tx = tx; cam.tz = tz; cam.sp.x = cam.sp.z = 0; }
    else {
      const st = fw > 0 && fw < 1 ? 0.12 : 0.22;
      cam.tx = damp(cam.tx, tx, cam.sp, 'x', st, dt);
      cam.tz = damp(cam.tz, tz, cam.sp, 'z', st, dt);
    }
    const p = rig.pitch;
    cam.baseLook.set(cam.tx, 0, cam.tz);
    cam.basePos.set(cam.tx, dist * Math.sin(p), cam.tz + dist * Math.cos(p));
    camera.fov = rig.fovV;
    poseCamera(false);
  }
  // apply basePos/baseLook (+ shake) to the camera; keeps worldToScreen() current between follow() and render()
  const _look = new THREE.Vector3();
  function poseCamera(withShake) {
    camera.position.copy(cam.basePos); _look.copy(cam.baseLook);
    if (withShake) { camera.position.add(shake); _look.add(shake); }
    camera.lookAt(_look);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  function focus(x, z, zoom = 1.6, dur = 2.0) { cam.focus = { x, z, zoom: Math.max(0.5, zoom), dur: Math.max(0, dur), t: 0 }; }

  // Title-screen background: slow cinematic drift over the store (UI overlays it).
  // 64 s loop: long front sweep (store + C³ wall + skyline beyond), then a slow fly over the kiosk to a
  // reverse shot looking out through the storefront at the street and the city, then back.
  const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _la = new THREE.Vector3(), _lb = new THREE.Vector3();
  function attract(t) {
    if (dirty) { dirty = false; resize(); }
    cam.mode = 'attract';
    const a = W / H, portrait = a < 1;
    // shot A: front sweep
    const s = 0.5 + 0.5 * Math.sin(t * 0.045);
    const th = lerp(-0.34, 0.34, smooth(s));
    const R = portrait ? 20.5 : 16.5;
    const hA = 7.2 + Math.sin(t * 0.11) * 0.8 + (portrait ? 3.5 : 0);
    _pa.set(Math.sin(th) * R, hA, -1.0 + Math.cos(th) * R);
    _la.set(Math.sin(th) * -1.2, 1.4 + Math.sin(t * 0.07) * 0.2, -5.2);
    // shot B: reverse, from above the service counter looking out the front
    const bx = portrait ? 2.6 + Math.sin(t * 0.06) * 0.8 : Math.sin(t * 0.06) * 2.6;
    _pb.set(bx, (portrait ? 7.4 : 5.0) + Math.sin(t * 0.13) * 0.25, -8.6);
    _lb.set(portrait ? -0.6 : bx * 0.4, portrait ? -0.4 : 1.1, 9.0);
    const u = ((t % 64) + 64) % 64;
    const w = u < 38 ? 0 : u < 44 ? smooth((u - 38) / 6) : u < 58 ? 1 : 1 - smooth((u - 58) / 6);
    cam.basePos.copy(_pa).lerp(_pb, w);
    // arc over the store while flying (keeps the path above the kiosk)
    cam.basePos.y += Math.sin(Math.PI * w) * 3.0;
    cam.baseLook.copy(_la).lerp(_lb, w);
    camera.fov = portrait ? 44 : 38;
    poseCamera(false);
  }
  attract.cycle = 64;

  // Manual hero camera (locker / outfit showcase). Caller supplies eye + target + vertical fov.
  function showcase(px, py, pz, lx, ly, lz, fov) {
    if (dirty) { dirty = false; resize(); }
    cam.mode = 'showcase';
    cam.basePos.set(px, py, pz); cam.baseLook.set(lx, ly, lz);
    camera.fov = fov || 34;
    poseCamera(false);
  }

  function setShake(v) { if (v) shake.copy(v); else shake.set(0, 0, 0); }

  // ---- shadow fitting (texel-snapped, fixed extents per framing to avoid shimmer)
  const lightRot = new THREE.Matrix4(), lightInv = new THREE.Matrix4();
  const _v = new THREE.Vector3(), _c = new THREE.Vector3(), _ndc = new THREE.Vector3(), _ray = new THREE.Vector3();
  let shadowExtent = { x: 8, y: 8 };
  function updateLightBasis() {
    const m = new THREE.Matrix4().lookAt(keyDir, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));
    lightRot.copy(m); lightInv.copy(m).invert();
  }
  updateLightBasis();
  function fitShadow() {
    if (!key.castShadow) return;
    // footprint of the view on the floor (ray/ground intersections of the 4 frustum corners + centre)
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    const cpos = camera.position;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]];
    for (const [nx, ny] of pts) {
      _ndc.set(nx, ny, 0.5).unproject(camera);
      _ray.copy(_ndc).sub(cpos).normalize();
      let tHit = _ray.y < -0.05 ? -cpos.y / _ray.y : 60;
      tHit = Math.min(tHit, 80);
      for (const hy of [0, 3.5]) {
        _v.copy(cpos).addScaledVector(_ray, tHit);
        _v.y = hy;
        _v.x = clamp(_v.x, -ROOM.wallX - 1, ROOM.wallX + 1);
        _v.z = clamp(_v.z, ROOM.backZ - 0.5, ROOM.frontZ + 2);
        _v.applyMatrix4(lightInv);
        minX = Math.min(minX, _v.x); maxX = Math.max(maxX, _v.x);
        minY = Math.min(minY, _v.y); maxY = Math.max(maxY, _v.y);
      }
    }
    const margin = 1.5;
    const ex = Math.ceil(((maxX - minX) / 2 + margin) / 2) * 2, ey = Math.ceil(((maxY - minY) / 2 + margin) / 2) * 2;
    shadowExtent.x = ex; shadowExtent.y = ey;
    const size = key.shadow.mapSize.x;
    const tx = (2 * ex) / size, ty = (2 * ey) / size;
    let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    cx = Math.round(cx / tx) * tx; cy = Math.round(cy / ty) * ty;
    _c.set(cx, cy, 0).applyMatrix4(lightRot); // back to world (on the plane through origin ⟂ light)
    key.target.position.copy(_c);
    key.position.copy(_c).addScaledVector(keyDir, 30);
    const sc = key.shadow.camera;
    if (sc.left !== -ex || sc.top !== ey) {
      sc.left = -ex; sc.right = ex; sc.top = ey; sc.bottom = -ey; sc.updateProjectionMatrix();
    }
    key.target.updateMatrixWorld();
  }

  // ---- quality
  const qListeners = [];
  let pointLightsWanted = TIERS[q].pointLights;
  function applyQuality(first) {
    const T = TIERS[q];
    const shadowsOn = T.shadow > 0;
    const shadowChanged = renderer.shadowMap.enabled !== shadowsOn;
    renderer.shadowMap.enabled = shadowsOn;
    key.castShadow = shadowsOn;
    if (shadowsOn && key.shadow.mapSize.x !== T.shadow) {
      key.shadow.mapSize.set(T.shadow, T.shadow);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    if (rt.samples !== T.msaa) { rt.samples = T.msaa; composer.renderTarget2.samples = T.msaa; rt.dispose(); composer.renderTarget2.dispose(); }
    bloom.enabled = T.bloom > 0;
    bloom.scale = T.bloom || 1;
    cssVig.style.display = T.post ? 'none' : 'block';
    pointLightsWanted = T.pointLights;
    resize();
    if (!first && shadowChanged) scene.traverse((o) => { const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => { mm.needsUpdate = true; }); });
  }
  function setQuality(nq, fromWatchdog) {
    nq = clamp(nq | 0, 0, 3);
    if (nq === q) return;
    q = nq;
    applyQuality(false);
    wd.cool = 0; wd.bad = 0; wd.good = 0;
    for (const cb of qListeners) { try { cb(q, !!fromWatchdog); } catch (e) { console.warn(e); } }
  }
  function onQuality(cb) { qListeners.push(cb); }

  // ---- watchdog frame pacer
  // Rolling 1.5 s windows. 2 consecutive windows < 45 fps (after a 3 s settle) → step down.
  // If a step down did not help (fps stuck ≈ same, e.g. 30 fps Low-Power cap), revert and stop.
  // Upgrades: at most one per session, only after 10 s of ≥ 58 fps, never above the start tier.
  const wd = { enabled: opts.autoQuality !== false, last: 0, acc: 0, n: 0, cool: -3, /* ~6 s initial settle */ bad: 0, good: 0, upgrades: 0, prevFps: 0, stepped: false, stopped: false, fps: 60 };
  function watchdog(now) {
    if (wd.last) {
      const ft = now - wd.last;
      if (ft < 300) { // longer gaps = paused / backgrounded / menu, not a slow frame
        wd.acc += ft; wd.n++;
        wd.fps = lerp(wd.fps, 1000 / Math.max(1, ft), 0.08);
      }
    }
    wd.last = now;
    if (wd.acc < 1500) return;
    const fps = (1000 * wd.n) / wd.acc;
    wd.acc = 0; wd.n = 0;
    wd.winFps = fps;
    if (!wd.enabled || wd.stopped || (typeof document !== 'undefined' && document.hidden)) return;
    wd.cool += 1.5;
    if (wd.cool < 3) return;
    if (wd.stepped) {
      wd.stepped = false;
      if (fps < wd.prevFps * 1.1 && fps < 45) { // no improvement → frame cap, not GPU bound
        wd.stopped = true; setQuality(q + 1, true); return;
      }
    }
    if (fps < 45) {
      wd.good = 0;
      if (++wd.bad >= 2 && q > 0) { wd.prevFps = fps; setQuality(q - 1, true); wd.stepped = true; }
    } else {
      wd.bad = 0;
      if (fps >= 58) { if (++wd.good >= 7 && q < startQ && wd.upgrades < 1) { wd.upgrades++; setQuality(q + 1, true); } }
      else wd.good = 0;
    }
  }

  // ---- render
  let elapsed = 0;
  function render(dt) {
    const now = performance.now();
    watchdog(now);
    elapsed += dt || 0;
    if (dirty) { dirty = false; resize(); }

    poseCamera(true);
    shake.set(0, 0, 0);
    fitShadow();

    renderer.info.reset();
    renderer.toneMappingExposure = grade.exposure;
    if (TIERS[q].post) {
      const u = finalPass.uniforms;
      u.uTint.value.copy(grade.tint); u.uSat.value = grade.sat; u.uContrast.value = grade.contrast;
      u.uVig.value = grade.vignette; u.uVigColor.value.copy(grade.vigColor); u.uLift.value.copy(grade.lift);
      u.uTime.value = (elapsed % 10);
      bloom.strength = grade.bloom; bloom.threshold = grade.bloomThreshold; bloom.radius = grade.bloomRadius;
      composer.render(dt);
    } else {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      sceneCalls = renderer.info.render.calls; sceneTris = renderer.info.render.triangles;
    }
    frames++;
  }
  let frames = 0;

  const _p = new THREE.Vector3();
  function worldToScreen(x, y, z, out) {
    out = out || new THREE.Vector2();
    _p.set(x, y, z).project(camera);
    out.x = (_p.x * 0.5 + 0.5) * W;
    out.y = (-_p.y * 0.5 + 0.5) * H;
    return out;
  }

  function stats() {
    return {
      fps: Math.round(wd.fps), winFps: wd.winFps ? Math.round(wd.winFps) : null,
      drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      sceneCalls, sceneTris, // scene + shadow pass only (drawCalls/triangles also include the post passes)
      q, pr: +PR.toFixed(2), w: W, h: H,
    };
  }

  // resize: events + ResizeObserver set a dirty flag (no per-frame layout reads → no forced reflow)
  const onResize = () => { dirty = true; };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => { dirty = true; setTimeout(onResize, 250); setTimeout(onResize, 700); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(onResize).observe(container);

  applyQuality(true);
  follow(0, 6.5, 0, { snap: true });

  const gfx = {
    renderer, scene, camera, composer, key, keyDir, grade,
    get quality() { return q; },
    get pointLights() { return pointLightsWanted; },
    get autoQuality() { return wd.enabled; }, set autoQuality(v) { wd.enabled = !!v; },
    get size() { return { w: W, h: H, pr: PR }; },
    get rig() { return rig; },
    setQuality: (nq) => setQuality(nq, false), onQuality, resize,
    follow, focus, attract, showcase, setShake, worldToScreen, render, stats,
  };
  return gfx;
}
