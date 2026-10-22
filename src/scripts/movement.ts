// A watch movement drawn in code: seven layers, one for each FALK dimension. It turns slowly with the
// balance ticking, spins under a drag, and lifts apart into labelled layers as the page scrolls.
// Loops pause off screen and in hidden tabs; under reduced motion it renders only when touched.
import {
  ACESFilmicToneMapping, BoxGeometry, CatmullRomCurve3, CylinderGeometry, DirectionalLight, ExtrudeGeometry, Group,
  Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Path, PerspectiveCamera, PMREMGenerator, Scene,
  Shape, SRGBColorSpace, TorusGeometry, TubeGeometry, Vector3, WebGLRenderer, type Material,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

type Layer = { code: string; group: Group; base: number; radius: number };

const steel = (color: number, roughness = 0.3) => new MeshStandardMaterial({ color, metalness: 1, roughness });
const MAT = {
  rhodium: steel(0xd9dee6, 0.3),
  case: steel(0xbcc3cd, 0.18),
  gold: steel(0xd2ad6b, 0.32),
  blued: steel(0x23407f, 0.28),
  ruby: new MeshStandardMaterial({ color: 0xb01f3c, metalness: 0.1, roughness: 0.12, emissive: 0x3a0612 }),
  dial: new MeshStandardMaterial({ color: 0xeef0f3, metalness: 0.25, roughness: 0.55 }),
  glass: new MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.04, transmission: 0.92, thickness: 0.05, transparent: true, opacity: 0.35 }),
};

const extrude = (shape: Shape, depth: number, mat: Material) => {
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 2, curveSegments: 48 });
  g.rotateX(-Math.PI / 2); // lie flat, extruded upwards
  return new Mesh(g, mat);
};
const disc = (r: number, h: number, mat: Material) => new Mesh(new CylinderGeometry(r, r, h, 96), mat);
const hole = (r: number, x = 0, y = 0) => { const p = new Path(); p.absarc(x, y, r, 0, Math.PI * 2, true); return p; };

// A gear outline: trapezoid teeth around a rim, with a hub and, on larger wheels, spoke cut-outs.
function gear(r: number, teeth: number, depth: number, mat: Material) {
  const s = new Shape(), tooth = r * 0.09;
  for (let i = 0; i <= teeth * 4; i++) {
    const a = (i / (teeth * 4)) * Math.PI * 2, rr = r + (i % 4 === 1 || i % 4 === 2 ? tooth : 0);
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  if (r > 0.18) for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    s.holes.push(hole(r * 0.28, Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55));
  }
  const hub = disc(r * 0.14, depth * 2.2, MAT.rhodium);
  hub.position.y = depth / 2;
  const g = new Group(); g.add(extrude(s, depth, mat), hub); return g;
}
const jewel = (x: number, z: number, y: number) => { const j = disc(0.035, 0.03, MAT.ruby); j.position.set(x, y, z); return j; };

