// dawn-scene.js — the DAWN plugin scene, live.
//
// The scene, its camera and all six lights ship inside dawn-scene.glb
// (KHR_lights_punctual), exported from the same Blender file the plugin uses.
//
// The plugin does NOT light this with PBR. Its renderer
// (DAWN_CHORUS/src/interface/gltf/shaders/SceneShaders.h) uses a stylised rig:
// wrapped diffuse, a height-based darkening gradient, a self-shadow term and a
// warm tint blend. That model is ported into the material shader below.
//
// Everything the scene needs is known to exist in the asset, so missing pieces
// assert rather than degrade — silent partial failure has already cost us two
// bugs (a light whose special-case never fired, digits that never rendered).
// The caller hides the stage if this throws, so a hard failure is safe.

import { SCREEN_VERT, SCREEN_FRAG } from './dawn-screen.js';

const PLUGIN = {
  // GLTFRenderer.cpp — glTF lux scaled into a usable range.
  intensityScale: 0.0001,
  // setupSpotLightUniforms(): spots take a different scale to the sun, and the
  // one whose LIGHT def is named "Area" is nudged up (areaLightYOffset).
  spotIntensityScale: 0.0003,
  areaLightYOffset: 1.0,
  // Warm tint applied to every light colour.
  sunTint: [1.0, 0.95, 0.85],
  // Warm world ambient.
  ambientColor: [0.627, 0.525, 0.416],
  ambientIntensity: 1.4,
  // GLTFRenderer.cpp sets uContrast to 1.0 for the main pass.
  contrast: 1.0,
  // computeViewMatrix() uses +/- 3 degrees; kept tighter here because a web
  // page gives the cursor far more room to roam than a plugin window does.
  maxParallaxDeg: 1.8,
  // ...plus a 1 degree pitch-up on the scene camera.
  tiltDeg: 1.0,
  // DownsampleFBO: effectiveFactor = downsampleFactor(2) * renderScale. On a
  // 2x display that is 4, so an 800x600 editor renders into a 400x300 buffer
  // and is blitted up with GL_NEAREST. 400/800 = 0.5 in CSS pixels, DPR
  // independent, because the renderScale term cancels the display scale.
  bufferScale: 0.5,
};

const GLB_MAGIC = 0x46546c67;   // 'glTF'
const MAX_SPOTS = 8;            // matches the shader's uniform array size

function assert(cond, msg) {
  if (!cond) throw new Error(`dawn-scene: ${msg}`);
}

// Copies the first n bytes out of a list of chunks, which may be split
// anywhere — the GLB header is only 12 bytes and can straddle a boundary.
function head(chunks, n) {
  const out = new Uint8Array(n);
  let filled = 0;
  for (const c of chunks) {
    const take = Math.min(n - filled, c.length);
    out.set(c.subarray(0, take), filled);
    filled += take;
    if (filled === n) break;
  }
  return out;
}

// Progress is measured against the length the GLB declares in its own header,
// never Content-Length: the asset is served gzipped (GitHub Pages compresses
// model/gltf-binary), so the header carries the encoded size while the stream
// hands back decoded bytes and the bar would run past 100%.
async function fetchGlb(url, onProgress) {
  const res = await fetch(url);
  assert(res.ok, `asset request failed (${res.status})`);
  if (!onProgress || !res.body) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0, total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (!total && received >= 12) {
      total = new DataView(head(chunks, 12).buffer).getUint32(8, true);
    }
    if (total) onProgress(Math.min(1, received / total));
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  onProgress(1);
  return bytes.buffer;
}

// renderSkyBackground() — screen-space gradient with a sun glow, drawn behind
// the scene. Without it the environment floats on black.
const SKY_VERT = `
varying vec2 vScreenPos;
void main() {
  vScreenPos = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const SKY_FRAG = `
