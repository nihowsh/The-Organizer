// index.js - The Organizer (single-file, copy-paste)
// Requirements: node >=18, dependencies: discord.js, canvas, express, fs-extra, dotenv
require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const { createCanvas, loadImage } = require('canvas');
const {
  REST, Routes,
  Client, GatewayIntentBits, Partials,
  AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionsBitField
} = require('discord.js');

// ---------- CONFIG / STORAGE ----------
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STORAGE_PATH = path.join(__dirname, 'storage.json');

const defaultConfig = {
  bracketChannel: "",
  registrationChannel: "",
  battleCategory: "",
  announcementChannel: "",
  voteChannel: "",
  battleChannels: [],
  organizerRoleIds: [],
  roundReplyTimeoutHours: 24,
  voteDurationMinutes: 24 * 60, // minutes default 24 hours
  image: { width: 1400, height: 900, bgColor: "#2a0710", textColor: "#fff", prelimColor: "#8844ff" }
};

let config = fs.existsSync(CONFIG_PATH) ? fs.readJsonSync(CONFIG_PATH) : defaultConfig;
config = Object.assign({}, defaultConfig, config);
let storage = fs.existsSync(STORAGE_PATH) ? fs.readJsonSync(STORAGE_PATH) : { tournaments: {}, meta: { currentTournament: null } };

function saveConfig() { fs.writeJsonSync(CONFIG_PATH, config, { spaces: 2 }); }
function saveStorage() { fs.writeJsonSync(STORAGE_PATH, storage, { spaces: 2 }); }

