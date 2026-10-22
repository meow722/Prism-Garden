// ============================================================
// 棱镜花园 Prism Garden — 手势驱动的碎片光场 + 分层生成音乐
// MediaPipe GestureRecognizer（本地 task）+ Canvas 2D + Web Audio
// ============================================================
import { GestureRecognizer, FilesetResolver } from "./vision_bundle.mjs";

// ---------- DOM ----------
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const video = document.getElementById("cam");
const camWrap = document.getElementById("cam-wrap");
const overlay = document.getElementById("cam-overlay");
const octx = overlay.getContext("2d");
const landing = document.getElementById("landing");
const hud = document.getElementById("hud");
const testPanel = document.getElementById("test-panel");
const gestureLabel = document.getElementById("gesture-label");

let W = 0, H = 0, DPR = 1;

// ---------- 三套光谱 / 调式 ----------
const PALETTES = [
  {
    name: "青粉", nameEn: "TEAL · ROSE",
    shards: ["#2dd4bf", "#5eead4", "#14b8a6", "#f472b6", "#f9a8d4", "#e879f9", "#67e8f9"],
    bg: "#f7f5f2", rootMidi: 60, scale: [0, 2, 4, 7, 9]
  },
  {
    name: "蓝紫", nameEn: "BLUE · VIOLET",
    shards: ["#60a5fa", "#818cf8", "#a78bfa", "#c084fc", "#7dd3fc", "#93c5fd", "#d8b4fe"],
    bg: "#f4f5fb", rootMidi: 57, scale: [0, 3, 5, 7, 10]
  },
  {
    name: "蓝橙", nameEn: "SKY · AMBER",
    shards: ["#38bdf8", "#7dd3fc", "#0ea5e9", "#fb923c", "#fdba74", "#fbbf24", "#a3e635"],
    bg: "#f3f7fa", rootMidi: 62, scale: [0, 2, 4, 7, 9]
  }
];
let paletteIdx = 0;
let mixColors = PALETTES[0].shards.map(hexToRgb); // 当前混色
let mixFrom = PALETTES[0].shards.map(hexToRgb);
let mixT = 1; // 0->1 过渡

// ---------- 手势状态 ----------
const GESTURE_ZH = {
  idle: "待机 · IDLE",
  Open_Palm: "张掌 · 生长 GATHER",
  Closed_Fist: "握拳 · 凝结 CRYSTALLIZE",
  Pointing_Up: "食指 · 流光 TRACE",
  Victory: "剪刀 · 绽放 BLOOM",
  OK: "OK · 换谱 SHIFT"
};
const CONF_THRESHOLD = 0.7;
let gesture = "idle";
let candidate = "idle";
let candidateCount = 0;
let prevGesture = "idle";

// ---------- 手 / 鼠标 ----------
const hand = { present: false, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, dirX: 1, dirY: 0 };
let testMode = false;
let skeletonOn = true;
let soundOn = true;

// ---------- 碎片 ----------
const N_SHARDS = 150;
let shards = [];
const rain = [];

function makeShards() {
  shards = [];
  for (let i = 0; i < N_SHARDS; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    shards.push({
      rx: x, ry: y, x, y,
      vx: 0, vy: 0,
      z: Math.random() * 2 - 1,
      vz: 0,
      size: 16 + Math.random() * 30,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.01,
      cIdx: Math.floor(Math.random() * PALETTES[0].shards.length),
      shape: Math.floor(Math.random() * 3),
      seed: Math.random() * 1000
    });
  }
  rain.length = 0;
  for (let i = 0; i < 70; i++) {
    rain.push({ x: Math.random() * W, y: Math.random() * H, len: 12 + Math.random() * 30, sp: 2 + Math.random() * 4 });
  }
}

// ---------- 尺寸 ----------
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  overlay.width = 230; overlay.height = 172;
}
window.addEventListener("resize", resize);
resize();
makeShards();

