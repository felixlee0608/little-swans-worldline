// The stage: a black-box theatre on a moonlit lake.
// - a huge mirror floor (Reflector) with a faint mist layer above it
// - one cool follow-spot from above-front, a hemisphere fill, a cold rim from behind, a warm foot bounce
// - a distant moon disc (it shows up as a streak in the mirror), stars, and breathing haze
// The four porcelain swans and their ghost worldlines are added by main.js.

import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

const MOON_POS = new THREE.Vector3(-11.5, 8.6, -34);

export async function createStage({ renderer, scene, camera, hdriUrl = './assets/stage_1k.hdr' }) {
  scene.background = new THREE.Color(0x03050a);
  scene.fog = new THREE.FogExp2(0x03050a, 0.014);

  // ---- environment reflections (studio HDRI, CC0 Poly Haven, kept very dim) ----
  let env = null;
  try {
    const hdr = await new HDRLoader().loadAsync(hdriUrl);
    const pmrem = new THREE.PMREMGenerator(renderer);
    env = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose(); pmrem.dispose();
    scene.environment = env;
    scene.environmentIntensity = 0.16;
  } catch (e) {
    console.warn('[stage] no HDRI, reflections off', e?.message || e);
  }

  // ---- the lake: mirror floor + mist ----
  const mirror = new Reflector(new THREE.PlaneGeometry(160, 160), {
    color: 0x060a12,
    textureWidth: Math.min(1536, 1024 * Math.min(2, renderer.getPixelRatio() || 1)),
    textureHeight: Math.min(1536, 1024 * Math.min(2, renderer.getPixelRatio() || 1)),
    clipBias: 0.003,
  });
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = 0.001;
  scene.add(mirror);
  // Reflector clones the camera (layers included), so explicitly make the mirror camera layer-0 only:
  // the moon disc and its hard core live on layer 1 (main camera) and must not show up as bubbles in the lake.
  mirror.getReflectionCamera(camera).layers.set(0);

  // A thin, dark, slightly translucent water skin: makes the mirror read as still water instead of a mirror.
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uTime; varying vec2 vUv;
        void main(){
          vec2 c = vUv - 0.5;
          float d = length(c);
          // a faint tide line and a very soft sheen near the horizon
          float sheen = smoothstep(0.42, 0.0, d) * 0.035;
          float tide = 0.012 * sin((vUv.y * 90.0) + uTime * 0.35) * smoothstep(0.0, 0.28, d);
          float a = (sheen + tide) * 0.35;
          gl_FragColor = vec4(vec3(0.42, 0.55, 0.78) * a, a);
        }`,
    })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.012;
  water.renderOrder = 2;
  scene.add(water);

  // moon path on the water: a long soft additive streak where the moon would reflect
  const pathTex = makeGlowTexture(128, [
    [0.0, 'rgba(220,235,255,0.85)'],
    [0.35, 'rgba(170,200,255,0.30)'],
    [1.0, 'rgba(120,160,255,0)'],
  ]);
  const moonPath = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 9.5),
    new THREE.MeshBasicMaterial({ map: pathTex, transparent: true, opacity: 0.22, depthWrite: false, fog: false, blending: THREE.AdditiveBlending })
  );
  moonPath.rotation.x = -Math.PI / 2;
  moonPath.rotation.z = -0.16;
  moonPath.position.set(-1.15, 0.018, -3.2);
  moonPath.renderOrder = 3;
  scene.add(moonPath);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight(0x3a5378, 0x04060a, 0.14);
  scene.add(hemi);

  const spot = new THREE.SpotLight(0xeaf2ff, 170, 42, 0.33, 0.9, 1.5);
  spot.position.set(0.8, 9.5, 4.2);
  spot.target.position.set(0, 1.0, -1.4);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0004;
  spot.shadow.normalBias = 0.02;
  scene.add(spot, spot.target);

  // cold rim from behind: porcelain silhouettes get a silver edge
  const rim = new THREE.DirectionalLight(0xcfe2ff, 0.95);
  rim.position.set(5, 7, -12);
  scene.add(rim);

  // a second, weaker rim from the other side so the line of swans never goes flat
  const rim2 = new THREE.DirectionalLight(0x9db8e6, 0.32);
  rim2.position.set(-7, 4, -9);
  scene.add(rim2);

  // warm foot-light bounce, keeps the porcelain from reading as pure grey
  const foot = new THREE.PointLight(0xffcf9a, 1.6, 12, 2);
  foot.position.set(0, 0.35, 3.4);
  scene.add(foot);

  // ---- moon ----
  const moonTex = makeGlowTexture(256, [
    [0.0, 'rgba(255,255,255,1)'],
    [0.16, 'rgba(236,244,255,0.95)'],
    [0.34, 'rgba(190,214,255,0.34)'],
    [0.7, 'rgba(140,180,255,0.07)'],
    [1.0, 'rgba(120,160,255,0)'],
  ]);
  const moon = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.MeshBasicMaterial({ map: moonTex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending })
  );
  moon.position.copy(MOON_POS);
  moon.lookAt(0, 1.5, 0);
  moon.renderOrder = 1;
  moon.layers.set(1);   // main camera only: the mirror would show it as a hard bubble
  scene.add(moon);

  // a small hard core inside the glow so it reads as a moon, not a flare
  const moonCore = new THREE.Mesh(
    new THREE.CircleGeometry(1.05, 48),
    new THREE.MeshBasicMaterial({ color: 0xf4f8ff, transparent: true, opacity: 0.95, fog: false })
  );
  moonCore.position.copy(MOON_POS).add(new THREE.Vector3(0, 0, 0.06));
  moonCore.lookAt(0, 1.5, 0);
  moonCore.layers.set(1);   // main camera only: the hard core would read as a bubble in the lake mirror
  scene.add(moonCore);

  // ---- stars ----
  const stars = makeStars(520);
  scene.add(stars);

  // ---- haze: two big additive gradient sheets behind the swans ----
  const hazeTex = makeGlowTexture(256, [
    [0.0, 'rgba(150,180,230,0.55)'],
    [0.5, 'rgba(90,120,180,0.16)'],
    [1.0, 'rgba(40,60,100,0)'],
  ]);
  const hazeMat = new THREE.MeshBasicMaterial({ map: hazeTex, transparent: true, opacity: 0.055, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
  const haze = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(26 + i * 10, 14 + i * 6), hazeMat);
    m.position.set(-6 + i * 6, 3.2 + i * 0.6, -11 - i * 5);
    m.renderOrder = 0;
    haze.add(m);
  }
  scene.add(haze);

  // ---- dust motes in the light ----
  const dust = makeDust(420);
  scene.add(dust.points);

  const state = { level: 1 };
  const _v = new THREE.Vector3();

  function update(dt, T, { level = 1 } = {}) {
    state.level = level;
    const t = T ?? 0;
    water.material.uniforms.uTime.value = t;
    // stars breathe very slowly
    stars.rotation.y = t * 0.004;
    stars.material.opacity = 0.55 + 0.1 * Math.sin(t * 0.21);
    // moon glow pulse
    moon.material.opacity = 0.92 + 0.08 * Math.sin(t * 0.35);
    moonCore.material.opacity = 0.9 + 0.1 * Math.sin(t * 0.35 + 1.2);
    // haze drifts
    haze.children.forEach((m, i) => {
      m.position.x += Math.sin(t * 0.05 + i * 1.7) * 0.0015;
      m.position.y = 3.2 + i * 0.6 + Math.sin(t * 0.07 + i) * 0.12;
    });
    // dust drifts inside the beam
    dust.update(dt, t);
    // a breathing spotlight (very subtle: the stage should feel alive, not flickering)
    spot.intensity = 170 * (0.96 + 0.04 * Math.sin(t * 0.62)) * level;
    foot.intensity = 1.6 * (0.9 + 0.1 * Math.sin(t * 0.9 + 2.1)) * level;
    mirror.material.uniforms.tDiffuse.value.needsUpdate = false;
  }

  function resize() {
    // the mirror target is fixed-size on purpose (its blur budget does not scale with DPR)
  }

  function setQuality(q) {
    mirror.visible = q?.mirror !== false;
    dust.points.visible = q?.dust !== false;
  }

  return { update, resize, setQuality, env, moon, spot, mirror, root: scene };
}

// ------------------------------------------------------------------ helpers

function makeGlowTexture(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStars(n) {
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = 40 + Math.random() * 55;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.random() * Math.PI * 0.42;
    pos[i * 3] = Math.cos(th) * Math.cos(ph) * r;
    pos[i * 3 + 1] = 6 + Math.sin(ph) * r * 0.8;
    pos[i * 3 + 2] = Math.sin(th) * Math.cos(ph) * r - 20;
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0.6 } },
    vertexShader: /* glsl */`
      attribute float aSeed; varying float vS;
      void main(){
        vS = aSeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (1.0 + 2.2 * aSeed);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uOpacity; varying float vS;
      void main(){
        vec2 c = gl_PointCoord - 0.5; float d = dot(c, c) * 4.0;
        float tw = 0.55 + 0.45 * sin(uTime * (0.6 + vS) + vS * 40.0);
        float a = exp(-d * 5.0) * tw * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.82, 0.88, 1.0), a);
      }`,
  });
  mat.uniforms.uTime.value = 0;
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.update = (t) => { mat.uniforms.uTime.value = t; };
  return pts;
}

function makeDust(n) {
  const base = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    base[i * 3] = (Math.random() - 0.5) * 9;
    base[i * 3 + 1] = Math.random() * 5.5 + 0.1;
    base[i * 3 + 2] = (Math.random() - 0.5) * 8 - 1.5;
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(base.slice(), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos);
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute float aSeed; uniform float uTime; varying float vA;
      void main(){
        vec3 p = position;
        p.y += sin(uTime * (0.08 + aSeed * 0.12) + aSeed * 12.0) * 0.35;
        p.x += sin(uTime * (0.05 + aSeed * 0.07) + aSeed * 7.0) * 0.25;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vA = smoothstep(0.0, 0.6, position.y) * (0.25 + 0.75 * aSeed);
        gl_PointSize = (8.0 + 16.0 * aSeed) / max(0.5, -mv.z);
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main(){
        vec2 c = gl_PointCoord - 0.5; float d = dot(c, c) * 4.0;
        float a = exp(-d * 6.0) * vA * 0.10;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vec3(0.86, 0.9, 1.0), a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  return {
    points,
    update(dt, t) { mat.uniforms.uTime.value = t; },
  };
}