// ---------- UTILS ----------
function nextPowerOfTwoLE(n) { // largest power of two <= n
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}
function genTournamentId() { return `t_${Date.now().toString(36)}_${Math.floor(Math.random()*999)}`; }
function isOrganizerMember(member) {
  if (!member) return false;
  if (member.permissions && member.permissions.has && member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  const roles = config.organizerRoleIds || [];
  for (const r of roles) if (member.roles && member.roles.cache && member.roles.cache.has(r)) return true;
  return false;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function shortName(s, max=18){ if(!s) return '—'; return s.length>max? s.slice(0,max-1)+'…' : s; }
function sleep(ms){ return new Promise(res=>setTimeout(res,ms)); }

// ---------- BRACKET DRAWER (simple, inside file) ----------
async function drawBracketImage(tour, imgCfg) {
  const cfg = Object.assign({}, config.image, imgCfg || {});
  const width = cfg.width || 1400, height = cfg.height || 900;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // background gradient
  const g = ctx.createLinearGradient(0,0,0,height);
  g.addColorStop(0, '#3a0012'); g.addColorStop(1, '#120008');
  ctx.fillStyle = g; ctx.fillRect(0,0,width,height);

  // title
  ctx.fillStyle = cfg.textColor || '#fff';
  ctx.font = 'bold 36px Sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(tour.name || 'TOURNAMENT', width/2, 48);
  ctx.font = '16px Sans-serif';
  ctx.fillText('Live Bracket', width/2, 72);

  const rounds = tour.rounds || [];
  const totalRounds = rounds.length;
  if (totalRounds === 0) {
    ctx.font = '18px Sans-serif'; ctx.fillText('No bracket yet', width/2, height/2);
    return canvas.toBuffer('image/png');
  }
  const colW = width / (totalRounds + 1);

  for (let r = 0; r < totalRounds; r++) {
    const round = rounds[r];
    const x = (r + 1) * colW;
    // round label
    ctx.font = '18px Sans-serif'; ctx.fillStyle = '#ffd7e0'; ctx.textAlign = 'center';
    const label = round.isPrelim ? 'Preliminary' : getRoundLabel(totalRounds, r);
    ctx.fillText(label, x, 120);

    const top = 150, bottom = 60;
    const avail = height - top - bottom;
    const slotH = avail / round.matches.length;

    for (let i = 0; i < round.matches.length; i++) {
      const match = round.matches[i];
      const midY = top + i * slotH + slotH/2;
      const boxW = 260, boxH = 44;
      const bx = x - boxW/2, by = midY - boxH;
      // bg
      ctx.fillStyle = round.isPrelim ? (cfg.prelimColor || '#7744cc') : 'rgba(90,0,20,0.85)';
      roundRect(ctx, bx, by, boxW, boxH*2+6, 8); ctx.fill();
      // border
      ctx.strokeStyle = '#b36b6f'; ctx.lineWidth = 2; roundRect(ctx, bx, by, boxW, boxH*2+6, 8); ctx.stroke();
      // names
      ctx.fillStyle = '#fff'; ctx.font = '14px Sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(shortName(match.p1 && match.p1.name || '—', 22), bx+10, by+20);
      ctx.fillText(shortName(match.p2 && match.p2.name || '—', 22), bx+10, by+boxH+20);
      // winner highlight
      if (match.winner) {
        ctx.strokeStyle = '#ffd36a'; ctx.lineWidth = 3;
        const wy = match.winner === 'p1' ? by + 14 : by + boxH + 14;
        ctx.beginPath(); ctx.moveTo(bx+8, wy); ctx.lineTo(bx+boxW-8, wy); ctx.stroke();
      }
      // connector
      if (r < totalRounds - 1) {
        const nextX = (r+2) * colW;
        ctx.strokeStyle = 'rgba(255,154,179,0.9)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(bx + boxW, midY); ctx.lineTo(nextX - boxW/2, midY); ctx.stroke();
      }
    }
  }

  return canvas.toBuffer('image/png');
}
function roundRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath(); }
function getRoundLabel(totalRounds, rIdx){
  const n = totalRounds - rIdx;
  const map = {1:'Final',2:'Semifinal',3:'Quarterfinal',4:'Round of 16',5:'Round of 32',6:'Round of 64',7:'Round of 128'};
  return map[n] || `Round ${rIdx+1}`;
}

// ---------- BRACKET BUILDING with PRELIMS ----------
function buildInitialBracket(tour) {
  // participants: [{id,name,joinedAt},...], FCFS ordering preserved
  const parts = (tour.participants || []).slice();
  const N = parts.length;
  const T = nextPowerOfTwoLE(Math.max(2,N)); // target main bracket size (largest power of two <= N)
  // number of prelim players:
  const P = 2 * (N - T); // even, possibly 0
  const autoQualCount = N - P; // first-come-first-serve auto qualifiers
  // split
  const autoQuals = parts.slice(0, autoQualCount);
  const prelimPlayers = parts.slice(autoQualCount); // length = P

  // prelim round matches
  const rounds = [];
  if (P > 0) {
    const prelimMatches = [];
    for (let i = 0; i < P; i += 2) {
      const p1 = prelimPlayers[i] ? { id: prelimPlayers[i].id, name: prelimPlayers[i].name } : null;
      const p2 = prelimPlayers[i+1] ? { id: prelimPlayers[i+1].id, name: prelimPlayers[i+1].name } : null;
      const m = { id: `PRM${i/2+1}`, p1, p2, winner:null, status: (p1 && p2)?'pending':'finished', roundCount:0, lastPoster:null, votes:{} };
      if (p1 && !p2) { m.winner='p1'; m.status='finished'; }
      if (!p1 && p2) { m.winner='p2'; m.status='finished'; }
      prelimMatches.push(m);
    }
    rounds.push({ isPrelim: true, matches: prelimMatches });
  }

  // Now build main bracket of size T
  // slots: first autoQuals then placeholders for prelim winners
  const slots = [];
  // autoQuals fill earliest slots (first-come-first-serve)
  for (let i = 0; i < autoQualCount; i++) slots.push({ id: autoQuals[i].id, name: autoQuals[i].name });
  // placeholders for prelim winners: represent as nulls (they will be filled after prelims)
  const prelimWinnersCount = P/2;
  for (let i = 0; i < prelimWinnersCount; i++) slots.push(null);
  // if slots < T (should equal T), pad nulls
  while (slots.length < T) slots.push(null);

  // create first main round matches (R1)
  const firstRound = [];
  for (let i = 0; i < T; i += 2) {
    const a = slots[i] ? { id: slots[i].id, name: slots[i].name } : null;
    const b = slots[i+1] ? { id: slots[i+1].id, name: slots[i+1].name } : null;
    firstRound.push({ id: `R1M${i/2+1}`, p1: a, p2: b, winner: null, status: (a||b)?'pending':'locked', roundCount:0, lastPoster:null, votes:{} });
  }
  rounds.push({ isPrelim: false, matches: firstRound });

  // subsequent rounds
  let prevCount = firstRound.length;
  while (prevCount > 1) {
    const nextCount = Math.ceil(prevCount / 2);
    const arr = [];
    for (let i = 0; i < nextCount; i++) arr.push({ id: `R${rounds.length+1}M${i+1}`, p1:null, p2:null, winner:null, status:'locked', roundCount:0, lastPoster:null, votes:{} });
    rounds.push({ isPrelim: false, matches: arr });
    prevCount = nextCount;
  }

  // store tournament fields
  tour.rounds = rounds;
  tour.size = T;
  tour.prelimInfo = { P, autoQualCount, prelimPlayersCount: P, prelimMatches: P/2 };
  tour.status = 'running';
}

// regenerate next rounds after winners set (handles prelim -> main fill)
function regenerateNextRounds(tour) {
  if (!tour.rounds) return;
  // If prelims exist and finished, fill main round placeholders
  if (tour.rounds[0] && tour.rounds[0].isPrelim) {
    const prelim = tour.rounds[0].matches;
    // gather winners in order
    const winners = prelim.map(m => {
      if (!m) return null;
      if (m.winner) return (m.winner === 'p1' ? m.p1 : m.p2);
      return null;
    });
    // fill first main round's null slots left-to-right
    const main = tour.rounds[1].matches;
    let wi = 0;
    for (let i = 0; i < main.length; i++) {
      const m = main[i];
      if (!m) continue;
      if (!m.p1 && wi < winners.length) { m.p1 = winners[wi] || null; wi++; }
      if (!m.p2 && wi < winners.length) { m.p2 = winners[wi] || null; wi++; }
      m.status = (m.p1 || m.p2) ? 'pending' : 'locked';
    }
  }
  // general propagate winners upward
  for (let r = 0; r < tour.rounds.length - 1; r++) {
    const curr = tour.rounds[r].matches;
    const next = tour.rounds[r+1].matches;
    let idx = 0;
    for (let i = 0; i < curr.length; i += 2) {
      const m1 = curr[i], m2 = curr[i+1];
      const w1 = m1 && m1.winner ? (m1.winner === 'p1' ? m1.p1 : m1.p2) : null;
      const w2 = m2 && m2.winner ? (m2.winner === 'p1' ? m2.p1 : m2.p2) : null;
      if (next[idx]) {
        next[idx].p1 = w1;
        next[idx].p2 = w2;
        next[idx].status = (next[idx].p1 || next[idx].p2) ? 'pending' : 'locked';
      }
      idx++;
    }
  }
}

// ---------- ASSIGNING FIXTURES ----------
async function assignRoundToChannels(tour, roundIndex = 0, client) {
  const rnd = tour.rounds && tour.rounds[roundIndex] ? tour.rounds[roundIndex].matches : null;
  if (!rnd) throw new Error('Round not found');
  const explicit = config.battleChannels && config.battleChannels.length > 0 ? config.battleChannels : (tour.channels && tour.channels.battleChannels ? tour.channels.battleChannels : []);
  const categoryId = tour.channels && tour.channels.battleCategory ? tour.channels.battleCategory : config.battleCategory || null;
  let idx = 0;
  const announces = [];
  for (const m of rnd) {
    if (!m) continue;
    if (!m.p1 && !m.p2) { m.channelId = null; continue; }
    if (!m.channelId) {
      if (explicit && explicit.length > 0) {
        m.channelId = explicit[idx % explicit.length]; idx++;
      } else if (categoryId && client) {
        try {
          const guild = client.guilds.cache.first();
          if (guild) {
            const name = `battle-${m.id.toLowerCase()}`.replace(/[^a-z0-9-]/g, '-').slice(0,90);
            const created = await guild.channels.create({ name, type: 0, parent: categoryId || null });
            m.channelId = created.id;
          }
        } catch(e) { console.error('create channel',e); }
      } else {
        m.channelId = tour.channels && tour.channels.bracket ? tour.channels.bracket : config.bracketChannel || null;
      }
    }
    announces.push(m);
  }
  // post announces
  const aid = tour.channels && tour.channels.announce ? tour.channels.announce : config.announcementChannel || tour.channels.bracket || config.bracketChannel;
  if (aid && client) {
    try {
      const ch = await client.channels.fetch(aid);
      for (const m of announces) {
        const p1n = m.p1 ? m.p1.name : 'TBD';
        const p2n = m.p2 ? m.p2.name : 'TBD';
        await ch.send(`Match ${m.id}: **${p1n}** vs **${p2n}** — in <#${m.channelId}> ${m.p1?`<@${m.p1.id}>`:''} ${m.p2?`<@${m.p2.id}>`:''}`);
        await sleep(100); // small throttle
      }
    } catch(e){ console.error('announce fail', e); }
  }
  saveStorage();
}

// ---------- VOTING (button) ----------
async function postVoteForMatch(tour, match, client, durationMinutes) {
  const voteChanId = tour.channels && tour.channels.vote ? tour.channels.vote : config.voteChannel || match.channelId;
  if (!voteChanId) throw new Error('No vote channel');
  const ch = await client.channels.fetch(voteChanId);
  const p1label = match.p1 ? match.p1.name : 'Player 1';
  const p2label = match.p2 ? match.p2.name : 'Player 2';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote_${match.id}_p1`).setLabel(p1label).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vote_${match.id}_p2`).setLabel(p2label).setStyle(ButtonStyle.Danger)
  );
  const msg = await ch.send({ content: `Vote: ${match.id} — ${p1label} vs ${p2label}`, components: [row] });
  match.votingMessageId = msg.id; match.status = 'voting'; saveStorage();

  const durationMs = clamp((durationMinutes||tour.voteDurationMinutes||config.voteDurationMinutes), 10, 72*60) * 60 * 1000;
  const collector = msg.createMessageComponentCollector({ componentType: 2, time: durationMs });

  const votes = new Map();
  collector.on('collect', async i => {
    if (votes.has(i.user.id)) {
      await i.reply({ content:'You already voted', ephemeral:true }); return;
    }
    const [, , choice] = i.customId.split('_'); // vote_R1M1_p1
    votes.set(i.user.id, choice);
    await i.reply({ content:'Vote recorded', ephemeral:true });
  });

  collector.on('end', async () => {
    const tally = { p1:0, p2:0 };
    for (const choice of votes.values()) { if (choice==='p1') tally.p1++; if (choice==='p2') tally.p2++; }
    let winnerKey = null;
    if (tally.p1 > tally.p2) winnerKey = 'p1';
    else if (tally.p2 > tally.p1) winnerKey = 'p2';
    else {
      // tie -> random pick
      winnerKey = (Math.random() < 0.5) ? 'p1' : 'p2';
    }
    match.votes = Object.fromEntries(votes);
    match.winner = winnerKey;
    match.status = 'finished';
    saveStorage();
    regenerateNextRounds(tour);
    await updateBracketMessage(tour, client);
    // announce results
    try {
      const aid = tour.channels && tour.channels.announce ? tour.channels.announce : config.announcementChannel || tour.channels.bracket || config.bracketChannel;
      if (aid) {
        const ach = await client.channels.fetch(aid);
        await ach.send(`Voting ended for ${match.id}. Results: p1=${tally.p1}, p2=${tally.p2}. Winner: **${match[winnerKey] ? match[winnerKey].name : winnerKey}**`);
      }
    } catch(e){}
  });

  return msg;
}

