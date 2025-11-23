// bracketDrawer.js
const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage } = require("canvas");

/* ------------ TEXT SHORTENER ------------ */
function shortName(str, max = 18) {
    if (!str) return "—";
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/* ------------ ROUND NAMES ------------ */
function getRoundName(totalRounds, roundIndex, isPrelim = false) {
    if (isPrelim) return "Preliminary Round";

    const roundNumber = totalRounds - roundIndex;

    const map = {
        1: "Final",
        2: "Semifinals",
        3: "Quarterfinals",
        4: "Round of 16",
        5: "Round of 32",
        6: "Round of 64",
        7: "Round of 128",
        8: "Round of 256"
    };

    return map[roundNumber] || `Round ${roundIndex + 1}`;
}

/* ------------ MAIN BRACKET DRAW FUNCTION ------------ */
async function drawBracketImage(tournament, cfg = {}) {
    const width = cfg.width || 1600;
    const height = cfg.height || 900;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    /* ------------ BACKGROUND ------------ */
    if (cfg.backgroundImagePath && fs.existsSync(cfg.backgroundImagePath)) {
        const img = await loadImage(cfg.backgroundImagePath);
        ctx.drawImage(img, 0, 0, width, height);
    } else {
        const grad = ctx.createLinearGradient(0, 0, width, height);
        grad.addColorStop(0, "#3a0012");
        grad.addColorStop(1, "#120008");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
    }

    /* ------------ TITLE ------------ */
    ctx.fillStyle = cfg.textColor || "#ffffff";
    ctx.font = "bold 44px Sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(tournament.name || "TOURNAMENT", width / 2, 60);

    ctx.font = "20px Sans-serif";
    ctx.fillText("Live Bracket", width / 2, 95);

    const rounds = tournament.rounds;
    const totalRounds = rounds.length;

    const colWidth = width / (totalRounds + 1);

    /* ------------ DRAW ROUNDS ------------ */
    for (let r = 0; r < totalRounds; r++) {
        const round = rounds[r];
        const xCenter = (r + 1) * colWidth;

        const isPrelim = r === 0 && tournament.prelimRound === true;

        // Round title
        ctx.font = "18px Sans-serif";
        ctx.fillStyle = cfg.textColor || "#fff";
        ctx.textAlign = "center";
        ctx.fillText(getRoundName(totalRounds, r, isPrelim), xCenter, 140);

        const topMargin = 160;
        const bottomMargin = 60;
        const availableHeight = height - topMargin - bottomMargin;
        const slotHeight = availableHeight / round.length;

        for (let i = 0; i < round.length; i++) {
            const match = round[i];

            const boxWidth = 260;
            const boxHeight = 48;

            const yMid = topMargin + i * slotHeight + slotHeight / 2;

            const boxX = xCenter - boxWidth / 2;
            const boxY = yMid - boxHeight;

            // Box background
            ctx.fillStyle = isPrelim ? (cfg.prelimColor || "#7744cc") : "rgba(90,0,20,0.85)";
            roundRect(ctx, boxX, boxY, boxWidth, boxHeight * 2 + 6, 10);
            ctx.fill();

            // Border
            ctx.strokeStyle = "#ffadc2";
            ctx.lineWidth = 2;
            roundRect(ctx, boxX, boxY, boxWidth, boxHeight * 2 + 6, 10);
            ctx.stroke();

            // Player names
            ctx.fillStyle = "#fff";
            ctx.font = "15px Sans-serif";
            ctx.textAlign = "left";

            const p1name = match.p1 ? shortName(match.p1.name) : "—";
            const p2name = match.p2 ? shortName(match.p2.name) : "—";

            ctx.fillText(p1name, boxX + 12, boxY + 20);
            ctx.fillText(p2name, boxX + 12, boxY + boxHeight + 20);

            // Winner highlight
            if (match.winner) {
                ctx.strokeStyle = "#ffdd5e";
                ctx.lineWidth = 3;

                const winY = match.winner === "p1" ? boxY + 14 : boxY + boxHeight + 14;

                ctx.beginPath();
                ctx.moveTo(boxX + 8, winY);
                ctx.lineTo(boxX + boxWidth - 8, winY);
                ctx.stroke();
            }

            // Connector to next round
            if (r < totalRounds - 1) {
                const nextX = (r + 2) * colWidth;

                const group = Math.floor(i / 2);
                const nextY =
                    topMargin + group * (slotHeight * 2) + slotHeight;

                ctx.strokeStyle = "rgba(255,180,180,0.8)";
                ctx.lineWidth = 2;

                ctx.beginPath();
                ctx.moveTo(boxX + boxWidth, yMid);
                ctx.lineTo(nextX - 130, nextY);
                ctx.stroke();
            }
        }
    }

    return canvas.toBuffer("image/png");
}

/* ------------ ROUNDED BOX ------------ */
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


