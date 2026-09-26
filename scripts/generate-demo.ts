/**
 * Generates the bundled demo clip (public/demo/street-scene.mp4).
 *
 * The clip is rendered procedurally so the repository ships no third-party
 * footage. It is a locked-off "street" shot with four moving subjects that the
 * demo suggestions refer to: a red car, a man in a blue shirt, his dog, and a
 * man in a red shirt on the far sidewalk.
 *
 *   npm run demo:generate
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import ffmpegStatic from "ffmpeg-static";

const WIDTH = 960;
const HEIGHT = 540;
const FPS = 30;
const SECONDS = 10;
const FRAMES = FPS * SECONDS;

const OUT = path.join(process.cwd(), "public", "demo", "street-scene.mp4");

type Ctx = SKRSContext2D;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// ---------------------------------------------------------------------------
// Static background (rendered once)
// ---------------------------------------------------------------------------
function drawBackground(ctx: Ctx) {
  const sky = ctx.createLinearGradient(0, 0, 0, 300);
  sky.addColorStop(0, "#8fc1e3");
  sky.addColorStop(1, "#dcebf4");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, 300);

  // Sun
  ctx.fillStyle = "rgba(255, 244, 214, 0.9)";
  ctx.beginPath();
  ctx.arc(812, 70, 34, 0, Math.PI * 2);
  ctx.fill();

  // Skyline
  const rand = rng(7);
  let x = -10;
  while (x < WIDTH + 20) {
    const w = 60 + Math.floor(rand() * 70);
    const h = 70 + Math.floor(rand() * 120);
    const shade = 120 + Math.floor(rand() * 30);
    ctx.fillStyle = `rgb(${shade - 20}, ${shade}, ${shade + 22})`;
    ctx.fillRect(x, 300 - h, w, h);
    ctx.fillStyle = `rgba(235, 242, 250, 0.55)`;
    for (let wy = 300 - h + 12; wy < 290; wy += 18) {
      for (let wx = x + 8; wx < x + w - 10; wx += 16) {
        if (rand() > 0.35) ctx.fillRect(wx, wy, 7, 9);
      }
    }
    x += w + 4;
  }

  // Trees
  for (const tx of [150, 420, 690, 900]) {
    ctx.fillStyle = "#6b4f3a";
    ctx.fillRect(tx - 5, 250, 10, 52);
    ctx.fillStyle = "#3f7a4a";
    ctx.beginPath();
    ctx.arc(tx, 238, 30, 0, Math.PI * 2);
    ctx.arc(tx - 20, 252, 22, 0, Math.PI * 2);
    ctx.arc(tx + 20, 252, 22, 0, Math.PI * 2);
    ctx.fill();
  }

  // Far sidewalk
  ctx.fillStyle = "#c9c1b3";
  ctx.fillRect(0, 300, WIDTH, 32);
  ctx.fillStyle = "#b7ae9f";
  ctx.fillRect(0, 330, WIDTH, 3);

  // Road
  const road = ctx.createLinearGradient(0, 333, 0, 440);
  road.addColorStop(0, "#4b4f57");
  road.addColorStop(1, "#3d4148");
  ctx.fillStyle = road;
  ctx.fillRect(0, 333, WIDTH, 107);
  ctx.fillStyle = "#e9e5d8";
  for (let dx = 10; dx < WIDTH; dx += 90) ctx.fillRect(dx, 385, 48, 4);

  // Near sidewalk + curb
  ctx.fillStyle = "#9c968c";
  ctx.fillRect(0, 440, WIDTH, 8);
  ctx.fillStyle = "#d8d1c4";
  ctx.fillRect(0, 448, WIDTH, HEIGHT - 448);
  ctx.strokeStyle = "rgba(150, 142, 130, 0.45)";
  ctx.lineWidth = 1;
  for (let sx = 0; sx < WIDTH; sx += 80) {
    ctx.beginPath();
    ctx.moveTo(sx, 448);
    ctx.lineTo(sx - 30, HEIGHT);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, 492);
  ctx.lineTo(WIDTH, 492);
  ctx.stroke();

  // Lamp posts (static props)
  for (const lx of [260, 780]) {
    ctx.fillStyle = "#2f3338";
    ctx.fillRect(lx - 3, 360, 6, 92);
    ctx.fillRect(lx - 3, 360, 26, 5);
    ctx.fillStyle = "#f3e7b5";
    ctx.fillRect(lx + 14, 365, 10, 6);
  }
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------
function shadow(ctx: Ctx, cx: number, cy: number, rx: number, ry: number) {
  ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

function limb(ctx: Ctx, x: number, y: number, len: number, angle: number, width: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.sin(angle) * len, y + Math.cos(angle) * len);
  ctx.stroke();
}

interface PersonStyle {
  shirt: string;
  shirtShade: string;
  pants: string;
  skin: string;
  hair: string;
}

function person(ctx: Ctx, x: number, feetY: number, h: number, phase: number, style: PersonStyle) {
  const swing = Math.sin(phase) * 0.42;
  const hipY = feetY - h * 0.47;
  const shoulderY = feetY - h * 0.8;
  const legLen = h * 0.45;
  const armLen = h * 0.34;

  shadow(ctx, x, feetY + 2, h * 0.16, h * 0.03);

  // back limbs
  limb(ctx, x, shoulderY + h * 0.03, armLen, -swing, h * 0.065, style.shirtShade);
  limb(ctx, x, hipY, legLen, swing, h * 0.095, shade(style.pants, -18));

  // torso
  ctx.fillStyle = style.shirt;
  roundRect(ctx, x - h * 0.12, shoulderY - h * 0.02, h * 0.24, h * 0.36, h * 0.05);
  ctx.fill();

  // front leg
  limb(ctx, x, hipY, legLen, -swing, h * 0.095, style.pants);
  // shoes
  ctx.fillStyle = "#2a2a2e";
  for (const s of [swing, -swing]) {
    const fx = x + Math.sin(s) * legLen;
    const fy = hipY + Math.cos(s) * legLen;
    ctx.beginPath();
    ctx.ellipse(fx - h * 0.02, fy, h * 0.05, h * 0.025, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // head + neck
  ctx.fillStyle = style.skin;
  ctx.fillRect(x - h * 0.025, shoulderY - h * 0.06, h * 0.05, h * 0.07);
  ctx.beginPath();
  ctx.arc(x, shoulderY - h * 0.12, h * 0.085, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = style.hair;
  ctx.beginPath();
  ctx.arc(x, shoulderY - h * 0.14, h * 0.087, Math.PI * 0.95, Math.PI * 2.05);
  ctx.fill();

  // front arm (sleeve + hand)
  limb(ctx, x, shoulderY + h * 0.03, armLen * 0.55, swing, h * 0.07, style.shirt);
  const ex = x + Math.sin(swing) * armLen * 0.55;
  const ey = shoulderY + h * 0.03 + Math.cos(swing) * armLen * 0.55;
  limb(ctx, ex, ey, armLen * 0.45, swing * 0.6, h * 0.055, style.skin);
}

function dog(ctx: Ctx, x: number, groundY: number, s: number, phase: number, facingLeft: boolean) {
  const dir = facingLeft ? -1 : 1;
  const body = "#a8692f";
  const dark = "#7d4b1f";
  shadow(ctx, x, groundY + 1, s * 0.55, s * 0.08);
  const bodyY = groundY - s * 0.55;
  const legLen = s * 0.42;
  const sw = Math.sin(phase * 1.6) * 0.5;
  for (const [ox, a, c] of [
    [-0.28, sw, dark],
    [0.28, -sw, dark],
    [-0.22, -sw, body],
    [0.34, sw, body],
  ] as const) {
    limb(ctx, x + ox * s * dir, bodyY + s * 0.08, legLen, a, s * 0.1, c);
  }
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(x, bodyY, s * 0.46, s * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // tail
  limb(ctx, x - s * 0.44 * dir, bodyY - s * 0.05, s * 0.3, -dir * (2.3 + Math.sin(phase * 3) * 0.3), s * 0.07, body);
  // head
  const hx = x + s * 0.48 * dir;
  const hy = bodyY - s * 0.22;
  ctx.beginPath();
  ctx.arc(hx, hy, s * 0.17, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(hx + s * 0.16 * dir, hy + s * 0.05, s * 0.12, s * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(hx - s * 0.06 * dir, hy - s * 0.02, s * 0.06, s * 0.13, 0.3 * dir, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1d1d1f";
  ctx.beginPath();
  ctx.arc(hx + s * 0.26 * dir, hy + s * 0.03, s * 0.035, 0, Math.PI * 2);
  ctx.fill();
}

function car(ctx: Ctx, x: number, groundY: number, t: number) {
  const w = 210;
  const bodyH = 50;
  const red = "#d63a2f";
  shadow(ctx, x + w / 2, groundY + 2, w * 0.52, 7);

  // cabin
  ctx.fillStyle = "#c2352b";
  ctx.beginPath();
  ctx.moveTo(x + 50, groundY - bodyH - 8);
  ctx.lineTo(x + 78, groundY - bodyH - 44);
  ctx.lineTo(x + 146, groundY - bodyH - 44);
  ctx.lineTo(x + 176, groundY - bodyH - 8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#bfe0f2";
  ctx.beginPath();
  ctx.moveTo(x + 64, groundY - bodyH - 10);
  ctx.lineTo(x + 84, groundY - bodyH - 38);
  ctx.lineTo(x + 110, groundY - bodyH - 38);
  ctx.lineTo(x + 110, groundY - bodyH - 10);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + 118, groundY - bodyH - 10);
  ctx.lineTo(x + 118, groundY - bodyH - 38);
  ctx.lineTo(x + 142, groundY - bodyH - 38);
  ctx.lineTo(x + 162, groundY - bodyH - 10);
  ctx.closePath();
  ctx.fill();

  // body
  ctx.fillStyle = red;
  roundRect(ctx, x, groundY - bodyH - 12, w, bodyH, 14);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(x + 12, groundY - bodyH - 2, w - 24, 3);
  ctx.fillStyle = "#ffe9a8";
  roundRect(ctx, x + w - 12, groundY - bodyH - 2, 10, 9, 3);
  ctx.fill();
  ctx.fillStyle = "#8f1d17";
  roundRect(ctx, x + 2, groundY - bodyH - 2, 8, 9, 3);
  ctx.fill();

  // wheels
  for (const wx of [x + 48, x + w - 48]) {
    ctx.fillStyle = "#1c1d20";
    ctx.beginPath();
    ctx.arc(wx, groundY - 18, 19, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#9aa0a8";
    ctx.beginPath();
    ctx.arc(wx, groundY - 18, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#5d6168";
    ctx.lineWidth = 2;
    for (let k = 0; k < 3; k++) {
      const a = t * 0.35 + (k * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.moveTo(wx, groundY - 18);
      ctx.lineTo(wx + Math.cos(a) * 12, groundY - 18 + Math.sin(a) * 12);
      ctx.stroke();
    }
  }
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + amt));
  return `rgb(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

const blueShirt: PersonStyle = { shirt: "#2f66c9", shirtShade: "#24509e", pants: "#3b3f48", skin: "#e0b08c", hair: "#2b2019" };
const redShirt: PersonStyle = { shirt: "#cf3a2e", shirtShade: "#a02b22", pants: "#5a4a3a", skin: "#8d5a3b", hair: "#141414" };

/** Subjects in back-to-front draw order. */
const SUBJECTS: Array<{ id: string; draw: (ctx: Ctx, f: number) => void }> = [
  // Far sidewalk: man in the red shirt walks left → right.
  { id: "man_red_shirt", draw: (ctx, f) => person(ctx, 70 + f * 2.0, 326, 78, f * 0.24, redShirt) },
  // Road: red car drives left → right.
  { id: "red_car", draw: (ctx, f) => car(ctx, -120 + f * 4.1, 428, f) },
  // Near sidewalk: man in the blue shirt walks right → left with his dog ahead.
  { id: "man_blue_shirt", draw: (ctx, f) => person(ctx, 900 - f * 2.4, 520, 158, f * 0.2, blueShirt) },
  { id: "dog", draw: (ctx, f) => dog(ctx, 900 - f * 2.4 - 110, 522, 70, f * 0.2, true) },
];