// ---------- FIND MATCH ----------
function findMatchById(tour, matchId) {
  if (!tour || !tour.rounds) return null;
  for (let r=0;r<tour.rounds.length;r++){
    const rnd = tour.rounds[r].matches;
    for (const m of rnd) if (m && m.id === matchId) return { match:m, roundIndex:r };
  }
  return null;
}

// ---------- UPDATE BRACKET MESSAGE ----------
async function updateBracketMessage(tour, client) {
  try {
    const buf = await drawBracketImage(tour, config.image || {});
    const att = new AttachmentBuilder(buf, { name: 'bracket.png' });
    const chId = tour.channels && tour.channels.bracket ? tour.channels.bracket : config.bracketChannel || null;
    if (!chId) return;
    const ch = await client.channels.fetch(chId);
    if (!ch) return;
    if (tour.bracketMessageId) {
      try {
        const prev = await ch.messages.fetch(tour.bracketMessageId);
        await prev.edit({ files: [att] });
      } catch (e) {
        const sent = await ch.send({ files: [att] });
        tour.bracketMessageId = sent.id;
      }
    } else {
      const sent = await ch.send({ files: [att] });
      tour.bracketMessageId = sent.id;
    }
    saveStorage();
  } catch(e){ console.error('updateBracketMessage',e); }
}

