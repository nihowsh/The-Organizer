// bracketDrawer.js
const { createCanvas } = require('canvas');

function drawText(ctx, text, x, y) {
  ctx.fillText(text, x, y);
}

function drawMatchBox(ctx, x, y, width, height, color, textColor, p1, p2, id) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, width, height);

  ctx.fillStyle = textColor;
  ctx.font = "24px Sans";

  const t1 = p1 ? p1.name : "TBD";
  const t2 = p2 ? p2.name : "TBD";

  ctx.fillText(id, x + 10, y + 25);
  ctx.fillText(t1, x + 10, y + 55);
  ctx.fillText(t2, x + 10, y + 85);
}

function drawBracketImage(tournament, cfg = {}) {
  const width = cfg.width || 1600;
  const height = cfg.height || 1000;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = cfg.bgColor || "#111";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = cfg.textColor || "white";
  ctx.font = cfg.font || "32px Sans";

  const rounds = tournament.rounds || [];
  const margin = cfg.margin || 40;
  const roundGap = cfg.roundGap || 210;
  const matchGap = cfg.matchGap || 90;
  const matchWidth = 180;
  const matchHeight = 110;

  let x = margin;

  // draw each round
  rounds.forEach((round, roundIndex) => {
    const isPrelim = !!round.isPrelim;

    const matches = round.matches;
    const totalHeight = matches.length * (matchHeight + matchGap) - matchGap;
    let y = (height - totalHeight) / 2;

    ctx.fillStyle = isPrelim ? (cfg.prelimColor || "#bb55ff") : (cfg.textColor || "white");
    ctx.font = "36px Sans";

    ctx.fillText(isPrelim ? "PRELIMS" : `ROUND ${roundIndex}`, x, margin);

    matches.forEach((m) => {
      const boxColor = isPrelim ? (cfg.prelimColor || "#bb55ff") : (cfg.lineColor || "white");

      drawMatchBox(
        ctx,
        x,
        y,
        matchWidth,
        matchHeight,
        boxColor,
        cfg.textColor || "white",
        m.p1,
        m.p2,
        m.id
      );

      y += matchHeight + matchGap;
    });

    x += matchWidth + roundGap;
  });

  return canvas.toBuffer();
}

module.exports = { drawBracketImage };