/**
 * Ground-truth visible masks (every GT_STEP frames, at the default 512×288
 * analysis size) used by tests to measure segmentation/tracking quality.
 * Occlusion-aware: a subject's mask excludes subjects drawn in front of it.
 */
const GT_W = 512;
const GT_H = 288;
const GT_STEP = 5;

function encodeRle(mask: Uint8Array): number[] {
  const counts: number[] = [];
  let cur = 0;
  let run = 0;
  for (const v of mask) {
    if ((v ? 1 : 0) === cur) run++;
    else {
      counts.push(run);
      cur ^= 1;
      run = 1;
    }
  }
  counts.push(run);
  return counts;
}

function writeGroundTruth() {
  const c = createCanvas(GT_W, GT_H);
  const ctx = c.getContext("2d");
  const out: Record<string, Record<string, number[]>> = Object.fromEntries(SUBJECTS.map((s) => [s.id, {}]));
  for (let f = 0; f < FRAMES; f += GT_STEP) {
    const alphas = SUBJECTS.map((subj) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, GT_W, GT_H);
      ctx.setTransform(GT_W / WIDTH, 0, 0, GT_H / HEIGHT, 0, 0);
      subj.draw(ctx, f);
      const d = ctx.getImageData(0, 0, GT_W, GT_H).data;
      const m = new Uint8Array(GT_W * GT_H);
      for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 128 ? 1 : 0;
      return m;
    });
    SUBJECTS.forEach((subj, k) => {
      const visible = alphas[k].slice();
      for (let j = k + 1; j < alphas.length; j++) for (let i = 0; i < visible.length; i++) if (alphas[j][i]) visible[i] = 0;
      out[subj.id][f] = encodeRle(visible);
    });
  }
  const file = path.join(process.cwd(), "tests", "fixtures", "street-scene-gt.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ width: GT_W, height: GT_H, fps: FPS, frameCount: FRAMES, step: GT_STEP, subjects: out }));
  console.log(`Wrote ${file}`);
}