// ---------- TIMERS ----------
const timers = new Map();
function scheduleMatchTimeout(tour, match, client, ms) {
  if (!match || !match.id) return;
  if (timers.has(match.id)) clearTimeout(timers.get(match.id));
  const to = setTimeout(async () => {
    timers.delete(match.id);
    if (!match.winner && match.status !== 'finished') {
      match.status = 'timed_out'; saveStorage();
      // open vote automatically
      try { await postVoteForMatch(tour, match, client); } catch(e){ console.error('postVote after timeout',e); }
    }
  }, ms);
  timers.set(match.id, to);
}
function restoreTimers(client) {
  for (const tid of Object.keys(storage.tournaments)) {
    const tour = storage.tournaments[tid];
    if (!tour || !tour.rounds) continue;
    for (const rnd of tour.rounds) {
      for (const m of rnd.matches) {
        if (m && m.deadlineTs && !m.winner && m.status !== 'finished' && m.deadlineTs > Date.now()) {
          scheduleMatchTimeout(tour, m, client, m.deadlineTs - Date.now());
        }
      }
    }
  }
}

// ---------- DISCORD SETUP & COMMANDS ----------
const commands = [
  { name:'create_tournament', description:'Create tournament', options:[
    {name:'name',type:3,required:true},
    {name:'bracket_channel',type:3,required:false},
    {name:'registration_channel',type:3,required:false},
    {name:'announce_channel',type:3,required:false},
    {name:'vote_channel',type:3,required:false},
    {name:'max_participants',type:4,required:false}
  ]},
  { name:'post_registration', description:'Post registration', options:[{name:'tournament',type:3,required:false}] },
  { name:'close_registration', description:'Close registration and build bracket', options:[{name:'tournament',type:3,required:false}] },
  { name:'assign_fixtures', description:'Assign fixtures', options:[{name:'tournament',type:3,required:false}] },
  { name:'open_vote', description:'Open vote', options:[{name:'tournament',type:3,required:false},{name:'match_id',type:3,required:true},{name:'duration_minutes',type:4,required:false}] },
  { name:'end_match', description:'End match (organizer)', options:[{name:'tournament',type:3,required:false},{name:'match_id',type:3,required:true},{name:'winner',type:3,required:true}] },
  { name:'end_tournament', description:'End tournament', options:[{name:'tournament',type:3,required:false}] },
  { name:'set_channels', description:'Set default channels', options:[
    {name:'bracket_channel',type:3},{name:'registration_channel',type:3},{name:'battle_category',type:3},{name:'announce_channel',type:3},{name:'vote_channel',type:3}
  ] },
  { name:'set_battle_channels', description:'Set battle channels (csv)', options:[{name:'channels',type:3,required:true}] },
  { name:'show_bracket', description:'Show bracket image', options:[{name:'tournament',type:3,required:false}] },
  { name:'register', description:'Register (legacy)', options:[{name:'tournament',type:3,required:false}] },
  { name:'unregister', description:'Unregister (legacy)', options:[{name:'tournament',type:3,required:false}] }
];