// ============================================================
// 音频引擎
// ============================================================
let actx = null, master = null, reverb = null;
let padGain = null, padFilter = null, padOscs = [];
let schedulerId = null;
let step = 0, nextStepTime = 0;
const STEP_DUR = 0.14;

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function makeImpulse(ac, dur = 2.4, decay = 2.6) {
  const rate = ac.sampleRate;
  const len = rate * dur;
  const buf = ac.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function initAudio() {
  if (actx) { actx.resume(); return; }
  actx = new (window.AudioContext || window.webkitAudioContext)();
  master = actx.createGain();
  master.gain.value = soundOn ? 0.9 : 0;
  reverb = actx.createConvolver();
  reverb.buffer = makeImpulse(actx);
  const revGain = actx.createGain();
  revGain.gain.value = 0.45;
  master.connect(actx.destination);
  master.connect(reverb);
  reverb.connect(revGain);
  revGain.connect(actx.destination);

  // Pad：两个失谐锯齿 + 低通
  padFilter = actx.createBiquadFilter();
  padFilter.type = "lowpass";
  padFilter.frequency.value = 900;
  padGain = actx.createGain();
  padGain.gain.value = 0.02;
  padFilter.connect(padGain);
  padGain.connect(master);
  padGain.connect(reverb);
  for (let i = 0; i < 3; i++) {
    const o = actx.createOscillator();
    o.type = "sawtooth";
    o.detune.value = (i - 1) * 7;
    o.connect(padFilter);
    o.start();
    padOscs.push(o);
  }
  setPadChord();

  nextStepTime = actx.currentTime + 0.1;
  schedulerId = setInterval(scheduler, 50);
}

function setPadChord() {
  if (!actx) return;
  const p = PALETTES[paletteIdx];
  const chord = [0, 7, 12];
  padOscs.forEach((o, i) => {
    o.frequency.setTargetAtTime(midiToFreq(p.rootMidi + chord[i]), actx.currentTime, 0.15);
  });
}

function note(deg, octave, when, dur, type, peak, sendRev = true) {
  const p = PALETTES[paletteIdx];
  const semi = p.scale[((deg % p.scale.length) + p.scale.length) % p.scale.length];
  const f = midiToFreq(p.rootMidi + semi + octave * 12);
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type;
  o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g);
  g.connect(master);
  if (sendRev) g.connect(reverb);
  o.start(when);
  o.stop(when + dur + 0.05);
}

function kick(when) {
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.frequency.setValueAtTime(130, when);
  o.frequency.exponentialRampToValueAtTime(45, when + 0.18);
  g.gain.setValueAtTime(0.5, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.28);
  o.connect(g); g.connect(master);
  o.start(when); o.stop(when + 0.3);
}

function scheduler() {
  if (!actx || actx.state !== "running") return;
  while (nextStepTime < actx.currentTime + 0.18) {
    scheduleStep(nextStepTime, step);
    nextStepTime += STEP_DUR;
    step++;
  }
}

function scheduleStep(when, s) {
  // 握拳：低音脉冲（每 4 步）
  if (gesture === "Closed_Fist" && s % 4 === 0) kick(when);
  // 食指：上行琶音（每 2 步）
  if (gesture === "Pointing_Up" && s % 2 === 0) {
    const deg = (s / 2) % 5;
    note(deg, 1, when, 0.5, "triangle", 0.16);
  }
  // 剪刀：随机高频风铃
  if (gesture === "Victory" && Math.random() < 0.5) {
    const deg = Math.floor(Math.random() * 5);
    note(deg, 2, when, 0.9, "sine", 0.12);
  }
}

// 手势边缘一次性音效
function edgeSound(g) {
  if (!actx || !soundOn) return;
  const t = actx.currentTime;
  if (g === "Closed_Fist") kick(t);
  if (g === "Pointing_Up") note(0, 1, t, 0.5, "triangle", 0.18);
  if (g === "Victory") {
    for (let i = 0; i < 6; i++) note(i, 2, t + i * 0.05, 1.0, "sine", 0.12);
  }
  if (g === "OK") {
    for (let i = 0; i < 5; i++) note(i, 1, t + i * 0.07, 0.7, "triangle", 0.14);
  }
}