export function mountMovement(stage: HTMLElement, canvas: HTMLCanvasElement, labels: HTMLElement[], opts: { still: boolean }) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new DirectionalLight(0xffffff, 1.6); key.position.set(3, 6, 4); scene.add(key);
  const camera = new PerspectiveCamera(30, 1, 0.1, 100);

  const movement = new Group(); scene.add(movement);
  const layers: Layer[] = [];
  const layer = (code: string, base: number, radius: number, ...parts: (Mesh | Group)[]) => {
    const g = new Group(); g.add(...parts); g.position.y = base; movement.add(g);
    layers.push({ code, group: g, base, radius });
  };

  // DH: dial with applied indices and blued hands, at the bottom of the stack.
  const indices = new Group();
  for (let i = 0; i < 12; i++) {
    const b = new Mesh(new BoxGeometry(0.03, 0.02, i % 3 ? 0.12 : 0.2), MAT.blued), a = (i / 12) * Math.PI * 2;
    b.position.set(Math.sin(a) * 1.0, 0.03, Math.cos(a) * 1.0); b.rotation.y = a; indices.add(b);
  }
  const hour = new Mesh(new BoxGeometry(0.05, 0.015, 0.55), MAT.blued); hour.position.set(0, 0.05, -0.22);
  const minute = new Mesh(new BoxGeometry(0.035, 0.015, 0.85), MAT.blued); minute.position.set(0.25, 0.065, 0.3); minute.rotation.y = 2.2;
  layer('DH', 0, 1.18, disc(1.18, 0.04, MAT.dial), indices, hour, minute);

  // MM: the mainplate, cut through for the wheels.
  const plate = new Shape(); plate.absarc(0, 0, 1.1, 0, Math.PI * 2, false);
  [[0.35, 0.3, 0.22], [-0.42, -0.2, 0.2], [0.1, -0.55, 0.16]].forEach(([x, y, r]) => plate.holes.push(hole(r, x, y)));
  layer('MM', 0.12, 1.1, extrude(plate, 0.08, MAT.rhodium));

  // MA: the gear train, the movement's architecture.
  const train = new Group();
  ([[0, 0, 0.42, 60], [0.55, 0.38, 0.26, 48], [-0.5, 0.45, 0.22, 40], [0.48, -0.5, 0.18, 30], [-0.2, -0.62, 0.14, 20]] as const)
    .forEach(([x, z, r, t]) => { const g = gear(r, t, 0.035, MAT.gold); g.position.set(x, 0, z); train.add(g); });
  layer('MA', 0.26, 1.0, train);

  // WE: balance wheel and blued hairspring, regulated and ticking.
  const balance = new Group();
  const rim = new Mesh(new TorusGeometry(0.36, 0.035, 16, 96), MAT.gold); rim.rotation.x = Math.PI / 2;
  balance.add(rim);
  for (let k = 0; k < 3; k++) { const s = new Mesh(new BoxGeometry(0.03, 0.02, 0.72), MAT.gold); s.rotation.y = (k / 3) * Math.PI; balance.add(s); }
  const spiral = new CatmullRomCurve3(Array.from({ length: 120 }, (_, i) => {
    const a = i * 0.36, r = 0.04 + i * 0.0019; return new Vector3(Math.cos(a) * r, 0.03, Math.sin(a) * r);
  }));
  balance.add(new Mesh(new TubeGeometry(spiral, 400, 0.004, 6, false), MAT.blued));
  balance.position.set(-0.35, 0, 0.35);
  layer('WE', 0.4, 1.0, balance);

  // CF: finished bridges set with ruby jewels.
  const bridges = new Group();
  const bridgeShape = (w: number, h: number) => {
    const s = new Shape(); s.moveTo(-w, -h); s.lineTo(w, -h);
    s.absarc(w, 0, h, -Math.PI / 2, Math.PI / 2, false); s.lineTo(-w, h); s.absarc(-w, 0, h, Math.PI / 2, Math.PI * 1.5, false); return s;
  };
  ([[0.25, 0.15, 0.55, 0.16, 0.6], [-0.3, -0.35, 0.45, 0.14, -0.4], [0.45, -0.45, 0.3, 0.12, 1.2]] as const).forEach(([x, z, w, h, rot]) => {
    const b = extrude(bridgeShape(w, h), 0.05, MAT.rhodium); b.position.set(x, 0, z); b.rotation.y = rot; bridges.add(b);
  });
  [[0.25, 0.15], [-0.3, -0.35], [0.45, -0.45], [0.6, 0.35], [-0.6, 0.0]].forEach(([x, z]) => bridges.add(jewel(x, z, 0.075)));
  layer('CF', 0.54, 1.0, bridges);

  // PD: the rotor, the brand's own design.
  const rotorShape = new Shape(); rotorShape.absarc(0, 0, 1.0, 0, Math.PI, false); rotorShape.absarc(0, 0, 0.18, Math.PI, 0, true);
  const rotor = new Group(); rotor.add(extrude(rotorShape, 0.05, MAT.gold), disc(0.12, 0.08, MAT.rhodium));
  layer('PD', 0.68, 1.0, rotor);

  // EX: case band, crown and sapphire caseback.
  const band = new Shape(); band.absarc(0, 0, 1.32, 0, Math.PI * 2, false); band.holes.push(hole(1.16));
  const crown = disc(0.1, 0.16, MAT.case); crown.rotation.z = Math.PI / 2; crown.position.set(1.42, 0.06, 0);
  const glass = disc(1.16, 0.02, MAT.glass); glass.position.y = 0.12;
  layer('EX', 0.82, 1.32, extrude(band, 0.14, MAT.case), crown, glass);

  // ── State ──
  let spin = -0.6, vel = opts.still ? 0 : 0.0025, explode = 0, target = 0, manual: number | null = null;
  let onScreen = true, dragging = false, lastX = 0, raf = 0;
  const t0 = performance.now(), tilt = 0.32, anchor = new Vector3();

  // The camera rises and pulls back as the layers spread, so the whole stack stays in frame.
  let narrow = false;
  const aim = () => {
    const back = (narrow ? 7.2 : 5.6) + explode * (narrow ? 4.2 : 3.4), lift = 0.45 + explode * 1.3;
    camera.position.set(0, lift + back * 0.42, back);
    camera.lookAt(0, lift, 0);
  };
  const size = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; narrow = w / h < 1.1;
    camera.updateProjectionMatrix(); aim();
  };

  const frame = (now: number) => {
    const t = (now - t0) / 1000;
    if (!dragging && !opts.still) vel += (0.0025 - vel) * 0.02; // ease back to a slow idle turn
    if (!dragging && opts.still) vel *= 0.9;
    spin += vel;
    explode += (target - explode) * 0.08;
    aim();
    movement.rotation.set(tilt, spin, 0);
    movement.position.x = (narrow ? -0.55 : -0.9) * explode;
    layers.forEach((l, i) => { l.group.position.y = l.base + i * 0.42 * explode; });
    if (!opts.still) {
      balance.rotation.y = Math.sin(t * Math.PI * 2 * 1.2) * 1.1; // the balance ticks
      rotor.rotation.y = Math.sin(t * 0.35) * 0.6;
    }
    movement.updateMatrixWorld();
    renderer.render(scene, camera);
    // Pin each label at its layer's height, beside the movement, and show them as it opens.
    const w = stage.clientWidth, h = stage.clientHeight;
    const show = Math.max(0, Math.min(1, (explode - 0.35) * 2.5));
    layers.forEach((l, i) => {
      anchor.set(0, 0, 0).applyMatrix4(l.group.matrixWorld).project(camera);
      const y = (-anchor.y * 0.5 + 0.5) * h, el = labels[i];
      el.style.translate = `${Math.round(Math.min(w * 0.7, w - el.offsetWidth - 10))}px ${Math.round(y - el.offsetHeight / 2)}px`;
      el.style.opacity = String(show);
      el.hidden = show <= 0.02; // out of the layout while closed, so no text sits there invisible
    });
  };

  const busy = () => dragging || Math.abs(target - explode) > 0.002 || Math.abs(vel) > 0.0004;
  const needsLoop = () => onScreen && !document.hidden && (!opts.still || busy());
  const loop = (now: number) => { frame(now); raf = needsLoop() ? requestAnimationFrame(loop) : 0; };
  const kick = () => { if (!raf && onScreen && !document.hidden) raf = requestAnimationFrame(loop); };

  // Drag to spin, with inertia on release. On touch only a mostly sideways drag turns it, so the page still scrolls.
  let startX = 0, startY = 0, decided = false;
  canvas.addEventListener('pointerdown', e => {
    startX = lastX = e.clientX; startY = e.clientY;
    decided = e.pointerType !== 'touch'; dragging = decided;
    if (decided) canvas.setPointerCapture(e.pointerId);
    kick();
  });
  canvas.addEventListener('pointermove', e => {
    if (!decided) {
      if (e.pointerType !== 'touch' || Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
      decided = true; dragging = Math.abs(e.clientX - startX) > Math.abs(e.clientY - startY);
      if (dragging) canvas.setPointerCapture(e.pointerId);
    }
    if (!dragging) return;
    vel = (e.clientX - lastX) * 0.008; lastX = e.clientX; kick();
  });
  const release = () => { dragging = false; decided = false; kick(); };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // Scroll opens it: it starts once the tile's top passes 55% of the viewport and is fully apart 300px later,
  // so it arrives assembled wherever the tile sits on the page, and closes again on the way back up.
  const onScroll = () => {
    if (manual !== null) return;
    const top = stage.getBoundingClientRect().top;
    target = Math.min(1, Math.max(0, (innerHeight * 0.55 - top) / 300)); kick();
  };
  if (!opts.still) addEventListener('scroll', onScroll, { passive: true }); // under reduced motion only the button opens it

  const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; kick(); });
  io.observe(stage);
  const onVisibility = () => kick();
  document.addEventListener('visibilitychange', onVisibility);
  const ro = new ResizeObserver(() => { size(); frame(performance.now()); kick(); });
  ro.observe(stage);

  size(); if (!opts.still) onScroll(); frame(performance.now()); kick();

  return {
    /** Take it apart or put it back together without scrolling; returns true when apart. */
    toggle() { manual = target > 0.5 ? 0 : 1; target = manual; kick(); return manual === 1; },
    destroy() {
      cancelAnimationFrame(raf); io.disconnect(); ro.disconnect();
      removeEventListener('scroll', onScroll); document.removeEventListener('visibilitychange', onVisibility);
      renderer.dispose(); pmrem.dispose();
    },
  };
}