varying vec2 vScreenPos;
void main() {
  float remapped = clamp((vScreenPos.y - 0.2) / 0.8, 0.0, 1.0);

  vec3 top    = vec3(0.561, 0.255, 0.227);
  vec3 mid    = vec3(0.875, 0.529, 0.357);
  vec3 bottom = vec3(0.973, 0.808, 0.502);

  // Not fract(): at remapped == 1.0 it wraps to 0 and the top scanline would
  // come out mid-colour instead of top-colour.
  float s = remapped * 2.0 - step(0.5, remapped);
  s = s * s * (3.0 - 2.0 * s);
  vec3 skyColor = remapped < 0.5 ? mix(bottom, mid, s) : mix(mid, top, s);

  float sunDist = distance(vScreenPos, vec2(0.7, 0.15));
  vec3 glowColor = vec3(1.0, 0.85, 0.4);
  skyColor = mix(skyColor, glowColor, exp(-sunDist * 8.0) * 0.6);
  skyColor += glowColor * exp(-sunDist * 3.0) * 0.15;

  gl_FragColor = vec4(skyColor, 1.0);
}`;

// SceneShaders.h main(): ambient + squared wrapped diffuse + Blinn-Phong spec,
// scaled by the height gradient and self-shadow terms, then the spot loop,
// contrast and warm tint. Shadow maps are the one omission — the plugin also
// renders a directional pass plus up to 8 spot passes.
const DAWN_LIGHTING = `
  vec3 N = normalize(vDawnNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vDawnWorld);
  vec3 L = normalize(uDawnLightDir);

  float shininess = mix(256.0, 4.0, uDawnRoughness * uDawnRoughness);
  float specStrength = (1.0 - uDawnRoughness) * 3.2;

  // Wrapped diffuse, squared — the soft non-physical falloff.
  float wrapped = max((dot(N, L) + 0.3) / 1.3, 0.0);
  wrapped *= wrapped;

  vec3 sunColor = uDawnLightColor * uDawnLightIntensity;
  vec3 sunLight = sunColor * wrapped
                + sunColor * pow(max(dot(N, normalize(L + V)), 0.0), shininess) * specStrength;

  float heightShadow = mix(0.4, 1.0, smoothstep(-2.0, 1.0, vDawnWorld.y));
  float selfShadow = 1.0 - max(0.0, -N.y) * 0.5;

  vec3 totalLight = uDawnAmbient + sunLight * heightShadow * selfShadow;

  for (int i = 0; i < ${MAX_SPOTS}; i++) {
    if (i >= uDawnNumSpots) break;
    vec3 toLight = uDawnSpotPos[i] - vDawnWorld;
    float dist = length(toLight);
    vec3 sL = toLight / dist;
    float spotFactor = smoothstep(cos(uDawnSpotOuter[i]), cos(uDawnSpotInner[i]),
                                  dot(-sL, normalize(uDawnSpotDir[i])));
    float sSpec = pow(max(dot(N, normalize(sL + V)), 0.0), shininess) * specStrength;
    totalLight += uDawnSpotColor[i] * uDawnSpotIntensity[i]
                * (max(dot(N, sL), 0.0) + sSpec)
                * (1.0 / (dist * dist + 1.0)) * spotFactor;
  }

  // The plugin multiplies raw sRGB texels by the light and writes the result
  // straight out. three decodes textures to linear, and this runs after its
  // colour-space stage, so the albedo is encoded back or the darks crush.
  vec3 albedo = pow(max(diffuseColor.rgb, 0.0), vec3(0.4545));
  vec3 litColor = max((albedo - 0.5) * uDawnContrast + 0.5, 0.0) * totalLight;
  gl_FragColor = vec4(mix(litColor, litColor * vec3(1.05, 0.95, 0.85), 0.3), gl_FragColor.a);