function updatePadTarget() {
  if (!padGain || !actx) return;
  let target = 0.02;
  if (gesture === "Open_Palm") target = 0.11;
  if (gesture === "Closed_Fist") target = 0.06;
  if (gesture === "Victory") target = 0.08;
  padGain.gain.setTargetAtTime(target, actx.currentTime, 0.4);
}

// ============================================================
// MediaPipe
// ============================================================
let recognizer = null;
let lastVideoTime = -1;

async function initRecognizer() {
  const vision = await FilesetResolver.forVisionTasks("./wasm");
  recognizer = await GestureRecognizer.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "./gesture_recognizer.task",
      delegate: "CPU"
    },
    runningMode: "VIDEO",
    numHands: 1
  });
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 }, audio: false
    });
    video.srcObject = stream;
    await video.play();
    camWrap.classList.remove("hidden");
    return true;
  } catch (e) {
    console.warn("摄像头不可用，进入测试模式", e);
    return false;
  }
}

function detectFrame() {
  if (recognizer && video.readyState >= 2 && video.videoWidth > 0) {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const now = performance.now();
      let result;
      try {
        result = recognizer.recognizeForVideo(video, now);
      } catch (e) { result = null; }
      if (result && result.gestures && result.gestures.length > 0) {
        const cat = result.gestures[0][0];
        const lms = result.landmarks[0];
        if (cat.score >= CONF_THRESHOLD) feedCandidate(cat.categoryName);
        else feedCandidate("idle");
        updateHandFromLandmarks(lms);
        if (skeletonOn) drawSkeleton(lms);
      } else {
        feedCandidate("idle");
        hand.present = false;
        octx.clearRect(0, 0, overlay.width, overlay.height);
      }
    }
  }
}

function updateHandFromLandmarks(lms) {
  // 手掌中心：关键点 9，映射到屏幕（镜像）
  const lm = lms[9];
  const nx = 1 - lm.x;
  const ny = lm.y;
  hand.px = hand.x; hand.py = hand.y;
  hand.x = nx * W;
  hand.y = ny * H;
  hand.vx = hand.x - hand.px;
  hand.vy = hand.y - hand.py;
  hand.present = true;
  // 食指指向：5 -> 8（镜像后 dirX = 5.x - 8.x）
  const tip = lms[8], mcp = lms[5];
  let dx = mcp.x - tip.x;
  let dy = tip.y - mcp.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  if (Math.hypot(dx, dy) > 0.4) { hand.dirX = dx; hand.dirY = dy; }
}

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]
];

function drawSkeleton(lms) {
  const w = overlay.width, h = overlay.height;
  octx.clearRect(0, 0, w, h);
  octx.strokeStyle = "rgba(255,255,255,0.85)";
  octx.lineWidth = 2;
  octx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    octx.moveTo(lms[a].x * w, lms[a].y * h);
    octx.lineTo(lms[b].x * w, lms[b].y * h);
  }
  octx.stroke();
  octx.fillStyle = "#f472b6";
  for (const p of lms) {
    octx.beginPath();
    octx.arc(p.x * w, p.y * h, 2.6, 0, Math.PI * 2);
    octx.fill();
  }
}

// 手势平滑：连续 3 帧才切换
function feedCandidate(name) {
  if (name === candidate) {
    candidateCount++;
  } else {
    candidate = name;
    candidateCount = 1;
  }
  if (candidateCount >= 3 && candidate !== gesture) {
    setGesture(candidate);
  }
}

