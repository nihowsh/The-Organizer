// bracketDrawer.js - simple bracket PNG generator with dark-red theme and gold trophy.
// Paste into same folder as index.js
const { createCanvas, registerFont } = require('canvas');

// Optional: register a font if you have one. Otherwise system sans used.
// registerFont('./assets/OpenSans-Bold.ttf', { family: 'OpenSans' });

function trimName(name, maxLen = 22){
  if (!name) return '—';
  return name.length > maxLen ? name.slice(0, maxLen-1) + '…' : name;
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

function getRoundLabel(rounds, idx){
  // map last rounds if possible
  const total = rounds.length;
  // if first is Prelims, treat specially
  if (rounds[idx].isPrelim) return 'Prelims';
  // last round -> Final
  if (idx === total - 1) return 'Final';
  // second last -> Semifinal if small
  const rem = Math.pow(2, total - idx);
  if (rem >= 128) return `Round of ${rem}`;
  if (rem >= 2) return `Round of ${rem}`;
  return `Round ${idx+1}`;
}

async function drawBracketImage(tour, cfg){
  const width = (cfg && cfg.width) || 1400;
  const height = (cfg && cfg.height) || 900;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // background gradient
  const grad = ctx.createLinearGradient(0,0,0,height);
  grad.addColorStop(0, '#3a0710');
  grad.addColorStop(0.5, '#6b0f16');
  grad.addColorStop(1, '#210306');
  ctx.fillStyle = grad;
  ctx.fillRect(0,0,width,height);

  // header
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 34px Sans';
  const title = tour.name || 'TOURNAMENT';
  ctx.fillText(title, width/2, 56);
  ctx.font = '16px Sans';
  ctx.fillText('LIVE BRACKET', width/2, 84);

  // draw trophy circle
  ctx.fillStyle = '#ffd36a';
  ctx.beginPath();
  ctx.arc(width/2, 110, 28, 0, Math.PI*2);
  ctx.fill();
  // small trophy shape (simple)
  ctx.fillStyle = '#7a4b00';
  ctx.fillRect(width/2 - 6, 98, 12, 8);

  const rounds = tour.rounds || [];
  const roundCount = rounds.length || 1;
  const colWidth = width / Math.max(4, roundCount + 1);

  // render rounds
  rounds.forEach((rnd, rIdx) => {
    const x = colWidth * (rIdx + 0.6);
    // label
    ctx.fillStyle = '#ffd7e0';
    ctx.font = '18px Sans';
    ctx.textAlign = 'left';
    ctx.fillText(getRoundLabel(rounds, rIdx), x - 18, 140);

    const matchAreaTop = 160;
    const matchAreaHeight = height - matchAreaTop - 60;
    const matches = rnd.matches || [];
    const matchHeight = Math.max(80, matchAreaHeight / matches.length);

    matches.forEach((match, mIdx) => {
      const centerY = matchAreaTop + mIdx * matchHeight + matchHeight / 2;
      const boxW = 280;
      const boxH = 44;
      const bx = x - boxW/2;
      const by = centerY - boxH;

      // panel
      ctx.save();
      roundRect(ctx, bx, by, boxW, boxH*2 + 8, 10);
      ctx.fillStyle = 'rgba(60,10,12,0.86)';
      ctx.fill();
      ctx.strokeStyle = '#661017';
      ctx.lineWidth = 2;
      roundRect(ctx, bx, by, boxW, boxH*2 + 8, 10);
      ctx.stroke();

      // names
      ctx.fillStyle = '#fff';
      ctx.font = '16px Sans';
      ctx.textAlign = 'left';
      const n1 = match && match.p1 ? trimName(match.p1.name, 24) : '—';
      const n2 = match && match.p2 ? trimName(match.p2.name, 24) : '—';
      ctx.fillText(n1, bx + 12, by + 22);
      ctx.fillText(n2, bx + 12, by + boxH + 22);

      // winner highlight
      if (match && match.winner) {
        ctx.strokeStyle = '#ffd36a';
        ctx.lineWidth = 3;
        const winY = match.winner === 'p1' ? by + 14 : by + boxH + 14;
        ctx.beginPath();
        ctx.moveTo(bx + 8, winY);
        ctx.lineTo(bx + boxW - 8, winY);
        ctx.stroke();
      }

      // connector
      if (rIdx < rounds.length - 1) {
        const nextX = colWidth * (rIdx + 1.6);
        ctx.strokeStyle = 'rgba(255,154,179,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx + boxW, centerY - boxH/2);
        const midY = centerY;
        ctx.lineTo(nextX - boxW/2, midY);
        ctx.stroke();
      }
      ctx.restore();
    });
  });

  return canvas.toBuffer('image/png');
}

module.exports = { drawBracketImage };