`;

const DAWN_UNIFORM_DECLS = `
varying vec3 vDawnWorld;
varying vec3 vDawnNormal;
uniform vec3 uDawnLightDir;
uniform vec3 uDawnLightColor;
uniform float uDawnLightIntensity;
uniform vec3 uDawnAmbient;
uniform int uDawnNumSpots;
uniform vec3 uDawnSpotPos[${MAX_SPOTS}];
uniform vec3 uDawnSpotDir[${MAX_SPOTS}];
uniform vec3 uDawnSpotColor[${MAX_SPOTS}];
uniform float uDawnSpotIntensity[${MAX_SPOTS}];
uniform float uDawnSpotInner[${MAX_SPOTS}];
uniform float uDawnSpotOuter[${MAX_SPOTS}];
uniform float uDawnRoughness;
uniform float uDawnContrast;`;

// ---- Bindings, mirroring SceneEditor.cpp -----------------------------------
// parameters.json ranges, and the node names / rotation limits / animation
// frame counts the plugin binds to them.
const PARAM_DEFS = {
  skew:   { min: -100, max: 100, value: 0,  step: 1 },
  blend:  { min: -100, max: 100, value: 0,  step: 0 },
  detune: { min: 0,    max: 100, value: 50, step: 0 },
  range:  { min: 1,    max: 12,  value: 2,  step: 1 },   // max_detune
  voices: { min: 2,    max: 7,   value: 5,  step: 1 },   // unison
};

const KNOB_DEFS = [
  { node: 'Knob1', param: 'skew' },
  { node: 'Knob2', param: 'blend' },
  { node: 'Knob3', param: 'detune' },
];

const BUTTON_DEFS = [
  { node: 'Up_but',       param: 'range',  delta: 1 },
  { node: 'Down_But',     param: 'range',  delta: -1 },
  { node: 'Right_Button', param: 'voices', delta: 1,  anim: 'Right)Button_Press' },
  { node: 'Left_button',  param: 'voices', delta: -1, anim: 'Left_Button_Press' },
];

// Number readouts are animations scrubbed by value, not live text.
const READOUT_DEFS = [
  { anim: 'Numbers_going up',     strip: 'Numbers',    param: 'range',  frames: 13 },
  { anim: 'Numbers_going up.001', strip: 'Numbers001', param: 'voices', frames: 8 },
];

const KNOB_MIN_DEG = -120, KNOB_MAX_DEG = 120;   // 8 o'clock to 4 o'clock
const PIXELS_PER_UNIT = 200;                     // drag distance for full range

export async function mountDawnScene(canvas, opts = {}) {
  // Started before anything is awaited, so the asset streams alongside the
  // three.js module (preloaded by the page) rather than after it. Serialising
  // the two costs a full transfer of whichever is slower, which on a thin
  // connection is most of the wait.
  const assetPromise = fetchGlb(opts.url || new URL('dawn-scene.glb', import.meta.url), opts.onProgress);
  // Nothing else handles it if the mount is gated or bails out below.
  assetPromise.catch(() => {});

  // The download above costs the main thread nothing. Everything past this
  // point costs it a great deal — instantiating three, parsing 1.2MB of glTF,
  // compiling the shaders — and the caller may have something more important
  // on screen (here, the hero finishing its reveal). So it waits to be let in.
  if (opts.until) await opts.until;

  const [THREE, { GLTFLoader }] = await Promise.all([
    import('three'),
    import('three/addons/loaders/GLTFLoader.js'),
  ]);

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const X_AXIS = new THREE.Vector3(1, 0, 0);
  const Y_AXIS = new THREE.Vector3(0, 1, 0);
  const vec3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

  let renderer;
  try {
    // No MSAA: the half-res nearest-neighbour blit below is the intended
    // aesthetic, and smoothing the edges would fight it.
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
  } catch (e) {
    return null;   // no WebGL — the only expected failure; caller keeps the poster
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // The plugin tone-maps nothing — it writes lit colour straight out. ACES
  // desaturates exactly the warm reds this scene is built on.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.autoClear = false;   // the sky pass clears; the scene draws over it

  const scene = new THREE.Scene();

  // Sky is its own pass, drawn first with depth off — same order as the plugin.
  const skyScene = new THREE.Scene();
  const skyCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  skyScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, depthTest: false, depthWrite: false,
  })));

  // Fetched once and handed to the parser, so the JSON chunk can also be read
  // for the KHR_lights_punctual definitions: three names light objects after
  // the NODE ("DialAccent_Light"), but the plugin keys its special-casing off
  // the LIGHT definition name ("Area"), which three discards.
  const buffer = await assetPromise;
  const view = new DataView(buffer);
  assert(view.getUint32(0, true) === GLB_MAGIC, 'asset is not a binary glTF');

  const json = JSON.parse(new TextDecoder()
    .decode(new Uint8Array(buffer, 20, view.getUint32(12, true))));
  const lightDefs = json.extensions?.KHR_lights_punctual?.lights ?? [];
  const lightNameOfNode = new Map(json.nodes
    .filter(n => n.name && n.extensions?.KHR_lights_punctual)
    .map(n => [n.name, lightDefs[n.extensions.KHR_lights_punctual.light]?.name]));

  const gltf = await new Promise((ok, fail) => new GLTFLoader().parse(buffer, '', ok, fail));
  scene.add(gltf.scene);

  const find = (name) => {
    const obj = gltf.scene.getObjectByName(name);
    assert(obj, `node "${name}" not found`);
    return obj;
  };

  // ---- Camera: the one the artist framed, plus the plugin's 1 degree tilt ---
  const camera = gltf.cameras?.[0];
  assert(camera, 'scene has no camera');
  const basePos = vec3();
  const baseQuat = new THREE.Quaternion();
  camera.updateWorldMatrix(true, false);
  camera.matrixWorld.decompose(basePos, baseQuat, vec3());   // detach, keep world pose
  scene.add(camera);

  // computeViewMatrix(): inverse(mouseRot * tilt * camWorld). The tilt
  // PRE-multiplies, so it rotates the camera about the world X axis through the
  // origin — orbiting it, not just re-aiming it. Post-multiplying (a local
  // rotation) would leave the position untouched and sit ~0.28 too high.
  const tilt = new THREE.Quaternion()
    .setFromAxisAngle(X_AXIS, THREE.MathUtils.degToRad(PLUGIN.tiltDeg));
  basePos.applyQuaternion(tilt);
  baseQuat.premultiply(tilt);
  camera.position.copy(basePos);
  camera.quaternion.copy(baseQuat);

  // ---- Lights: read off the glTF, then removed ------------------------------
  // The plugin's rig is not physical, so three's own lights can't reproduce it:
  // spots fall off as 1/(d^2+1), their contribution is a (N.L + spec) product
  // rather than a BRDF, and the sun uses a squared wrapped diffuse. Three's
  // lights are deleted so nothing is double-counted.
  const tinted = (c) => vec3(c.r, c.g, c.b).multiply(vec3(...PLUGIN.sunTint));
  const sun = { dir: vec3(0, 1, 0), color: vec3(1, 1, 1), intensity: 1 };
  const spots = [];
  const lights = [];

  gltf.scene.traverse((o) => {
    if (!o.isLight) return;
    lights.push(o);
    o.updateWorldMatrix(true, false);

    if (o.isDirectionalLight) {
      // The shader wants the vector FROM the surface TO the light, i.e. +Z.
      sun.dir.set(0, 0, 1).transformDirection(o.matrixWorld).normalize();
      sun.color = tinted(o.color);
      sun.intensity = o.intensity * PLUGIN.intensityScale;
      return;
    }
    assert(o.isSpotLight, `unexpected light type "${o.type}"`);
    assert(spots.length < MAX_SPOTS, `more than ${MAX_SPOTS} spot lights`);

    // setupSpotLightUniforms(): the "Area" light keeps its authored cone and is
    // nudged up a unit; every other spot gets a 1.5x cone.
    const isArea = lightNameOfNode.get(o.name) === 'Area';
    const coneScale = isArea ? 1.0 : 1.5;
    const pos = o.getWorldPosition(vec3());
    if (isArea) pos.y += PLUGIN.areaLightYOffset;
    spots.push({
      name: o.name,
      pos,
      dir: vec3(0, 0, -1).transformDirection(o.matrixWorld).normalize(),
      color: tinted(o.color),
      intensity: o.intensity * PLUGIN.spotIntensityScale,
      inner: o.angle * (1 - o.penumbra) * coneScale,
      outer: o.angle * coneScale,
    });
  });
  for (const l of lights) l.parent.remove(l);

  // Shared by reference across every patched material, so one write updates all.
  const pad = (values, fill) =>
    Array.from({ length: MAX_SPOTS }, (_, i) => values[i] ?? fill);
  const ZERO = vec3();

  const lightUniforms = {
    uDawnLightDir: { value: sun.dir },
    uDawnLightColor: { value: sun.color },
    uDawnLightIntensity: { value: sun.intensity },
    uDawnAmbient: { value: vec3(...PLUGIN.ambientColor).multiplyScalar(PLUGIN.ambientIntensity) },
    uDawnNumSpots: { value: spots.length },
    uDawnSpotPos: { value: pad(spots.map(s => s.pos), ZERO) },
    uDawnSpotDir: { value: pad(spots.map(s => s.dir), vec3(0, -1, 0)) },
    uDawnSpotColor: { value: pad(spots.map(s => s.color), ZERO) },
    uDawnSpotIntensity: { value: pad(spots.map(s => s.intensity), 0) },
    uDawnSpotInner: { value: pad(spots.map(s => s.inner), 0) },
    uDawnSpotOuter: { value: pad(spots.map(s => s.outer), 0) },
  };

  const patchMaterial = (mat) => {
    if (mat.userData.__dawnPatched) return;
    mat.userData.__dawnPatched = true;
    // GLTFRenderer.cpp calls glDisable(GL_CULL_FACE) for the whole scene —
    // several meshes (the number readouts among them) have inverted winding and
    // vanish under three's default front-face-only culling.
    mat.side = THREE.DoubleSide;

    // GLTFParser.cpp: "Override rock roughness — glb exports 0 but we want it
    // rougher". At the exported 0 this material gets shininess 256 and
    // specStrength 3.2 — pinpoint blazing speculars on every low-poly face of
    // the rocks AND the ground. Forcing 1.0 zeroes the specular, as the plugin does.
    const roughness = mat.name === 'rock' ? 1.0 : mat.roughness;

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, lightUniforms, {
        uDawnRoughness: { value: roughness },
        uDawnContrast: { value: PLUGIN.contrast },
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nvarying vec3 vDawnWorld;\nvarying vec3 vDawnNormal;')
        .replace('#include <defaultnormal_vertex>',
          '#include <defaultnormal_vertex>\n\tvDawnNormal = normalize(mat3(modelMatrix) * objectNormal);')
        .replace('#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n\tvDawnWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${DAWN_UNIFORM_DECLS}`)
        .replace('#include <dithering_fragment>', `${DAWN_LIGHTING}\n#include <dithering_fragment>`);
    };
  };

  // Digit meshes ship with rest scale [0,0,0] and, on the NUM VOICES strip, an
  // authored local offset of (0,-64,0) — both export artefacts. The parent
  // `number.*` node is the real on/off switch (animated 0 or 1 so only the
  // active digit shows) and already sits dead centre of its panel carrying its
  // rake, so a zero child scale means no digit can ever appear and the offset
  // throws them out of the scene. Pin each digit to its slot; the only genuine
  // correction is +90 about X, because the glyph plane is authored flat in
  // local XZ and is otherwise seen edge-on. Set once: the clips animate the
  // slots, never these meshes.
  const digits = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;   // skinned parts report bad bounds otherwise
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) patchMaterial(m);

    if (!/^number/.test(o.parent.name) || o.scale.lengthSq() >= 1e-9) return;
    o.scale.set(1, 1, 1);
    o.position.set(0, 0, 0);
    o.rotation.set(Math.PI / 2, 0, 0);
    digits.push(o);
  });
  assert(digits.length, 'no digit meshes found');

  // ---- Animation -----------------------------------------------------------
  const clips = gltf.animations;
  assert(clips?.length, 'scene has no animations');
  const mixer = new THREE.AnimationMixer(gltf.scene);

  const once = (clip) => {
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce);
    action.clampWhenFinished = false;
    return action;
  };
  const clipNamed = (name) => {
    const clip = clips.find(c => c.name === name);
    assert(clip, `clip "${name}" not found`);
    return clip;
  };

  // Bird: idle, breaking into an occasional flap.
  const idleAction = once(clipNamed(clips.find(c => /idel|idle/i.test(c.name)).name));
  const flapAction = once(clipNamed(clips.find(c => /flap|wing/i.test(c.name)).name));
  idleAction.play();
  mixer.addEventListener('finished', (e) => {
    const next = e.action === idleAction && Math.random() < 0.25 ? flapAction : idleAction;
    next.reset().play();
  });

  // Button press clips, fired on click.
  const pressActions = new Map(BUTTON_DEFS.filter(b => b.anim)
    .map(b => [b.anim, once(clipNamed(b.anim))]));

  // ---- Controls ------------------------------------------------------------
  const params = structuredClone(PARAM_DEFS);
  const pickMap = new Map();     // mesh -> binding
  const pickables = [];

  const register = (def, kind) => {
    const obj = find(def.node);
    const entry = { ...def, kind, obj, baseQuat: obj.quaternion.clone() };
    obj.traverse(o => { if (o.isMesh) { pickables.push(o); pickMap.set(o, entry); } });
    return entry;
  };
  const knobs = KNOB_DEFS.map(d => register(d, 'knob'));
  BUTTON_DEFS.forEach(d => register(d, 'button'));

  const readouts = READOUT_DEFS.map((def) => {
    const clip = clipNamed(def.anim);
    const action = mixer.clipAction(clip);
    action.play();
    action.paused = true;        // held at a frame, never running
    return { ...def, clip, action, stripObj: find(def.strip) };
  });

  const spinQ = new THREE.Quaternion();

  function applyKnob(k) {
    const p = params[k.param];
    const t = (p.value - p.min) / (p.max - p.min);
    // GLTFRenderer::setNodeAxisAngleRotation — rest rotation, then local spin.
    const deg = KNOB_MIN_DEG + t * (KNOB_MAX_DEG - KNOB_MIN_DEG);
    k.obj.quaternion.copy(k.baseQuat)
      .multiply(spinQ.setFromAxisAngle(Y_AXIS, THREE.MathUtils.degToRad(deg)));
  }

  // ---- Screen: the plugin's oscilloscope on the "Screen" mesh ---------------
  // setScreenShaderNode("Screen") in SceneEditor.cpp.
  const screenUniforms = {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uPeak: { value: 0 },          // hook for the demo player's level
    uDetune: { value: 0.5 }, uBlend: { value: 0 }, uUnison: { value: 5 },
    uSkew: { value: 0 }, uMaxDetune: { value: 2 },
    uBPM: { value: 120 }, uFade: { value: 1 },
  };
  const screenMat = new THREE.ShaderMaterial({
    vertexShader: SCREEN_VERT, fragmentShader: SCREEN_FRAG, uniforms: screenUniforms,
  });
  find('Screen').traverse(o => { if (o.isMesh) o.material = screenMat; });

  function refresh() {
    knobs.forEach(applyKnob);
    for (const r of readouts) {
      // The plugin maps value directly to frame, normalised by total frames.
      r.action.time = (params[r.param].value / r.frames) * r.clip.duration;
    }
    // Normalisation from GLTFSceneView.cpp — note blend is inverted.
    screenUniforms.uDetune.value = params.detune.value / 100;
    screenUniforms.uBlend.value = -params.blend.value / 100;
    screenUniforms.uSkew.value = params.skew.value / 100;
    screenUniforms.uUnison.value = params.voices.value;
    screenUniforms.uMaxDetune.value = params.range.value;
    mixer.update(0);
  }

  function setParam(name, value) {
    const p = params[name];
    assert(p, `unknown parameter "${name}"`);
    if (p.step) value = Math.round(value / p.step) * p.step;
    p.value = Math.min(p.max, Math.max(p.min, value));
    refresh();
    opts.onParam?.(name, p.value);
  }

  // Slots land each digit close to its panel but slightly low, by a different
  // amount per readout (the panels differ in size, angle and scale). Measure the
  // gap between the lit digit and its panel's centre once and bake it into every
  // digit on that strip — converted through the parent's world scale, since
  // positions are local and the two strips differ by ~8x.
  function centreDigitsInPanels() {
    const panelCentres = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh || !/^screen$/i.test(o.material.name)) return;
      o.updateWorldMatrix(true, false);
      o.geometry.computeBoundingBox();
      panelCentres.push(o.geometry.boundingBox.clone()
        .applyMatrix4(o.matrixWorld).getCenter(vec3()));
    });
    assert(panelCentres.length, 'no display panels found');

    for (const r of readouts) {
      const inStrip = digits.filter((d) => {
        for (let p = d.parent; p; p = p.parent) if (p === r.stripObj) return true;
        return false;
      });
      // Exactly one digit per strip is scaled up — that is the lit one.
      const lit = inStrip.find(d => d.parent.scale.x > 0.5);
      assert(lit, `no lit digit on strip "${r.strip}"`);

      const digitPos = lit.getWorldPosition(vec3());
      const nearest = panelCentres
        .reduce((a, b) => (a.distanceTo(digitPos) < b.distanceTo(digitPos) ? a : b));

      lit.parent.updateWorldMatrix(true, false);
      const scaleY = vec3().setFromMatrixScale(lit.parent.matrixWorld).y;
      const delta = (nearest.y - digitPos.y) / scaleY;
      for (const d of inStrip) d.position.y += delta;
    }
  }

  refresh();
  centreDigitsInPanels();
  refresh();

  // ---- Picking -------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let drag = null;
  let hovered = null;

  function pick(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    return hit ? pickMap.get(hit.object) : null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const entry = pick(e);
    if (!entry) return;
    e.preventDefault();
    if (entry.kind === 'knob') {
      drag = { entry, startY: e.clientY, startValue: params[entry.param].value };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }
    setParam(entry.param, params[entry.param].value + entry.delta);
    pressActions.get(entry.anim)?.reset().play();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      // GLTFSceneView::mouseDrag — vertical, inverted, 200px for full range.
      const p = params[drag.entry.param];
      const travel = (drag.startY - e.clientY) / PIXELS_PER_UNIT;
      setParam(drag.entry.param, drag.startValue + travel * (p.max - p.min));
      return;
    }
    const entry = pick(e);
    if (entry === hovered) return;
    hovered = entry;
    canvas.style.cursor = !entry ? '' : entry.kind === 'knob' ? 'grab' : 'pointer';
  });

  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    canvas.style.cursor = hovered ? 'grab' : '';
    canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---- Parallax about the authored pose, matching the plugin ---------------
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  const maxAngle = THREE.MathUtils.degToRad(PLUGIN.maxParallaxDeg);
  const rotQ = new THREE.Quaternion();
  const pitchQ = new THREE.Quaternion();
  const clamp1 = v => Math.min(1, Math.max(-1, v));

  function onPointer(e) {
    const r = canvas.getBoundingClientRect();
    // Still clamped even though the listener is on the canvas: a knob drag
    // captures the pointer, so moves keep arriving once the cursor leaves.
    target.x = clamp1(((e.clientX - r.left) / r.width) * 2 - 1);
    target.y = clamp1(((e.clientY - r.top) / r.height) * 2 - 1);
  }
  // Scoped to the canvas so the scene only answers to a cursor that is
  // actually over it; leaving eases the camera back to the authored framing
  // rather than freezing it wherever the pointer left.
  const recentre = () => { target.x = 0; target.y = 0; };
  if (!calm) {
    canvas.addEventListener('pointermove', onPointer, { passive: true });
    canvas.addEventListener('pointerleave', recentre, { passive: true });
  }

  // The shot is framed for the plugin's 4:3 editor. On a narrower canvas,
  // holding yfov fixed would crop the sides off the composition, so the
  // vertical fov widens instead to preserve the authored horizontal framing.
  const authoredHalfH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const authoredHalfW = authoredHalfH * camera.aspect;

  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    camera.aspect = w / h;
    // Contain: whichever axis is tighter decides the fov, so the whole
    // composition survives at any frame shape.
    camera.fov = THREE.MathUtils.radToDeg(
      2 * Math.atan(Math.max(authoredHalfH, authoredHalfW / camera.aspect)));
    camera.updateProjectionMatrix();
    // Fixed, not DPR-derived: the plugin's own factor already cancels display
    // scale, so the buffer is always half the CSS size. With
    // `image-rendering: pixelated` this reproduces the GL_NEAREST blit.
    renderer.setPixelRatio(PLUGIN.bufferScale);
    renderer.setSize(w, h, false);
    // setSize clears the buffer post-rAF; redraw now so a cleared frame never paints.
    renderer.getDrawingBufferSize(screenUniforms.uResolution.value);
    renderer.clear();
    renderer.render(skyScene, skyCam);
    renderer.render(scene, camera);
  }
  resize();
  // Watch the box, not the window: layout can shift with no resize event and squish a stale buffer.
  const sizeWatcher = new ResizeObserver(resize);
  sizeWatcher.observe(canvas);

  const clock = new THREE.Clock();
  let running = true;
  let onScreen = true;

  // The scene is a viewport-sized WebGL canvas one screen down the page; left
  // running it burns a frame budget on a machine that has already scrolled
  // past it. getDelta() is drained on resume so the animations pick up where
  // they stopped instead of jumping by the time spent off-screen.
  const watcher = new IntersectionObserver(([entry]) => {
    if (onScreen === entry.isIntersecting) return;
    onScreen = entry.isIntersecting;
    if (!onScreen || calm || !running) return;
    clock.getDelta();
    requestAnimationFrame(frame);
  }, { rootMargin: '150px' });
  watcher.observe(canvas);

  function frame() {
    if (!running || !onScreen) return;
    const dt = clock.getDelta();
    if (!calm) mixer.update(dt);

    // Ease toward the pointer, then rotate the authored pose by that much.
    // Inverted: the scene leans away from the cursor rather than following it.
    const ease = Math.min(1, dt * 3.5);
    current.x += (target.x - current.x) * ease;
    current.y += (target.y - current.y) * ease;
    rotQ.setFromAxisAngle(Y_AXIS, -current.x * maxAngle)
        .multiply(pitchQ.setFromAxisAngle(X_AXIS, current.y * maxAngle));
    camera.position.copy(basePos).applyQuaternion(rotQ);
    camera.quaternion.copy(rotQ).multiply(baseQuat);

    screenUniforms.uTime.value += dt;
    renderer.getDrawingBufferSize(screenUniforms.uResolution.value);
    screenUniforms.uMouse.value.set((current.x + 1) * 0.5, (current.y + 1) * 0.5);

    renderer.clear();
    renderer.render(skyScene, skyCam);
    renderer.render(scene, camera);
    if (!calm) requestAnimationFrame(frame);
  }
  frame();

  return {
    params,
    set: setParam,
    get: name => params[name]?.value,
    play: name => pressActions.get(name)?.reset().play(),
    setPeak: v => { screenUniforms.uPeak.value = v; },
    clips: clips.map(c => c.name),
    lights: { sun, spots },
    root: gltf.scene,
    stop() {
      running = false;
      watcher.disconnect();
      canvas.removeEventListener('pointermove', onPointer);
      canvas.removeEventListener('pointerleave', recentre);
      sizeWatcher.disconnect();
      renderer.dispose();
    },
  };
}