async function deployCommands(){
  if (!process.env.BOT_TOKEN || !process.env.CLIENT_ID) { console.warn('CLIENT_ID or BOT_TOKEN missing for automatic deploy'); return; }
  const rest = new REST({ version:'10' }).setToken(process.env.BOT_TOKEN);
  try {
    if (process.env.GUILD_ID) await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    else await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Commands deployed');
  } catch(e){ console.error('deployCommands',e); }
}
deployCommands();

const client = new Client({ intents:[GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions], partials:[Partials.Message,Partials.Channel,Partials.Reaction,Partials.User] });

client.once('ready', async () => {
  console.log('Logged in as', client.user.tag);
  if (!storage.meta) storage.meta = {};
  if (!storage.meta.currentTournament && Object.keys(storage.tournaments).length>0) storage.meta.currentTournament = Object.keys(storage.tournaments)[0];
  restoreTimers(client);
  // update brackets on boot
  for (const id of Object.keys(storage.tournaments)) {
    try { await updateBracketMessage(storage.tournaments[id], client); } catch(e){}
  }
});

// ---------- REACTION REGISTRATION ----------
async function postRegistrationEmbed(tour, client){
  const chanId = tour.channels && tour.channels.registration ? tour.channels.registration : config.registrationChannel || config.bracketChannel;
  if (!chanId) throw new Error('No registration channel');
  const ch = await client.channels.fetch(chanId);
  const names = tour.participants && tour.participants.length ? tour.participants.map((p,i)=>`${i+1}. ${p.name}`).join('\n') : 'No participants yet';
  const embed = { title: `${tour.name} — Registration`, description: `React ✅ to register.\nFirst-come-first-serve byes. Max: ${tour.maxParticipants||'Unlimited'}`, fields:[{name:`Participants (${tour.participants.length})`, value: names}], timestamp: new Date() };
  const msg = await ch.send({ embeds:[embed] });
  await msg.react('✅');
  tour.registrationMessageId = msg.id; saveStorage(); return msg;
}
async function updateRegistrationEmbed(tour, client){
  if (!tour.registrationMessageId) return;
  const chanId = tour.channels && tour.channels.registration ? tour.channels.registration : config.registrationChannel || config.bracketChannel;
  if (!chanId) return;
  try {
    const ch = await client.channels.fetch(chanId);
    const msg = await ch.messages.fetch(tour.registrationMessageId);
    const names = tour.participants && tour.participants.length ? tour.participants.map((p,i)=>`${i+1}. ${p.name}`).join('\n') : 'No participants yet';
    const embed = msg.embeds[0] ? msg.embeds[0].toJSON() : { title: `${tour.name} — Registration`, description:'React ✅ to register.' };
    embed.fields = [{ name:`Participants (${tour.participants.length})`, value: names }];
    await msg.edit({ embeds:[embed] });
  } catch(e){ console.error('updateRegistrationEmbed',e); }
}

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    const tour = Object.values(storage.tournaments).find(t=>t.registrationMessageId === msg.id);
    if (!tour) return;
    if (reaction.emoji.name !== '✅') return;
    if (tour.status !== 'registration') { try{ await user.send('Registration closed.'); }catch{}; return; }
    if (tour.maxParticipants && tour.participants.length >= tour.maxParticipants) { try{ await user.send('Tournament full'); }catch{}; return; }
    if (tour.participants.find(p=>p.id===user.id)) { try{ await user.send('Already registered'); }catch{}; return; }
    tour.participants.push({ id:user.id, name:user.username||user.tag, joinedAt:Date.now() }); saveStorage();
    await updateRegistrationEmbed(tour, client);
  } catch(e){ console.error('reactionAdd',e); }
});
client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    const tour = Object.values(storage.tournaments).find(t=>t.registrationMessageId === msg.id);
    if (!tour) return;
    if (reaction.emoji.name !== '✅') return;
    const idx = tour.participants.findIndex(p=>p.id===user.id);
    if (idx!==-1) { tour.participants.splice(idx,1); saveStorage(); await updateRegistrationEmbed(tour, client); }
  } catch(e){ console.error('reactionRemove',e); }
});

