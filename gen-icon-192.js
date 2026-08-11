// gen-icon-192.js — 生成 icon-192.png (茄子管家 192x192 PNG)
// 用法: node gen-icon-192.js （输出 icon-192.png）
const fs = require('fs');
const zlib = require('zlib');

const W = 192, H = 192;
function rgb(r,g,b){ return [r,g,b]; }
const BG_TOP    = rgb(0x7B,0x8C,0xFF);
const BG_BOT    = rgb(0xA8,0x55,0xF7);
const BODY_LIGHT = rgb(0xA8,0xE6,0xA1);
const BODY_MID   = rgb(0x7B,0xC4,0x7F);
const BODY_DARK  = rgb(0x5B,0xA8,0x5F);
const OUTLINE    = rgb(0x3D,0x8B,0x40);
const SEED       = rgb(0x2D,0x5A,0x2D);
const HILITE     = rgb(0x9B,0xD9,0x8F);

// Linear gradient background (diagonal-like, use y-based for simplicity with x tint)
function bgColor(x,y){
  const ty = y/H;
  const tx = x/W;
  const t = (ty*0.7 + tx*0.3); // diagonal-ish
  return [
    Math.round(BG_TOP[0]*(1-t) + BG_BOT[0]*t),
    Math.round(BG_TOP[1]*(1-t) + BG_BOT[1]*t),
    Math.round(BG_TOP[2]*(1-t) + BG_BOT[2]*t),
  ];
}

// Signed distance to ellipse (cx, cy, rx, ry) centered
function ellipse(x,y,cx,cy,rx,ry){
  return ((x-cx)/rx)**2 + ((y-cy)/ry)**2 - 1;
}

// Draw pixels
const data = [];
for (let y=0; y<H; y++){
  data.push(0); // filter byte per row
  for (let x=0; x<W; x++){
    let col = bgColor(x,y);

    // Body ellipse (main eggplant)
    const bx = 96, by = 108;
    const dBody = ellipse(x,y,bx,by, 58,68);
    // Body gradient
    const tBody = Math.max(0, Math.min(1, (y-(by-68))/136));
    const bodyCol = [
      Math.round(BODY_LIGHT[0]*(1-tBody) + BODY_DARK[0]*tBody),
      Math.round(BODY_LIGHT[1]*(1-tBody) + BODY_DARK[1]*tBody),
      Math.round(BODY_LIGHT[2]*(1-tBody) + BODY_DARK[2]*tBody),
    ];

    // Layers using two ellipses (outline + inner fill)
    const outerBody = ellipse(x,y,bx,by, 59,69);
    const innerBody = ellipse(x,y,bx,by, 56,66);
    if (outerBody < 0 && innerBody >= 0){
      col = OUTLINE; // outline ring
    } else if (innerBody < 0){
      col = bodyCol.slice();
      // Highlight spot (upper-left shine)
      if (ellipse(x,y, bx-18, by-10, 22,30) < 0){
        // mix with HILITE
        const h = Math.max(0, 1 + ellipse(x,y, bx-18, by-10, 22,30));
        col[0] = Math.round(col[0]*(1-h*0.55) + HILITE[0]*h*0.55);
        col[1] = Math.round(col[1]*(1-h*0.55) + HILITE[1]*h*0.55);
        col[2] = Math.round(col[2]*(1-h*0.55) + HILITE[2]*h*0.55);
      }
    }

    // Leaf on top (stem): small shape, triangle-ish filled
    const sx = 96, sy = 40;
    // leaf as a rotated ellipse - approximate with two slanted ellipses and a center
    // Left leaf half: ellipse rotated -25°, approximation with offset ellipse
    const lx = 83, ly = 38;
    if (ellipse(x,y, lx,ly, 14,8) < 0) {
      // rotate approximation: check against a diagonal axis
      const dx = x-lx, dy = y-ly;
      const rx_ = dx*0.9 + dy*0.4;
      const ry_ = -dx*0.4 + dy*0.9;
      if ((rx_/14)**2 + (ry_/8)**2 < 1) col = BODY_DARK;
    }
    // Right leaf half
    const rx = 109, ry = 38;
    if (ellipse(x,y, rx,ry, 14,8) < 0) {
      const dx = x-rx, dy = y-ry;
      const rx_ = dx*0.9 - dy*0.4;
      const ry_ = dx*0.4 + dy*0.9;
      if ((rx_/14)**2 + (ry_/8)**2 < 1) col = BODY_DARK;
    }
    // Stem center
    if (ellipse(x,y, sx,sy, 6,5) < 0) col = BODY_DARK;
    // Leaf outline
    if (ellipse(x,y, lx,ly, 15,9) < 0 && ellipse(x,y, lx,ly, 13,7) >= 0) {
      const dx = x-lx, dy = y-ly;
      const rx_ = dx*0.9 + dy*0.4, ry_ = -dx*0.4 + dy*0.9;
      if ((rx_/15)**2 + (ry_/9)**2 < 1 && (rx_/13)**2 + (ry_/7)**2 >= 1) col = OUTLINE;
    }
    if (ellipse(x,y, rx,ry, 15,9) < 0 && ellipse(x,y, rx,ry, 13,7) >= 0) {
      const dx = x-rx, dy = y-ry;
      const rx_ = dx*0.9 - dy*0.4, ry_ = dx*0.4 + dy*0.9;
      if ((rx_/15)**2 + (ry_/9)**2 < 1 && (rx_/13)**2 + (ry_/7)**2 >= 1) col = OUTLINE;
    }

    // Seed dots (small circles on body)
    const seeds = [[74,96],[118,108],[82,126],[110,132],[100,122],[68,116],[126,124],[92,144],[112,150],[80,148],[104,112]];
    for (const [sx,sy] of seeds){
      if ((x-sx)**2 + (y-sy)**2 <= 9) col = SEED; // r=3
    }

    // Smile: a small quadratic curve arc — draw as a thin horizontal arc shape
    const smileCx = 96, smileCy = 120;
    const sdx = x-smileCx, sdy = y-smileCy;
    // arc: x^2/16^2 + (y+4)^2/4^2 = 1 (lower half ellipse) with thickness
    const smileOuter = (sdx/18)**2 + ((sdy+2)/5)**2;
    const smileInner = (sdx/16)**2 + ((sdy+2)/3)**2;
    if (smileOuter < 1 && smileInner > 1 && sdy > -2) col = SEED;

    data.push(col[0], col[1], col[2]);
  }
}

// PNG encode
function crc32(buf){
  let c, table = [];
  for (let n=0; n<256; n++){
    c = n;
    for (let k=0; k<8; k++) c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i=0; i<buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const sig = Buffer.from([137,80,78,71,13,10,26,10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
const raw = Buffer.from(data);
const idat = zlib.deflateSync(raw);
const png = Buffer.concat([sig, chunk('IHDR',ihdr), chunk('IDAT',idat), chunk('IEND',Buffer.alloc(0))]);
fs.writeFileSync('icon-192.png', png);
console.log('OK: wrote icon-192.png', png.length, 'bytes');
