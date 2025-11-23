// bracketDrawer.js
// Requires: canvas, gifencoder, fs-extra
const { createCanvas, loadImage } = require('canvas');
const GIFEncoder = require('gifencoder');
const fs = require('fs-extra');
const path = require('path');

// Default background (the local file path you uploaded; system will convert to URL if needed)
const DEFAULT_BG_PATH = '/mnt/data/1b4523d7-fce7-48ce-b40f-6c8d8bab5439.png';

// Helpers
function shortName(name, max = 18) {
  if (!name) return "—";
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function getRoundLabel(total, idx, isPrelim) {
  if (isPrelim) return "Prelims";
  const names = {
    1: "Final", 2: "Semifinal", 3: "Quarterfinal",
    4: "Round of 16", 5: "Round of 32", 6: "Round of 64",
    7: "Round of 128", 8: "Round of 256"
  };
  const remaining = total - idx;
  return names[remaining] || `Round ${idx + 1}`;
}

// Draw small trophy icon (gold) — centered near top
function drawTrophy(ctx, cx, cy, scale = 1) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  // base cup
  ctx.fillStyle = '#ffd36a';
  ctx.beginPath();
  ctx.moveTo(-24, -4);
  ctx.quadraticCurveTo(0, -30, 24, -4);
  ctx.lineTo(24, 10);
  ctx.quadraticCurveTo(0, 18, -24, 10);
  ctx.closePath();
  ctx.fill();
  // stem
  ctx.beginPath();
  ctx.rect(-8, 10, 16, 10);
  ctx.fill();
  // pedestal
  ctx.fillStyle = '#b88a2f';
  ctx.fillRect(-20, 20, 40, 8);
  // handles
  ctx.strokeStyle = '#ffd36a';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-24, -4);
  ctx.quadraticCurveTo(-48, -12, -40, 12);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(24, -4);
  ctx.quadraticCurveTo(48, -12, 40, 12);
  ctx.stroke();
  ctx.restore();
}

// Main static renderer
async function drawBracketImage(tour, cfg = {}) {
  const settings = Object.assign({
    width: 1400, height: 900, bgColorTop: '#3a0012', bgColorBottom: '#120008',
    textColor: '#fff', prelimColor: '#7a2db3', panelBg: 'rgba(70,8,16,0.95)',
    connectorColor: 'rgba(255,154,179,0.95)', trophyY: 70, bgPath: DEFAULT_BG_PATH
  }, cfg || {});

  const width = settings.width, height = settings.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background: prefer provided image, otherwise gradient
  let bgDrawn = false;
  if (settings.bgPath && (await fs.pathExists(settings.bgPath)).catch(()=>false)) {
    try {
      const img = await loadImage(settings.bgPath);
      // cover mode
      const scale = Math.max(width / img.width, height / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
      bgDrawn = true;
    } catch (e) { bgDrawn = false; }
  }
  if (!bgDrawn) {
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, settings.bgColorTop);
    g.addColorStop(1, settings.bgColorBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  }

  // Header + trophy
  ctx.fillStyle = settings.textColor;
  ctx.font = 'bold 40px Sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(tour.name || 'TOURNAMENT', width / 2, 48);
  drawTrophy(ctx, width / 2, settings.trophyY, 1.0);

  const rounds = tour.rounds || [];
  if (!rounds.length) {
    ctx.font = '18px Sans-serif';
    ctx.fillText('No bracket yet', width / 2, height / 2);
    return canvas.toBuffer('image/png');
  }

  const cols = rounds.length;
  const colWidth = width / (cols + 1);
  for (let r = 0; r < cols; r++) {
    const round = rounds[r];
    const matches = round.matches;
    const x = (r + 1) * colWidth;
    ctx.fillStyle = settings.textColor;
    ctx.font = '18px Sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(getRoundLabel(cols, r, round.isPrelim), x, 120);

    const top = 150, bottom = 60;
    const avail = height - top - bottom;
    const slotH = avail / matches.length;

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      if (!m) continue;
      const midY = top + i * slotH + slotH / 2;
      const boxW = 260, boxH = 46;
      const bx = x - boxW / 2, by = midY - boxH;

      // panel
      ctx.fillStyle = round.isPrelim ? settings.prelimColor : settings.panelBg;
      roundRect(ctx, bx, by, boxW, boxH * 2 + 6, 10);
      ctx.fill();

      // border
      ctx.strokeStyle = '#b36b6f';
      ctx.lineWidth = 2;
      roundRect(ctx, bx, by, boxW, boxH * 2 + 6, 10);
      ctx.stroke();

      // names
      ctx.fillStyle = '#fff';
      ctx.font = '15px Sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(shortName(m.p1 && m.p1.name || '—', 24), bx + 12, by + 22);
      ctx.fillText(shortName(m.p2 && m.p2.name || '—', 24), bx + 12, by + boxH + 22);

      // winner highlight
      if (m.winner) {
        ctx.strokeStyle = '#ffd36a'; ctx.lineWidth = 3;
        const wy = m.winner === 'p1' ? by + 14 : by + boxH + 14;
        ctx.beginPath(); ctx.moveTo(bx + 8, wy); ctx.lineTo(bx + boxW - 8, wy); ctx.stroke();
      }

      // connectors
      if (r < cols - 1) {
        const nextX = (r + 2) * colWidth;
        ctx.strokeStyle = settings.connectorColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx + boxW, midY);
        ctx.lineTo(nextX - boxW / 2, midY);
        ctx.stroke();
      }
    }
  }

  // gold trophy badge at center bottom with glow
  ctx.save();
  const badgeX = width / 2, badgeY = 90;
  // glow
  for (let i = 10; i > 0; i--) {
    ctx.beginPath();
    ctx.fillStyle = `rgba(255,211,106,${0.03 * i})`;
    ctx.arc(badgeX, badgeY, 22 + i * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  drawTrophy(ctx, badgeX, badgeY, 1.2);
  ctx.restore();

  return canvas.toBuffer('image/png');
}

// Animated GIF generator
// frames: number of frames (default 24), fps: frames per second (default 12)
async function drawAnimatedBracketGIF(tour, cfg = {}, frames = 30, fps = 12) {
  const settings = Object.assign({ width: 1400, height: 900 }, cfg || {});
  const width = settings.width, height = settings.height;

  const encoder = new GIFEncoder(width, height);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(Math.round(1000 / fps));
  encoder.setQuality(10);

  // produce each frame by slightly varying glow/connector alpha or sliding highlight
  for (let f = 0; f < frames; f++) {
    const t = Math.sin((f / frames) * Math.PI * 2); // -1..1
    // tweak color intensity for animation
    const animCfg = Object.assign({}, cfg, {
      panelBg: `rgba(70,8,16,${0.9 + 0.05 * t})`,
      prelimColor: `rgba(122,45,179,${0.9 + 0.06 * t})`,
      connectorColor: `rgba(255,154,179,${0.7 + 0.2 * Math.abs(t)})`,
      textColor: '#fff',
      bgPath: settings.bgPath || DEFAULT_BG_PATH
    });
    const buf = await drawBracketImage(tour, animCfg);
    encoder.addFrame(buf);
  }

  encoder.finish();
  // GIF data buffer
  const out = encoder.out.getData();
  return Buffer.from(out);
}

module.exports = {
  drawBracketImage,
  drawAnimatedBracketGIF: drawAnimatedBracketGIF
};


module.exports = {
    drawBracketImage
};