// ---------- MESSAGE CREATE (battle posts) ----------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  for (const tid of Object.keys(storage.tournaments)) {
    const tour = storage.tournaments[tid];
    if (!tour || tour.status!=='running' || !tour.rounds) continue;
    for (const rnd of tour.rounds) {
      for (const m of rnd.matches) {
        if (!m || !m.channelId) continue;
        if (m.channelId === message.channel.id) {
          const uid = message.author.id;
          if (!((m.p1 && m.p1.id===uid) || (m.p2 && m.p2.id===uid))) return;
          if (m.lastPoster && m.lastPoster === uid) { try{ await message.reply({ content:'Wait for opponent', ephemeral:true }); }catch{}; return; }
          m.lastPoster = uid; m.roundCount = (m.roundCount||0)+1;
          m.deadlineTs = Date.now() + (tour.roundReplyTimeoutHours || config.roundReplyTimeoutHours) * 60 * 60 * 1000;
          m.finished = false; saveStorage();
          scheduleMatchTimeout(tour, m, client, m.deadlineTs - Date.now());
          try {
            const opponentId = (m.p1 && m.p1.id===uid) ? (m.p2 && m.p2.id) : (m.p1 && m.p1.id);
            const note = await message.channel.send(`Post recorded. ${opponentId?`<@${opponentId}> `:''}You have ${tour.roundReplyTimeoutHours || config.roundReplyTimeoutHours} hours.`);
            setTimeout(()=>note.delete().catch(()=>{}), 12*1000);
          } catch(e){}
          return;
        }
      }
    }
  }
});