function setGesture(name) {
  prevGesture = gesture;
  gesture = name;
  gestureLabel.textContent = GESTURE_ZH[name];
  // 边缘事件
  if (name === "Victory") burstShards();
  if (name === "OK") shiftPalette();
  edgeSound(name);
  updatePadTarget();
  // 测试面板高亮
  document.querySelectorAll(".test-btns button").forEach(b => {
    b.classList.toggle("active", b.dataset.g === name);
  });
}

// ============================================================
// 碎片物理
// ============================================================
function burstShards() {
  for (const m of shards) {
    const dx = m.x - hand.x, dy = m.y - hand.y;
    const d = Math.hypot(dx, dy) || 1;
    const power = 16 * (1 - Math.min(d / 1200, 0.9));
    m.vx += dx / d * power;
    m.vy += dy / d * power;
    m.vz += (Math.random() - 0.5) * 0.08;
  }
}

function shiftPalette() {
  mixFrom = mixColors.map(c => ({ ...c }));
  paletteIdx = (paletteIdx + 1) % PALETTES.length;
  mixT = 0;
  document.body.style.background = PALETTES[paletteIdx].bg;
  setPadChord();
}

function applyForces() {
  const present = hand.present;
  for (const m of shards) {
    let fx = 0, fy = 0;
    if (present) {
      const dx = hand.x - m.x, dy = hand.y - m.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      if (gesture === "Open_Palm") {
        // 汇聚到掌心周围的轨道 + 旋涡
        const r0 = 22 + m.size * 0.5 + m.z * 8;
        const k = 0.014;
        fx += ux * (d - r0) * k;
        fy += uy * (d - r0) * k;
        fx += -uy * 0.18;
        fy += ux * 0.18;
      } else if (gesture === "Closed_Fist") {
        // 强压缩
        const r0 = 12;
        const k = 0.03;
        fx += ux * (d - r0) * k;
        fy += uy * (d - r0) * k;
        fx += -uy * 0.08;
        fy += ux * 0.08;
      } else if (gesture === "Pointing_Up") {
        // 沿食指方向的光束
        const rx = m.x - hand.x, ry = m.y - hand.y;
        const along = rx * hand.dirX + ry * hand.dirY;
        if (along > -30 && along < 900 && Math.abs(rx * hand.dirY - ry * hand.dirX) < 180) {
          fx += hand.dirX * 0.5;
          fy += hand.dirY * 0.5;
        }
        // 轻微吸引保持连续
        if (d < 300) { fx += ux * 0.15; fy += uy * 0.15; }
      } else if (gesture === "Victory") {
        // 持续向外
        if (d < 500) { fx += ux * 0.35; fy += uy * 0.35; }
      }
    }
    // 静止时回位（轻微）
    if (!present || gesture === "idle" || gesture === "OK") {
      fx += (m.rx - m.x) * 0.004;
      fy += (m.ry - m.y) * 0.004;
    }
    m.vx += fx;
    m.vy += fy;
    // 阻尼
    m.vx *= 0.92;
    m.vy *= 0.92;
    m.x += m.vx;
    m.y += m.vy;
    // 深度
    m.vz += (Math.random() - 0.5) * 0.002;
    m.vz *= 0.95;
    m.z += m.vz;
    m.z = Math.max(-1, Math.min(1, m.z));
    // 旋转跟速度
    m.vr += (Math.abs(m.vx) + Math.abs(m.vy)) * 0.0004;
    m.vr *= 0.96;
    m.rot += m.vr + 0.002;
    // 边界回弹
    if (m.x < -60) { m.x = -60; m.vx *= -0.6; }
    if (m.x > W + 60) { m.x = W + 60; m.vx *= -0.6; }
    if (m.y < -60) { m.y = -60; m.vy *= -0.6; }
    if (m.y > H + 60) { m.y = H + 60; m.vy *= -0.6; }
  }
}

// ============================================================
// 渲染
// ============================================================
function lerp(a, b, t) { return a + (b - a) * t; }
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgba(c, a) { return `rgba(${c.r|0},${c.g|0},${c.b|0},${a})`; }

