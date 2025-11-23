// bracketDrawer.js
const fs = require('fs');
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');

// Optional: register a font file in assets/ for better looks
// try { registerFont(path.join(__dirname, 'assets', 'OpenSans-Bold.ttf'), { family: 'OpenSans' }); } catch(e){}

function trimName(name, maxLen = 24) {
  if (!name) return '—';
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 1) + '…';
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

// curved connector (bezier) between two points
function drawConnector(ctx, x1, y1, x2, y2, theme) {
  const midX = (x1 + x2) / 2;
  const cp1x = midX;
  const cp1y = y1;
  const cp2x = midX;
  const cp2y = y2;

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);

  // glow and stroke by theme
  ctx.lineWidth = 3;
  if (theme === 'A') {
    ctx.shadowColor = 'rgba(255,180,90,0.45)';
    ctx.strokeStyle = 'rgba(255,154,100,0.95)';
  } else if (theme === 'B') {
    ctx.shadowColor = 'rgba(80,220,255,0.45)';
    ctx.strokeStyle = 'rgba(120,220,255,0.95)';
  } else if (theme === 'C') {
    ctx.shadowColor = 'rgba(200,150,255,0.45)';
    ctx.strokeStyle = 'rgba(220,180,255,0.95)';
  } else { // D
    ctx.shadowColor = 'rgba(255,120,120,0.45)';
    ctx.strokeStyle = 'rgba(255,150,150,0.95)';
  }
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
}

// get theme palette
function paletteForTheme(theme) {
  switch ((theme || 'A').toUpperCase()) {
    case 'A': return { bg1: '#4b0212', bg2: '#7b0220', accent:'#ffd36a', panel:'#5f0518', text:'#ffffff', trophy:'#ffd36a' };
    case 'B': return { bg1: '#020617', bg2: '#001526', accent:'#6fe6ff', panel:'#081827', text:'#e8fbff', trophy:'#6fe6ff' };
    case 'C': return { bg1: '#14021f', bg2: '#2b0038', accent:'#c6a6ff', panel:'#2f1636', text:'#f7f1ff', trophy:'#c6a6ff' };
    case 'D': return { bg1: '#0b0b0b', bg2: '#1b0b0b', accent:'#ff6b6b', panel:'#2b0b0b', text:'#fff0f0', trophy:'#ffb36b' };
    default: return { bg1: '#4b0212', bg2: '#7b0220', accent:'#ffd36a', panel:'#5f0518', text:'#fff', trophy:'#ffd36a' };
  }
}

/**
 * tournament: { name, rounds: [ { isPrelim?, matches: [ {id,p1,p2,winner,status,channelId,...} ] } ], size }
 * configImage: { width, height, backgroundImagePath, theme }
 */