// ---------- INTERACTIONS (buttons + slash) ----------
client.on('interactionCreate', async interaction => {
  try {
    // BUTTONS: voting
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('vote_')) {
        const [, matchId, choice] = id.split('_');
        for (const tid of Object.keys(storage.tournaments)) {
          const tour = storage.tournaments[tid];
          const found = findMatchById(tour, matchId);
          if (!found) continue;
          const match = found.match;
          match.votes = match.votes || {};
          if (match.votes[interaction.user.id]) { await interaction.reply({ content:'You already voted', ephemeral:true }); return; }
          match.votes[interaction.user.id] = choice; saveStorage();
          await interaction.reply({ content:'Vote recorded', ephemeral:true });
          return;
        }
        await interaction.reply({ content:'Match not found', ephemeral:true }); return;
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;
    const argTournament = interaction.options.getString('tournament') || 'current';
    const tournamentId = (argTournament === 'current') ? (storage.meta && storage.meta.currentTournament) : (argTournament || null);
    const tournament = tournamentId ? storage.tournaments[tournamentId] : null;
    function getTargetTournamentOrReply(){
      if (argTournament === 'current') {
        const cur = storage.meta && storage.meta.currentTournament;
        if (!cur) { interaction.reply({ content:'No current tournament', ephemeral:true }); return null; }
        return storage.tournaments[cur];
      }
      const t = storage.tournaments[argTournament];
      if (!t) { interaction.reply({ content:`Tournament ${argTournament} not found`, ephemeral:true }); return null; }
      return t;
    }

    // REGISTER (legacy)
    if (cmd === 'register') {
      const tour = getTargetTournamentOrReply(); if (!tour) return;
      if (tour.status !== 'registration') return interaction.reply({ content:'Registration closed', ephemeral:true });
      if (tour.participants.find(p=>p.id===interaction.user.id)) return interaction.reply({ content:'Already registered', ephemeral:true });
      if (tour.maxParticipants && tour.participants.length >= tour.maxParticipants) return interaction.reply({ content:'Tournament full', ephemeral:true });
      tour.participants.push({ id: interaction.user.id, name: interaction.member.displayName || interaction.user.username, joinedAt: Date.now() });
      saveStorage(); await updateRegistrationEmbed(tour, client); return interaction.reply({ content:'Registered', ephemeral:true });
    }
    if (cmd === 'unregister') {
      const tour = getTargetTournamentOrReply(); if (!tour) return;
      if (tour.status !== 'registration') return interaction.reply({ content:'Cannot unregister', ephemeral:true });
      const idx = tour.participants.findIndex(p=>p.id===interaction.user.id);
      if (idx === -1) return interaction.reply({ content:'Not registered', ephemeral:true });
      tour.participants.splice(idx,1); saveStorage(); await updateRegistrationEmbed(tour, client); return interaction.reply({ content:'Unregistered', ephemeral:true });
    }

    // CREATE TOURNAMENT
    if (cmd === 'create_tournament') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content:'Only organizers', ephemeral:true });
      const name = interaction.options.getString('name');
      const bracket_channel = interaction.options.getString('bracket_channel') || '';
      const registration_channel = interaction.options.getString('registration_channel') || '';
      const announce_channel = interaction.options.getString('announce_channel') || '';
      const vote_channel = interaction.options.getString('vote_channel') || '';
      const maxP = interaction.options.getInteger('max_participants') || 0;
      const id = genTournamentId();
      storage.tournaments[id] = {
        id, name, status:'registration', participants:[], rounds:[], size:0,
        registrationMessageId:null, bracketMessageId:null,
        channels: { bracket: bracket_channel, registration: registration_channel, battleCategory:'', announce: announce_channel, vote: vote_channel },
        maxParticipants: maxP,
        roundReplyTimeoutHours: config.roundReplyTimeoutHours,
        voteDurationMinutes: config.voteDurationMinutes,
        createdAt: Date.now()
      };
      if (!storage.meta) storage.meta = {};
      storage.meta.currentTournament = id;
      saveStorage();
      return interaction.reply({ content:`Created tournament ${name} (id: ${id}). Use /post_registration`, ephemeral:true });
    }

    // POST_REGISTRATION
    if (cmd === 'post_registration') {
      const tour = getTargetTournamentOrReply(); if (!tour) return;
      try { const msg = await postRegistrationEmbed(tour, client); await updateRegistrationEmbed(tour, client); return interaction.reply({ content:`Posted registration in <#${tour.channels.registration || config.registrationChannel || config.bracketChannel}>`, ephemeral:true }); }
      catch(e){ return interaction.reply({ content:`Failed: ${e.message}`, ephemeral:true }); }
    }

    // CLOSE_REGISTRATION -> build bracket
    if (cmd === 'close_registration') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content:'Only organizers', ephemeral:true });
      const tour = getTargetTournamentOrReply(); if (!tour) return;
      if (tour.participants.length < 2) return interaction.reply({ content:'Not enough participants', ephemeral:true });
      buildInitialBracket(tour); regenerateNextRounds(tour); saveStorage();
      try { await assignRoundToChannels(tour, 0, client); } catch(e){ console.error('assignRound',e); }
      await updateBracketMessage(tour, client);
      return interaction.reply({ content:'Registration closed. Bracket built & fixtures assigned.', ephemeral:false });
    }

    // ASSIGN_FIXTURES
    if (cmd === 'assign_fixtures') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content:'Only organizers', ephemeral:true });
      const tour = getTargetTournamentOrReply(); if (!tour) return;
      try { await assignRoundToChannels(tour, 0, client); saveStorage(); await updateBracketMessage(tour, client); return interaction.reply({ content:'Assignments done', ephemeral:true }); } catch(e){ console.error(e); return interaction.reply({ content:'Failed assign', ephemeral:true }); }
    }

    // OPEN_VOTE
    if (cmd === 'open_vote') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content:'Only organizers', ephemeral:true });
      const matchId = interaction.options.getString('match_id'); const dur = interaction.options.getInteger('duration_minutes') || null;
      const tour = getTargetTournamentOrReply(); if (!tour) return;
      const found = findMatchById(tour, matchId); if (!found) return interaction.reply({ content:'Match not found', ephemeral:true });
      try { await postVoteForMatch(tour, found.match, client, dur || tour.voteDurationMinutes); return interaction.reply({ content:`Vote opened in <#${tour.channels.vote || config.voteChannel || found.match.channelId}>`, ephemeral:true }); }
      catch(e){ console.error(e); return interaction.reply({ content:`Failed to open vote: ${e.message}`, ephemeral:true }); }
    }

    // END_MATCH
    if (cmd === 'end_match') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content:'Only organizers', ephemeral:true });
      const matchId = interaction.options.getString('match_id'); const winner = interaction.options.getString('winner');
      const tour = getTargetTournamentOrReply(); if (!tour) return;
      const found = findMatchById(tour, matchId); if (!found) return interaction.reply({ content:'Match not found', ephemeral:true });
      const match = found.match;
      if (winner !== 'p1' && winner !== 'p2') return interaction.reply({ content:'Invalid winner', ephemeral:true });
      match.winner = winner; match.status = 'finished'; saveStorage();
      regenerateNextRounds(tour); await updateBracketMessage(tour, client);
      try { const ach = await client.channels.fetch(tour.channels.announce || config.announcementChannel || tour.channels.bracket || config.bracketChannel); if (ach) await ach.send(`Match ${match.id} finished. Winner: **${match[winner] ? match[winner].name : winner}**`); } catch(e){}
      return interaction.reply({ content:`Match ${matchId} set to ${winner}`, ephemeral:true });
    }

    // END_TOURNAMENT
    if (cmd === 'end_tournament') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content:'Only organizers', ephemeral:true });
      const tour = getTargetTournamentOrReply(); if (!tour) return;
      const last = tour.rounds && tour.rounds.length ? tour.rounds[tour.rounds.length-1].matches : null;
      if (!last || last.length===0) { tour.status='finished'; saveStorage(); return interaction.reply({ content:'Tournament ended manually. No champion set.', ephemeral:false }); }
      const final = last[0];
      if (!final || !final.winner) { tour.status='finished'; saveStorage(); return interaction.reply({ content:'Tournament ended manually. No champion set.', ephemeral:false }); }
      const champ = final[final.winner];
      tour.status='finished'; saveStorage();
      try { const ach = await client.channels.fetch(tour.channels.announce || config.announcementChannel || tour.channels.bracket || config.bracketChannel); if (ach) await ach.send(`Tournament **${tour.name}** finished. Champion: **${champ?champ.name:'Unknown'}**`); } catch(e){}
      return interaction.reply({ content:`Tournament ended. Champion: ${champ?champ.name:'Unknown'}`, ephemeral:false });
    }

    // SET_CHANNELS
    if (cmd === 'set_channels') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content:'Only organizers', ephemeral:true });
      const bracket = interaction.options.getString('bracket_channel'); const registration = interaction.options.getString('registration_channel'); const battleCategory = interaction.options.getString('battle_category'); const announce = interaction.options.getString('announce_channel'); const vote = interaction.options.getString('vote_channel');
      if (bracket) config.bracketChannel = bracket; if (registration) config.registrationChannel = registration; if (battleCategory) config.battleCategory = battleCategory; if (announce) config.announcementChannel = announce; if (vote) config.voteChannel = vote; saveConfig();
      return interaction.reply({ content:'Channels updated', ephemeral:true });
    }

    // SET_BATTLE_CHANNELS
    if (cmd === 'set_battle_channels') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content:'Only organizers', ephemeral:true });
      const csv = interaction.options.getString('channels'); config.battleChannels = csv.split(',').map(s=>s.trim()).filter(Boolean); saveConfig();
      return interaction.reply({ content:`Battle channels set: ${config.battleChannels.join(',')}`, ephemeral:true });
    }

    // SHOW_BRACKET
    if (cmd === 'show_bracket') {
      const tour = getTargetTournamentOrReply(); if (!tour) return;
      try { const buf = await drawBracketImage(tour, config.image || {}); const att = new AttachmentBuilder(buf, { name:'bracket.png' }); return interaction.reply({ files:[att], ephemeral:false }); } catch(e){ console.error(e); return interaction.reply({ content:'Failed draw', ephemeral:true }); }
    }

  } catch (e) {
    console.error('interaction error', e);
    try { if (!interaction.replied) await interaction.reply({ content:'Internal error', ephemeral:true }); } catch {}
  }
});

// ---------- SERVER & LOGIN ----------
const app = express();
app.get('/', (req,res)=>res.send('Organizer bot alive'));
const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log(`Keep-alive on ${port}`));

if (!process.env.BOT_TOKEN) console.error('BOT_TOKEN missing');
else client.login(process.env.BOT_TOKEN).catch(e=>console.error('Login failed',e));
