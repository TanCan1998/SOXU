/**
 * 极简 PNG 解码 + 像素统计：判断"水波帧"相对"稳定帧"是否真的画出了蓝色光环。
 * 只依赖 node:zlib，无外部依赖。
 */
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

function decodePng(buffer) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    pos += 12 + length;
  }
  if (bitDepth !== 8) throw new Error("只支持 8bit PNG");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error("不支持的 colorType " + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = value & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

const [beforePath, afterPath, ox = "69", oy = "831"] = process.argv.slice(2);
const before = decodePng(await readFile(beforePath));
const after = decodePng(await readFile(afterPath));
if (before.width !== after.width || before.height !== after.height) throw new Error("尺寸不一致");

const originX = Number(ox);
const originY = Number(oy);
const at = (image, x, y) => {
  const index = (y * image.width + x) * image.channels;
  return [image.data[index], image.data[index + 1], image.data[index + 2]];
};

let changed = 0;
let maxBlueExcess = { value: -999, x: 0, y: 0 };
for (let y = 0; y < after.height; y += 1) {
  for (let x = 0; x < after.width; x += 1) {
    const a = at(after, x, y);
    const b = at(before, x, y);
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) changed += 1;
    const diff = a[2] - b[2] - ((a[0] - b[0] + (a[1] - b[1])) / 2);
    if (diff > maxBlueExcess.value) maxBlueExcess = { value: diff, x, y };
  }
}

/** 以点击点为圆心逐半径采样：既算"改写了多少像素"（揭示半径），也算"多出多少蓝"（光晕/水波环）。 */
const profile = [];
for (let radius = 0; radius < 1600; radius += 8) {
  let sum = 0;
  let count = 0;
  let changedOnCircle = 0;
  for (let step = 0; step < 180; step += 1) {
    const angle = (step / 180) * Math.PI * 2;
    const x = Math.round(originX + radius * Math.cos(angle));
    const y = Math.round(originY + radius * Math.sin(angle));
    if (x < 0 || y < 0 || x >= after.width || y >= after.height) continue;
    const a = at(after, x, y);
    const b = at(before, x, y);
    sum += a[2] - b[2] - ((a[0] - b[0] + (a[1] - b[1])) / 2);
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 24) changedOnCircle += 1;
    count += 1;
  }
  if (count > 20) {
    profile.push({
      radius,
      blueDelta: Number((sum / count).toFixed(2)),
      changedOnCircle: Number((changedOnCircle / count).toFixed(2)),
    });
  }
}

const revealed = profile.filter((entry) => entry.changedOnCircle > 0.5);
const changedBand = profile.filter((entry) => entry.changedOnCircle > 0.1);

const band = profile.filter((entry) => entry.blueDelta > 4);
console.log(
  JSON.stringify(
    {
      size: { width: after.width, height: after.height },
      changedPixels: changed,
      changedRatio: Number((changed / (after.width * after.height)).toFixed(5)),
      maxBlueExcess,
      revealedRadius: revealed.length > 0 ? revealed[revealed.length - 1].radius : null,
      changedBand:
        changedBand.length > 0
          ? { from: changedBand[0].radius, to: changedBand[changedBand.length - 1].radius }
          : null,
      ringBand: band.length > 0 ? { from: band[0].radius, to: band[band.length - 1].radius, peak: Math.max(...band.map((e) => e.blueDelta)) } : null,
      profileSample: profile.filter((_, index) => index % 10 === 0),
    },
    null,
    2,
  ),
);