// ---------------------------------------------------------------------------
async function main() {
  writeGroundTruth();
  if (process.argv.includes("--gt-only")) return;

  const ffmpeg = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string);
  if (!ffmpeg) throw new Error("FFmpeg binary not found. Install ffmpeg-static or set FFMPEG_PATH.");
  mkdirSync(path.dirname(OUT), { recursive: true });

  const bg = createCanvas(WIDTH, HEIGHT);
  drawBackground(bg.getContext("2d"));

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  const proc = spawn(
    ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${WIDTH}x${HEIGHT}`, "-r", String(FPS), "-i", "pipe:0",
      "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-metadata", "title=OpenSAM Studio demo (procedurally generated)",
      OUT,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );

  for (let f = 0; f < FRAMES; f++) {
    ctx.drawImage(bg, 0, 0);
    for (const subj of SUBJECTS) subj.draw(ctx, f);

    const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    const ok = proc.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    if (!ok) await new Promise((r) => proc.stdin.once("drain", r));
  }
  proc.stdin.end();
  await new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  console.log(`Wrote ${OUT}`);

  // VP9/WebM copy for browsers without an H.264 decoder (also the demo's preview proxy).
  const webm = OUT.replace(/\.mp4$/, ".webm");
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", OUT, "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p", "-an", webm], { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  console.log(`Wrote ${webm}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
