const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage } = require("canvas");

// Trim long names
function trimName(name, max = 20) {
  if (!name) return "—";
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

// Compute label names per round index
function roundLabel(roundIndex, totalRounds, hasPrelims) {
  if (hasPrelims) {
    if (roundIndex === 0) return "PRELIMS";
    roundIndex -= 1;
  }

  const remaining = totalRounds - (roundIndex + 1);
  const sizes = ["Final", "Semifinal", "Quarterfinal", "Round of 16", "Round of 32", "Round of 64", "Round of 128"];
  return sizes[remaining] || `Round ${roundIndex + 1}`;
}

async function drawBracketImage(tournament, cfg = {}) {
  const rounds = tournament.rounds || [];
  const hasPrelims = rounds.length > 0 && rounds[0].isPrelim === true;

  const canvasWidth = cfg.width || 1600;
  const canvasHeight = cfg.height || 900;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  // Background
  if (cfg.backgroundImagePath && fs.existsSync(cfg.backgroundImagePath)) {
    const img = await loadImage(cfg.backgroundImagePath);
    ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, canvasHeight);
    grad.addColorStop(0, "#4b0212");
    grad.addColorStop(0.5, "#7b0220");
    grad.addColorStop(1, "#250008");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  }

  // Header
  ctx.fillStyle = "#fff";
  ctx.font = "bold 42px Sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(tournament.name || "TOURNAMENT", canvasWidth / 2, 60);
  ctx.font = "20px Sans-serif";
  ctx.fillText("LIVE BRACKET", canvasWidth / 2, 95);

  // Layout
  const totalRounds = rounds.length;
  const columnWidth = canvasWidth / (totalRounds + 1);

  for (let r = 0; r < totalRounds; r++) {
    const round = rounds[r];
    const xCenter = columnWidth * (r + 0.8);

    // Round title
    ctx.fillStyle = "#ffd7e0";
    ctx.font = "18px Sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(roundLabel(r, totalRounds, hasPrelims), xCenter - 20, 140);

    const topOffset = 160;
    const usableHeight = canvasHeight - topOffset - 60;
    const spacing = usableHeight / round.matches.length;

    for (let m = 0; m < round.matches.length; m++) {
      const match = round.matches[m];
      const centerY = topOffset + m * spacing + spacing / 2;

      const boxW = 260;
      const boxH = 46;

      const x = xCenter - boxW / 2;
      const y = centerY - boxH;

      // Panel
      ctx.fillStyle = "rgba(95,5,24,0.85)";
      roundRect(ctx, x, y, boxW, boxH * 2 + 8, 10);
      ctx.fill();

      // Border
      ctx.strokeStyle = "#b36b6f";
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, boxW, boxH * 2 + 8, 10);
      ctx.stroke();

      // Players
      ctx.fillStyle = "#fff";
      ctx.font = "16px Sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(trimName(match.p1?.name || "—"), x + 12, y + 22);
      ctx.fillText(trimName(match.p2?.name || "—"), x + 12, y + boxH + 22);

      // Winner highlight
      if (match.winner) {
        ctx.strokeStyle = "#ffd36a";
        ctx.lineWidth = 3;
        const winLineY = match.winner === "p1" ? y + 14 : y + boxH + 14;
        ctx.beginPath();
        ctx.moveTo(x + 8, winLineY);
        ctx.lineTo(x + boxW - 8, winLineY);
        ctx.stroke();
      }

      // Connector to next round
      if (r < totalRounds - 1) {
        const nextXCenter = columnWidth * (r + 1.5);
        const nextY = topOffset + Math.floor(m / 2) * (spacing * 2) + spacing;
        ctx.strokeStyle = "rgba(255,154,179,0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + boxW, y + boxH);
        ctx.lineTo(nextXCenter - boxW / 2, nextY);
        ctx.stroke();
      }
    }
  }

  return canvas.toBuffer("image/png");
}

// Rounded rectangle helper
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

module.exports = { drawBracketImage };

};
