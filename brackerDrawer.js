// bracketDrawer.js
const fs = require('fs');
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');

// Optional: register a font file if you put one in assets/ (otherwise system fonts used)
// registerFont(path.join(__dirname, 'assets', 'OpenSans-Bold.ttf'), { family: 'OpenSans' });

function trimName(name, maxLen = 20) {
  if (!name) return '—';
  return name.length > maxLen ? name.slice(0, maxLen - 1) + '…' : name;
}

/**
 * tournament: {
 *   name: string,
 *   rounds: [ [ { id, p1, p2, winner } ] , ... ],
 *   size: number
 * }
 * configImage: { width, height, backgroundImagePath }
 */
async function drawBracketImage(tournament, configImage) {
  const width = configImage.width || 1600;
  const height = configImage.height || 900;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background: gradient or image if provided
  if (configImage.backgroundImagePath && fs.existsSync(configImage.backgroundImagePath)) {
    try {
      const img = await loadImage(configImage.backgroundImagePath);
      // fill with image scaled to cover
      ctx.drawImage(img, 0, 0, width, height);
    } catch (e) {
      // fallback gradient
      fillGradient();
    }
  } else {
    fillGradient();
  }

  function fillGradient() {
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#4b0212');   // dark wine
    grad.addColorStop(0.5, '#7b0220'); // royal red
    grad.addColorStop(1, '#250008');   // deep maroon
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }

  // Header
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 42px Sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(tournament.name || 'TOURNAMENT', width / 2, 60);
  ctx.font = '20px Sans-serif';
  ctx.fillText('LIVE BRACKET', width / 2, 92);

  const rounds = tournament.rounds || [];
  const roundCount = Math.max(1, rounds.length);
  const colWidth = width / (roundCount + 1);

  // draw rounds
  rounds.forEach((round, rIdx) => {
    const x = colWidth * (rIdx + 0.8);
    // Round label
    ctx.fillStyle = '#ffd7e0';
    ctx.font = '18px Sans-serif';
    const roundLabel = getRoundLabel(roundCount, rIdx);
    ctx.textAlign = 'left';
    ctx.fillText(roundLabel, x - 20, 140);

    const matchAreaTop = 160;
    const matchAreaHeight = height - matchAreaTop - 60;
    const matchHeight = matchAreaHeight / (round.length);
    round.forEach((match, mIdx) => {
      const centerY = matchAreaTop + mIdx * matchHeight + matchHeight / 2;

      const boxW = 260;
      const boxH = 46;
      const boxX = x - boxW / 2;
      const boxY = centerY - boxH;

      // panel
      roundRect(ctx, boxX, boxY, boxW, boxH * 2 + 6, 10);
      ctx.fillStyle = 'rgba(95,5,24,0.85)';
      ctx.fill();

      // border
      ctx.strokeStyle = '#b36b6f';
      ctx.lineWidth = 2;
      roundRect(ctx, boxX, boxY, boxW, boxH * 2 + 6, 10);
      ctx.stroke();

      // names
      ctx.fillStyle = '#fff';
      ctx.font = '16px Sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(trimName((match.p1 && match.p1.name) || match.p1 || '—', 24), boxX + 12, boxY + 22);
      ctx.fillText(trimName((match.p2 && match.p2.name) || match.p2 || '—', 24), boxX + 12, boxY + boxH + 22);

      // winner highlight
      if (match.winner) {
        ctx.strokeStyle = '#ffd36a';
        ctx.lineWidth = 3;
        const winY = match.winner === 'p1' ? boxY + 14 : boxY + boxH + 14;
        ctx.beginPath();
        ctx.moveTo(boxX + 8, winY);
        ctx.lineTo(boxX + boxW - 8, winY);
        ctx.stroke();
      }

      // connector to next round (approx)
      if (rIdx < roundCount - 1) {
        const nextX = colWidth * (rIdx + 1.5);
        ctx.strokeStyle = 'rgba(255,154,179,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(boxX + boxW, centerY - boxH / 2);
        const midY = computeConnectorY(round, mIdx, matchAreaTop, matchHeight, roundCount, rIdx);
        ctx.lineTo(nextX - boxW / 2, midY);
        ctx.stroke();
      }
    });
  });

  // trophy badge center if final
  if (roundCount >= 2) {
    ctx.fillStyle = '#ffd36a';
    ctx.beginPath();
    ctx.arc(width / 2 + 0, 70, 22, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas.toBuffer('image/png');
}

function getRoundLabel(roundCount, rIdx) {
  // Map last 4 rounds to named labels roughly
  const map = {
    1: ['Final'],
    2: ['Semifinal','Final'],
    3: ['Quarterfinal','Semifinal','Final'],
    4: ['Round of 16','Quarterfinal','Semifinal','Final']
  };
  const keys = Object.keys(map).map(k => parseInt(k)).sort((a,b)=>a-b);
  if (roundCount >= 4) {
    const labels = ['Round of ' + Math.pow(2, roundCount), 'Round of ' + Math.pow(2, roundCount-1), 'Quarterfinal', 'Semifinal', 'Final'];
    // fallback
    return `Round ${rIdx+1}`;
  }
  const labels = map[roundCount] || [];
  return labels[rIdx] || `Round ${rIdx+1}`;
}

function computeConnectorY(round, mIdx, top, matchHeight) {
  // connector target midpoint roughly to group two matches into one in next round
  const groupIndex = Math.floor(mIdx / 2);
  const nextCenter = top + groupIndex * (matchHeight * 2) + matchHeight;
  return nextCenter;
}

// small helper to draw rounded rectangle
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

module.exports = {
  drawBracketImage
};