async function drawBracketImage(tournament = {}, configImage = {}) {
  const width = configImage.width || 1400;
  const height = configImage.height || 900;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const theme = (configImage.theme || 'A').toUpperCase();
  const pal = paletteForTheme(theme);

  // Background: image if provided else gradient
  if (configImage.backgroundImagePath && fs.existsSync(configImage.backgroundImagePath)) {
    try {
      const img = await loadImage(configImage.backgroundImagePath);
      ctx.drawImage(img, 0, 0, width, height);
    } catch (e) {
      // fallback
      const g = ctx.createLinearGradient(0, 0, 0, height);
      g.addColorStop(0, pal.bg1);
      g.addColorStop(1, pal.bg2);
      ctx.fillStyle = g;
      ctx.fillRect(0,0,width,height);
    }
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, pal.bg1);
    g.addColorStop(1, pal.bg2);
    ctx.fillStyle = g;
    ctx.fillRect(0,0,width,height);
  }

  // stylish header
  ctx.textAlign = 'center';
  ctx.fillStyle = pal.text;
  ctx.font = 'bold 40px Sans-serif';
  const title = tournament.name || 'TOURNAMENT';
  ctx.fillText(title, width/2, 56);
  ctx.font = '16px Sans-serif';
  ctx.fillText('LIVE BRACKET', width/2, 86);

  // decorative trophy circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(width/2, 110, 26, 0, Math.PI*2);
  ctx.fillStyle = pal.trophy;
  ctx.shadowColor = pal.trophy;
  ctx.shadowBlur = 18;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();

  // draw trophy glyph (simple cup) inside circle
  ctx.save();
  ctx.fillStyle = '#2a0b00';
  ctx.translate(width/2, 110);
  ctx.beginPath();
  ctx.moveTo(-10,-4);
  ctx.bezierCurveTo(-14,-4,-14,6,-6,10);
  ctx.lineTo(6,10);
  ctx.bezierCurveTo(14,6,14,-4,10,-4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // rounds layout
  const rounds = tournament.rounds || [];
  const roundCount = Math.max(1, rounds.length);
  const leftMargin = 120;
  const rightMargin = 120;
  const usableWidth = width - leftMargin - rightMargin;
  const colWidth = usableWidth / (roundCount);

  // For each round draw its matches vertically spaced
  for (let rIdx = 0; rIdx < rounds.length; rIdx++) {
    const round = rounds[rIdx];
    const matches = round.matches || [];
    const x = leftMargin + colWidth * rIdx + colWidth/2;

    // label for round (Final/Quarter etc or "Prelims" if isPrelim true)
    ctx.textAlign = 'left';
    ctx.font = 'bold 18px Sans-serif';
    ctx.fillStyle = round.isPrelim ? pal.accent : '#ffd7e0';
    const label = round.isPrelim ? 'Prelims' : `Round ${rIdx+1}`;
    ctx.fillText(label, x - 120, 140);

    // vertical spacing
    const top = 160;
    const bottom = height - 60;
    const matchArea = bottom - top;
    const matchHeight = matches.length > 0 ? (matchArea / matches.length) : 80;

    for (let mIdx = 0; mIdx < matches.length; mIdx++) {
      const match = matches[mIdx];
      const centerY = top + mIdx * matchHeight + matchHeight/2;
      const boxW = Math.min(300, colWidth * 0.9);
      const boxH = 44;
      const boxX = x - boxW/2;
      const boxY = centerY - boxH;

      // panel background
      ctx.save();
      ctx.globalAlpha = 0.95;
      roundRect(ctx, boxX, boxY, boxW, boxH*2 + 6, 10);
      ctx.fillStyle = pal.panel;
      ctx.fill();
      ctx.restore();

      // soft border
      ctx.strokeStyle = '#b36b6f';
      ctx.lineWidth = 1;
      roundRect(ctx, boxX, boxY, boxW, boxH*2 + 6, 10);
      ctx.stroke();

      // names
      ctx.fillStyle = pal.text;
      ctx.font = '16px Sans-serif';
      ctx.textAlign = 'left';
      const name1 = trimName(match.p1 && match.p1.name ? match.p1.name : '—', 22);
      const name2 = trimName(match.p2 && match.p2.name ? match.p2.name : '—', 22);
      ctx.fillText(name1, boxX + 12, boxY + 22);
      ctx.fillText(name2, boxX + 12, boxY + boxH + 22);

      // winner highlight
      if (match.winner) {
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 3;
        const winY = match.winner === 'p1' ? boxY + 14 : boxY + boxH + 14;
        ctx.beginPath();
        ctx.moveTo(boxX + 8, winY);
        ctx.lineTo(boxX + boxW - 8, winY);
        ctx.stroke();
      }

      // if prelim, add small badge
      if (round.isPrelim) {
        ctx.fillStyle = pal.accent;
        ctx.font = '12px Sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('PRELIM', boxX + boxW - 12, boxY + 20);
      }

      // connector to next round (if exists)
      if (rIdx < rounds.length - 1) {
        const nextX = leftMargin + colWidth * (rIdx + 1) + colWidth/2 - boxW/2;
        const fromX = boxX + boxW;
        const fromY = centerY - boxH/2;
        const toX = nextX;
        const toY = computeConnectorY(matches, mIdx, top, matchHeight, rounds.length, rIdx);
        drawConnector(ctx, fromX, fromY, toX, toY, theme);
      }
    }
  }

  // small footer note
  ctx.textAlign = 'center';
  ctx.font = '12px Sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('Auto-generated live bracket', width/2, height - 20);

  return canvas.toBuffer('image/png');
}

// compute target connector Y (maps two matches -> next match)
function computeConnectorY(roundMatches, mIdx, top, matchHeight, roundCount, rIdx) {
  const groupIndex = Math.floor(mIdx / 2);
  const nextCenter = top + groupIndex * (matchHeight * 2) + matchHeight;
  return nextCenter;
}

module.exports = {
  drawBracketImage
};