function updateColorMix() {
  if (mixT < 1) {
    mixT = Math.min(1, mixT + 0.02);
    const target = PALETTES[paletteIdx].shards.map(hexToRgb);
    for (let i = 0; i < mixColors.length; i++) {
      mixColors[i].r = lerp(mixFrom[i].r, target[i].r, mixT);
      mixColors[i].g = lerp(mixFrom[i].g, target[i].g, mixT);
      mixColors[i].b = lerp(mixFrom[i].b, target[i].b, mixT);
    }
  }
}

function drawBackground(t) {
  const p = PALETTES[paletteIdx];
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  // 三个漂浮光斑
  const blobs = [
    { c: mixColors[0], x: W * 0.18 + Math.sin(t * 0.0002) * 60, y: H * 0.2, r: Math.max(W, H) * 0.45 },
    { c: mixColors[3] || mixColors[1], x: W * 0.85, y: H * 0.25 + Math.cos(t * 0.00018) * 60, r: Math.max(W, H) * 0.4 },
    { c: mixColors[2] || mixColors[1], x: W * 0.7, y: H * 0.9, r: Math.max(W, H) * 0.45 }
  ];
  for (const b of blobs) {
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, rgba(b.c, 0.12));
    g.addColorStop(1, rgba(b.c, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawShard(m) {
  const depth = 1 + m.z * 0.35;
  let scale = depth;
  if (gesture === "Closed_Fist") scale *= 0.82;
  if (gesture === "Victory") scale *= 1.08;
  const s = m.size * scale;
  const c = mixColors[m.cIdx % mixColors.length];
  const alpha = 0.32 + (m.z + 1) * 0.18;
  ctx.save();
  ctx.translate(m.x, m.y);
  ctx.rotate(m.rot);
  // 填充
  ctx.beginPath();
  if (m.shape === 0) {
    // 菱形
    ctx.moveTo(0, -s * 0.7);
    ctx.lineTo(s * 0.5, 0);
    ctx.lineTo(0, s * 0.7);
    ctx.lineTo(-s * 0.5, 0);
  } else if (m.shape === 1) {
    // 鳞片（透镜）
    ctx.moveTo(0, -s * 0.7);
    ctx.quadraticCurveTo(s * 0.6, -s * 0.1, 0, s * 0.7);
    ctx.quadraticCurveTo(-s * 0.6, -s * 0.1, 0, -s * 0.7);
  } else {
    // 三角
    ctx.moveTo(0, -s * 0.7);
    ctx.lineTo(s * 0.6, s * 0.5);
    ctx.lineTo(-s * 0.6, s * 0.5);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(0, -s, 0, s);
  g.addColorStop(0, rgba(c, alpha + 0.15));
  g.addColorStop(1, rgba(c, alpha * 0.5));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = rgba({ r: 255, g: 255, b: 255 }, 0.7);
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // 高光
  ctx.beginPath();
  ctx.arc(-s * 0.15, -s * 0.25, s * 0.09, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fill();
  ctx.restore();
}

function drawRain() {
  if (gesture !== "Victory") return;
  ctx.strokeStyle = rgba(mixColors[0], 0.35);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const r of rain) {
    r.y += r.sp;
    if (r.y > H) { r.y = -r.len; r.x = Math.random() * W; }
    ctx.moveTo(r.x, r.y);
    ctx.lineTo(r.x, r.y + r.len);
  }
  ctx.stroke();
}

function drawBeam() {
  if (gesture !== "Pointing_Up" || !hand.present) return;
  const c = mixColors[3] || mixColors[0];
  const len = 720;
  const tx = hand.x + hand.dirX * len, ty = hand.y + hand.dirY * len;
  const px = -hand.dirY, py = hand.dirX;
  const w0 = 28, w1 = 4;
  const grad = ctx.createLinearGradient(hand.x, hand.y, tx, ty);
  grad.addColorStop(0, rgba(c, 0.32));
  grad.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(hand.x + px * w0, hand.y + py * w0);
  ctx.lineTo(tx + px * w1, ty + py * w1);
  ctx.lineTo(tx - px * w1, ty - py * w1);
  ctx.lineTo(hand.x - px * w0, hand.y - py * w0);
  ctx.closePath();
  ctx.fill();
}

function drawHandGlow() {
  if (!hand.present) return;
  const c = mixColors[0];
  const r = gesture === "Closed_Fist" ? 120 : 220;
  const g = ctx.createRadialGradient(hand.x, hand.y, 0, hand.x, hand.y, r);
  g.addColorStop(0, rgba(c, gesture === "idle" ? 0.05 : 0.18));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function render(t) {
  updateColorMix();
  drawBackground(t);
  drawRain();
  drawBeam();
  // 按深度排序，先画远的
  const sorted = [...shards].sort((a, b) => a.z - b.z);
  for (const m of sorted) drawShard(m);
  drawHandGlow();
}

// ============================================================
// 主循环
// ============================================================
function loop(t) {
  detectFrame();
  applyForces();
  render(t);
  requestAnimationFrame(loop);
}

// ============================================================
// 测试模式（鼠标 + 键盘）
// ============================================================
function enterTestMode() {
  testMode = true;
  testPanel.classList.remove("hidden");
  hand.present = true;
  hand.x = W / 2; hand.y = H / 2;
}

window.addEventListener("mousemove", (e) => {
  if (!testMode) return;
  hand.px = hand.x; hand.py = hand.y;
  hand.x = e.clientX; hand.y = e.clientY;
  hand.vx = hand.x - hand.px; hand.vy = hand.y - hand.py;
  hand.present = true;
  const d = Math.hypot(hand.vx, hand.vy);
  if (gesture === "Pointing_Up" && d > 1) {
    hand.dirX = hand.vx / d; hand.dirY = hand.vy / d;
  }
});

window.addEventListener("keydown", (e) => {
  const map = {
    "0": "idle", "1": "Open_Palm", "2": "Closed_Fist",
    "3": "Pointing_Up", "4": "Victory", "5": "OK"
  };
  if (map[e.key]) {
    candidate = map[e.key]; candidateCount = 3;
    setGesture(map[e.key]);
  }
});

document.querySelectorAll(".test-btns button").forEach(b => {
  b.addEventListener("click", () => {
    const g = b.dataset.g;
    candidate = g; candidateCount = 3;
    setGesture(g);
  });
});

// ============================================================
// 按钮
// ============================================================
document.getElementById("btn-start").addEventListener("click", async () => {
  initAudio();
  landing.classList.add("hidden");
  hud.classList.remove("hidden");
  // 先加载识别器（?norecog=1 可跳过，用于无摄像头环境调试）
  try {
    if (!recognizer && !new URLSearchParams(location.search).has("norecog")) {
      await initRecognizer();
    }
  } catch (e) {
    console.warn("MediaPipe 初始化失败", e);
  }
  const ok = await startCamera();
  if (!ok) enterTestMode();
});

document.getElementById("btn-skeleton").addEventListener("click", (e) => {
  skeletonOn = !skeletonOn;
  e.target.textContent = "骨架：" + (skeletonOn ? "开" : "关");
  if (!skeletonOn) octx.clearRect(0, 0, overlay.width, overlay.height);
});

document.getElementById("btn-sound").addEventListener("click", (e) => {
  soundOn = !soundOn;
  e.target.textContent = "音效：" + (soundOn ? "开" : "关");
  if (master) master.gain.setTargetAtTime(soundOn ? 0.9 : 0, actx.currentTime, 0.1);
});

document.getElementById("btn-guide").addEventListener("click", () => {
  landing.classList.remove("hidden");
});

document.getElementById("btn-test").addEventListener("click", () => {
  enterTestMode();
});

requestAnimationFrame(loop);
//（注：内容由AI生成）
