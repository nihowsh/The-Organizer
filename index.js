// index.js - The Organizer (single-file copy/paste)
require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const {
  REST, Routes,
  Client, GatewayIntentBits, Partials,
  AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionsBitField
} = require('discord.js');

// BRACKET DRAWER is required below as a module name; paste bracketDrawer.js into same folder
const { drawBracketImage } = require('./bracketDrawer');

// ---------- CONFIG / STORAGE (paths used only for persistence) ----------
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STORAGE_PATH = path.join(__dirname, 'storage.json');

const defaultConfig = {
  bracketChannel: "",
  registrationChannel: "",
  battleCategory: "",
  announcementChannel: "",
  voteChannel: "",
  battleChannels: [],            // explicit channel ids to round-robin battles into
  organizerRoleIds: [],         // role IDs considered organizers
  roundReplyTimeoutHours: 24,
  voteDurationMinutes: 24 * 60, // default 24 hours in minutes
  image: { width: 1400, height: 900, bgColor: "#2a0710", textColor: "#fff" }
};

let config = fs.existsSync(CONFIG_PATH) ? fs.readJsonSync(CONFIG_PATH) : defaultConfig;
config = Object.assign({}, defaultConfig, config);

let storage = fs.existsSync(STORAGE_PATH) ? fs.readJsonSync(STORAGE_PATH) : { tournaments: {}, meta: { currentTournament: null } };

function saveConfig(){ fs.writeJsonSync(CONFIG_PATH, config, { spaces: 2 }); }
function saveStorage(){ fs.writeJsonSync(STORAGE_PATH, storage, { spaces: 2 }); }

// ---------- UTIL ----------
function highestPowerOfTwoLE(n){
  let p = 1;
  while ((p << 1) <= n) p <<= 1;
  return p;
}
function nextPowerOfTwo(n){
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
function genTournamentId(){ return `t_${Date.now().toString(36)}_${Math.floor(Math.random()*900+100)}`; }
function isOrganizerMember(member){
  if (!member) return false;
  if (member.permissions && member.permissions.has && member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  const roles = config.organizerRoleIds || [];
  for (const r of roles) if (member.roles && member.roles.cache && member.roles.cache.has(r)) return true;
  return false;
}

// ---------- BRACKET BUILDING WITH PRELIMS ----------
function buildInitialBracket(tour){
  // tour.participants: [{id, name, joinedAt}] (earliest first)
  const parts = (tour.participants || []).slice();
  const N = parts.length;
  const T = highestPowerOfTwoLE(Math.max(1, N)); // target bracket size (≤ N)
  // If N <= 1, minimal bracket: handle edge cases later
  const prelimMatches = (N > T) ? (N - T) : 0;
  const prelimPlayers = prelimMatches * 2;
  const qualifiedCount = N - prelimPlayers; // earliest registrants auto-qualify
  // Build rounds array. We'll create an optional Prelims round (index 0) if needed,
  // then the main bracket rounds from Round of T down to Final.
  const rounds = [];

  // Prelims (if required) - players = most recent `prelimPlayers`
  if (prelimMatches > 0){
    // choose prelimPlayers from the END (most recent registrants)
    const prelimPool = parts.slice(qualifiedCount); // length = prelimPlayers
    // Pair them sequentially into prelimMatches
    const prelimRound = [];
    for (let i = 0; i < prelimPool.length; i += 2) {
      const p1 = prelimPool[i] ? { id: prelimPool[i].id, name: prelimPool[i].name } : null;
      const p2 = prelimPool[i+1] ? { id: prelimPool[i+1].id, name: prelimPool[i+1].name } : null;
      prelimRound.push({ id: `P${(i/2)+1}`, p1, p2, winner: null, status: 'pending', channelId: null, votes: {}, roundCount: 0, lastPoster: null });
    }
    rounds.push({ label: 'Prelims', isPrelim: true, matches: prelimRound });
  }

  // Build main round 1 (size T -> T/2 matches) and fill with qualified + winners placeholders
  // Build slot list for T players: first put qualified (earliest), then placeholders for winners of prelims
  const qualified = parts.slice(0, qualifiedCount).map(p => ({ id: p.id, name: p.name }));
  const slots = [];
  // We'll create final slots array length T:
  // fill with qualified then placeholders 'PREL_WIN_x'
  let qi = 0;
  const prelimSpots = prelimMatches; // number of spots from prelim winners
  // Strategy: Keep earliest qualified at front slots; after that place placeholders
  for (let i = 0; i < T; i++) {
    if (qi < qualified.length) { slots.push(qualified[qi++]); }
    else { slots.push(null); } // will be filled by prelim winners or remain null (bye)
  }

  // For the first main round matches, create pairs from slots
  const firstRound = [];
  for (let i = 0; i < T; i += 2) {
    const p1 = slots[i] ? { id: slots[i].id, name: slots[i].name } : null;
    const p2 = slots[i+1] ? { id: slots[i+1].id, name: slots[i+1].name } : null;
    firstRound.push({ id: `R1M${i/2+1}`, p1, p2, winner: null, status: 'locked', channelId: null, votes: {}, roundCount: 0, lastPoster: null });
  }

  rounds.push({ label: `Round of ${T}`, isPrelim: false, matches: firstRound });

  // Build subsequent rounds until final
  let prevCount = firstRound.length;
  let rIdx = 1;
  while (prevCount > 1){
    const nextCount = Math.ceil(prevCount / 2);
    const arr = [];
    for (let i = 0; i < nextCount; i++){
      arr.push({ id: `R${rIdx+1}M${i+1}`, p1: null, p2: null, winner: null, status: 'locked', channelId: null, votes: {}, roundCount: 0, lastPoster: null });
    }
    rounds.push({ label: `R${rIdx+1}`, isPrelim: false, matches: arr });
    prevCount = nextCount;
    rIdx++;
  }

  // store structure
  tour.rounds = rounds;
  tour.size = T;
  tour.prelimMatches = prelimMatches; // meta
  tour.prelimPlayers = prelimPlayers;
}

// regenerateNextRounds: propagate winners forward; handle prelim winners mapping
function regenerateNextRounds(tour){
  if (!tour.rounds) return;
  // If prelim exists at index 0, its winners must feed into first main round's empty slots
  let mainIndex = 0;
  if (tour.rounds[0] && tour.rounds[0].isPrelim) mainIndex = 1;
  // Fill first main round slots: for each match in first main round, keep existing p1/p2 unless null,
  // and if null, try to fill from prelim winners in sequence.
  if (mainIndex === 1) {
    const prelim = tour.rounds[0].matches;
    const firstMain = tour.rounds[1].matches; // Round of T
    // Collect prelim winners
    const prelimWinners = prelim.map(m => {
      if (!m) return null;
      if (!m.winner) return null;
      return (m.winner === 'p1') ? m.p1 : m.p2;
    }).filter(Boolean);
    // Fill null slots in firstMain by ordering: fill from left to right.
    let idx = 0;
    for (let i = 0; i < firstMain.length; i++){
      const m = firstMain[i];
      if (m.p1 === null && idx < prelimWinners.length) { m.p1 = prelimWinners[idx++]; m.status = 'pending'; }
      if (m.p2 === null && idx < prelimWinners.length) { m.p2 = prelimWinners[idx++]; m.status = 'pending'; }
    }
  }

  // Now propagate winners for all rounds
  for (let r = 0; r < tour.rounds.length - 1; r++){
    const curr = tour.rounds[r].matches;
    const next = tour.rounds[r+1].matches;
    let idx = 0;
    for (let i = 0; i < curr.length; i += 2) {
      const m1 = curr[i];
      const m2 = curr[i+1];
      const winner1 = m1 && m1.winner ? (m1.winner === 'p1' ? m1.p1 : m1.p2) : null;
      const winner2 = m2 && m2.winner ? (m2.winner === 'p1' ? m2.p1 : m2.p2) : null;
      if (next[idx]) {
        next[idx].p1 = winner1;
        next[idx].p2 = winner2;
        next[idx].status = (next[idx].p1 || next[idx].p2) ? 'pending' : 'locked';
      }
      idx++;
    }
  }
}

// ---------- ASSIGN FIXTURES (channels) ----------
async function assignRoundToChannels(tour, roundIndex = 0, client){
  if (!tour.rounds || !tour.rounds[roundIndex]) throw new Error('Round not found');
  const round = tour.rounds[roundIndex].matches;
  const explicit = (config.battleChannels && config.battleChannels.length) ? config.battleChannels : (tour.channels && tour.channels.battleChannels ? tour.channels.battleChannels : []);
  const categoryId = tour.channels && tour.channels.battleCategory ? tour.channels.battleCategory : config.battleCategory || null;
  let chanIdx = 0;
  const announcements = [];
  for (const match of round){
    if (!match) continue;
    if (!match.p1 && !match.p2) { match.channelId = null; continue; }
    if (!match.channelId){
      if (explicit && explicit.length > 0){
        match.channelId = explicit[chanIdx % explicit.length];
        chanIdx++;
      } else if (categoryId && client){
        try {
          // Attempt to create in the first guild bot is in (multi-guild could be adapted)
          const guild = client.guilds.cache.first();
          if (guild) {
            const name = `battle-${match.id.toLowerCase()}`.replace(/[^a-z0-9-]/gi, '-').slice(0, 90);
            const ch = await guild.channels.create({ name, type: 0, parent: categoryId || null });
            match.channelId = ch.id;
            // send match info into the new channel
            await ch.send(`Match ${match.id}: ${match.p1 ? match.p1.name : 'TBD'} vs ${match.p2 ? match.p2.name : 'TBD'}\nOrganizer will start/end match only.`);
          }
        } catch (e) {
          console.error('channel create failed', e);
        }
      } else {
        // fallback to bracket channel or announce
        match.channelId = tour.channels && tour.channels.bracket ? tour.channels.bracket : config.bracketChannel || null;
      }
    }
    announcements.push(match);
  }

  // Post announcements
  const announceId = tour.channels && tour.channels.announce ? tour.channels.announce : config.announcementChannel || tour.channels.bracket || config.bracketChannel;
  if (announceId) {
    try {
      const ch = await client.channels.fetch(announceId);
      if (ch) {
        for (const m of announcements) {
          const p1n = m.p1 ? m.p1.name : 'TBD';
          const p2n = m.p2 ? m.p2.name : 'TBD';
          const mention = `${m.p1 ? `<@${m.p1.id}>` : ''} ${m.p2 ? `<@${m.p2.id}>` : ''}`;
          await ch.send(`Match ${m.id}: **${p1n}** vs **${p2n}** — Battle will take place in <#${m.channelId}>. ${mention}`);
        }
      }
    } catch (e) {
      console.error('announce failed', e);
    }
  }
  saveStorage();
  await updateBracketMessage(tour, client);
}

// ---------- REGISTRATION EMBED (reaction) ----------
async function postRegistrationEmbed(tour, client){
  const chanId = tour.channels && tour.channels.registration ? tour.channels.registration : config.registrationChannel || config.bracketChannel || null;
  if (!chanId) throw new Error('No registration channel set');
  const ch = await client.channels.fetch(chanId);
  if (!ch) throw new Error('Registration channel not found');
  const names = tour.participants && tour.participants.length ? tour.participants.map((p,i)=>`${i+1}. ${p.name}`).join('\n') : 'No participants yet';
  const embed = {
    title: `${tour.name} — Registration`,
    description: `React with ✅ to register.\nPrelims exist only if needed. First-come-first-serve qualifying slots.`,
    fields: [{ name: `Participants (${tour.participants.length})`, value: names }],
    timestamp: new Date()
  };
  const msg = await ch.send({ embeds: [embed] });
  await msg.react('✅');
  tour.registrationMessageId = msg.id;
  saveStorage();
  return msg;
}

async function updateRegistrationEmbed(tour, client){
  if (!tour.registrationMessageId) return;
  const chanId = tour.channels && tour.channels.registration ? tour.channels.registration : config.registrationChannel || config.bracketChannel || null;
  if (!chanId) return;
  try {
    const ch = await client.channels.fetch(chanId);
    const msg = await ch.messages.fetch(tour.registrationMessageId);
    const names = tour.participants && tour.participants.length ? tour.participants.map((p,i)=>`${i+1}. ${p.name}`).join('\n') : 'No participants yet';
    const embed = msg.embeds[0] ? msg.embeds[0].toJSON() : { title: `${tour.name} — Registration`, description: `React with ✅ to register.` };
    embed.fields = [{ name: `Participants (${tour.participants.length})`, value: names }];
    await msg.edit({ embeds: [embed] });
  } catch (e) {
    console.error('updateRegistrationEmbed failed', e);
  }
}

// ---------- VOTING ----------
async function postVoteForMatch(tour, match, client){
  const voteChanId = tour.channels && tour.channels.vote ? tour.channels.vote : config.voteChannel || match.channelId;
  if (!voteChanId) throw new Error('No vote channel available');
  const ch = await client.channels.fetch(voteChanId);
  if (!ch) throw new Error('Vote channel not found');
  const p1label = match.p1 ? match.p1.name : 'Player 1';
  const p2label = match.p2 ? match.p2.name : 'Player 2';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote_${match.id}_p1`).setLabel(p1label).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vote_${match.id}_p2`).setLabel(p2label).setStyle(ButtonStyle.Danger)
  );
  const msg = await ch.send({ content: `Vote for winner of ${match.id}: ${p1label} vs ${p2label}`, components: [row] });
  match.votingMessageId = msg.id;
  match.status = 'voting';
  saveStorage();
  // collector to auto-tally
  const durationMs = (tour.voteDurationMinutes || config.voteDurationMinutes) * 60 * 1000;
  const collector = msg.createMessageComponentCollector({ componentType: 2, time: durationMs });
  const votes = new Map();
  collector.on('collect', async i => {
    if (votes.has(i.user.id)) {
      await i.reply({ content: 'You already voted.', ephemeral: true });
      return;
    }
    const parts = i.customId.split('_');
    const choice = parts[2];
    votes.set(i.user.id, choice);
    await i.reply({ content: `Vote recorded for ${choice}`, ephemeral: true });
  });
  collector.on('end', async () => {
    const tally = { p1: 0, p2: 0 };
    for (const v of votes.values()){
      if (v === 'p1') tally.p1++;
      if (v === 'p2') tally.p2++;
    }
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
    // announce
    try {
      const ach = await client.channels.fetch(tour.channels.announce || config.announcementChannel || tour.channels.bracket || config.bracketChannel);
      if (ach) await ach.send(`Voting ended for ${match.id}. Results: p1=${tally.p1}, p2=${tally.p2}. Winner: **${match[winnerKey] ? match[winnerKey].name : winnerKey}**`);
    } catch (e) {}
  });
  return msg;
}

// ---------- FIND MATCH ----------
function findMatchById(tour, matchId){
  if (!tour || !tour.rounds) return null;
  for (let ri = 0; ri < tour.rounds.length; ri++){
    const rnd = tour.rounds[ri].matches;
    for (const m of rnd) {
      if (m && m.id === matchId) return { match: m, roundIndex: ri };
    }
  }
  return null;
}

// ---------- BRACKET IMAGE UPDATER ----------
async function updateBracketMessage(tour, client){
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
  } catch (e) {
    console.error('updateBracketMessage error', e);
  }
}

// ---------- TIMERS ----------
const timers = new Map();
function scheduleMatchTimeout(tour, match, client, ms){
  if (!match || !match.id) return;
  if (timers.has(match.id)) clearTimeout(timers.get(match.id));
  const to = setTimeout(async () => {
    timers.delete(match.id);
    match.status = 'timed_out';
    saveStorage();
    // Post vote automatically on timeout
    try { await postVoteForMatch(tour, match, client); } catch (e) { console.error('auto vote fail', e); }
  }, ms);
  timers.set(match.id, to);
}
function restoreTimers(client){
  for (const tid of Object.keys(storage.tournaments)) {
    const tour = storage.tournaments[tid];
    if (!tour || !tour.rounds) continue;
    for (const rnd of tour.rounds) {
      for (const m of rnd.matches) {
        if (!m) continue;
        if (m.deadlineTs && !m.winner && m.status !== 'finished') {
          const msLeft = m.deadlineTs - Date.now();
          if (msLeft > 0) scheduleMatchTimeout(tour, m, client, msLeft);
          else {
            // expired while offline -> mark timed_out and optionally start vote
            m.status = 'timed_out';
            saveStorage();
            try { postVoteForMatch(tour, m, client); } catch (e) {}
          }
        }
      }
    }
  }
}

// ---------- DISCORD SETUP & COMMANDS ----------
const commands = [
  { name: 'create_tournament', description: 'Create a tournament (organizer only)', options: [
      { name: 'name', description: 'Tournament name', type: 3, required: true },
      { name: 'bracket_channel', description: 'Bracket channel id', type: 3, required: false },
      { name: 'registration_channel', description: 'Registration channel id', type: 3, required: false },
      { name: 'announce_channel', description: 'Announce channel id', type: 3, required: false },
      { name: 'vote_channel', description: 'Vote channel id', type: 3, required: false },
      { name: 'max_participants', description: 'Max participants (0=unlimited)', type: 4, required: false }
    ] },
  { name: 'post_registration', description: 'Post registration embed', options: [{ name:'tournament', type:3, required:false }] },
  { name: 'open_registration', description: 'Open registration', options: [{ name:'tournament', type:3, required:false }] },
  { name: 'close_registration', description: 'Close registration & build bracket', options: [{ name:'tournament', type:3, required:false }] },
  { name: 'assign_fixtures', description: 'Assign fixtures to battle channels', options: [{ name:'tournament', type:3, required:false }] },
  { name: 'open_vote', description: 'Open vote for a match', options: [{ name:'match_id', type:3, required:true }, { name:'tournament', type:3, required:false }] },
  { name: 'end_match', description: 'End a match and set winner', options: [{ name:'match_id', type:3, required:true }, { name:'winner', type:3, required:true }, { name:'tournament', type:3, required:false }] },
  { name: 'end_tournament', description: 'End a tournament', options: [{ name:'tournament', type:3, required:false }] },
  { name: 'set_channels', description: 'Set default channels', options: [
      { name:'bracket_channel', type:3 }, { name:'registration_channel', type:3 }, { name:'battle_category', type:3 },
      { name:'announce_channel', type:3 }, { name:'vote_channel', type:3 }
    ] },
  { name: 'set_battle_channels', description: 'Set battle channels (comma separated IDs)', options: [{ name:'channels', type:3, required:true }] },
  { name: 'set_organizer_roles', description: 'Set organizer role IDs (comma separated)', options: [{ name:'roles', type:3, required:true }] },
  { name: 'show_bracket', description: 'Show bracket image', options: [{ name:'tournament', type:3, required:false }] },
  { name: 'register', description: 'Register (legacy via slash)', options: [{ name:'tournament', type:3, required:false }] },
  { name: 'unregister', description: 'Unregister (legacy)', options: [{ name:'tournament', type:3, required:false }] }
];

async function deployCommands(){
  if (!process.env.BOT_TOKEN || !process.env.CLIENT_ID) { console.warn('CLIENT_ID or BOT_TOKEN missing; skip auto-deploy'); return; }
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    if (process.env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
      console.log('Guild commands deployed');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('Global commands deployed (may take ~1h)');
    }
  } catch (e) { console.error('deploy failed', e); }
}
deployCommands();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

// ---------- READY ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // if no current tournament, pick latest
  if (!storage.meta) storage.meta = {};
  if (!storage.meta.currentTournament && Object.keys(storage.tournaments).length > 0) {
    storage.meta.currentTournament = Object.keys(storage.tournaments)[0];
    saveStorage();
  }
  restoreTimers(client);
  // refresh bracket messages for all tournaments
  for (const id of Object.keys(storage.tournaments)){
    const t = storage.tournaments[id];
    try { await updateBracketMessage(t, client); } catch(e){}
  }
});

// ---------- REACTION REGISTRATION ----------
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    const tour = Object.values(storage.tournaments).find(t => t.registrationMessageId === msg.id);
    if (!tour) return;
    if (reaction.emoji.name !== '✅') return;
    if (tour.status !== 'registration') { try { await user.send('Registration is closed for this tournament.'); } catch{}; return; }
    if (tour.maxParticipants && tour.participants.length >= tour.maxParticipants) { try { await user.send('Tournament is full'); } catch{}; return; }
    if (tour.participants.find(p => p.id === user.id)) { try { await user.send('Already registered'); } catch{}; return; }
    tour.participants.push({ id: user.id, name: user.username || user.tag, joinedAt: Date.now() });
    saveStorage();
    await updateRegistrationEmbed(tour, client);
  } catch (e) { console.error('reaction add', e); }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    const tour = Object.values(storage.tournaments).find(t => t.registrationMessageId === msg.id);
    if (!tour) return;
    if (reaction.emoji.name !== '✅') return;
    const idx = tour.participants.findIndex(p => p.id === user.id);
    if (idx !== -1) { tour.participants.splice(idx, 1); saveStorage(); await updateRegistrationEmbed(tour, client); }
  } catch (e) { console.error('reaction remove', e); }
});

// ---------- MESSAGE CREATE for battle channels ----------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  for (const tid of Object.keys(storage.tournaments)) {
    const tour = storage.tournaments[tid];
    if (!tour || tour.status !== 'running' || !tour.rounds) continue;
    for (const rnd of tour.rounds) {
      for (const match of rnd.matches) {
        if (!match || !match.channelId) continue;
        if (match.channelId === message.channel.id) {
          const uid = message.author.id;
          if (!((match.p1 && match.p1.id === uid) || (match.p2 && match.p2.id === uid))) return;
          if (match.lastPoster && match.lastPoster === uid) { try { await message.reply({ content: 'Wait for your opponent to reply (alternate turns).', ephemeral: true }); } catch{}; return; }
          match.lastPoster = uid;
          match.roundCount = (match.roundCount || 0) + 1;
          match.deadlineTs = Date.now() + (tour.roundReplyTimeoutHours || config.roundReplyTimeoutHours) * 60 * 60 * 1000;
          match.finished = false;
          saveStorage();
          scheduleMatchTimeout(tour, match, client, match.deadlineTs - Date.now());
          try {
            const opponentId = (match.p1 && match.p1.id === uid) ? (match.p2 && match.p2.id) : (match.p1 && match.p1.id);
            const note = await message.channel.send(`Post recorded from ${message.author.username}. ${opponentId ? `<@${opponentId}>` : ''} you have ${tour.roundReplyTimeoutHours || config.roundReplyTimeoutHours} hours to reply.`);
            setTimeout(()=> note.delete().catch(()=>{}), 12*1000);
          } catch{}
          return;
        }
      }
    }
  }
});

// ---------- INTERACTIONS (buttons + slash commands) ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // BUTTONS (votes)
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (!id.startsWith('vote_')) return;
      const parts = id.split('_'); // vote_<matchId>_p1
      const matchId = parts[1];
      const choice = parts[2];
      // find match across tournaments
      for (const tid of Object.keys(storage.tournaments)) {
        const tour = storage.tournaments[tid];
        const found = findMatchById(tour, matchId);
        if (found) {
          const match = found.match;
          match.votes = match.votes || {};
          if (match.votes[interaction.user.id]) {
            await interaction.reply({ content: 'You already voted', ephemeral: true });
            return;
          }
          match.votes[interaction.user.id] = choice;
          await interaction.reply({ content: `Vote recorded for ${choice}`, ephemeral: true });
          saveStorage();
          return;
        }
      }
      await interaction.reply({ content: 'Match not found', ephemeral: true });
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const cmd = interaction.commandName;
    const argTournament = interaction.options.getString('tournament') || 'current';
    const tournamentId = (argTournament === 'current') ? (storage.meta && storage.meta.currentTournament) : (argTournament || null);
    const tournament = tournamentId ? storage.tournaments[tournamentId] : null;

    function getTargetOrReply() {
      if (argTournament === 'current') {
        const cur = storage.meta && storage.meta.currentTournament;
        if (!cur) { interaction.reply({ content: 'No current tournament selected', ephemeral: true }); return null; }
        return storage.tournaments[cur];
      }
      const t = storage.tournaments[argTournament];
      if (!t) { interaction.reply({ content: `Tournament ${argTournament} not found`, ephemeral: true }); return null; }
      return t;
    }

    // register/unregister (slash legacy)
    if (cmd === 'register') {
      const tour = getTargetOrReply(); if (!tour) return;
      if (tour.status !== 'registration') return interaction.reply({ content: 'Registration is closed.', ephemeral: true });
      if (tour.participants.find(p => p.id === interaction.user.id)) return interaction.reply({ content: 'Already registered', ephemeral: true });
      if (tour.maxParticipants && tour.participants.length >= tour.maxParticipants) return interaction.reply({ content: 'Tournament is full', ephemeral: true });
      tour.participants.push({ id: interaction.user.id, name: interaction.member.displayName || interaction.user.username, joinedAt: Date.now() });
      saveStorage();
      await updateRegistrationEmbed(tour, client);
      return interaction.reply({ content: 'Registered', ephemeral: true });
    }
    if (cmd === 'unregister') {
      const tour = getTargetOrReply(); if (!tour) return;
      if (tour.status !== 'registration') return interaction.reply({ content: 'Cannot unregister now', ephemeral: true });
      const idx = tour.participants.findIndex(p => p.id === interaction.user.id);
      if (idx === -1) return interaction.reply({ content: 'You are not registered', ephemeral: true });
      tour.participants.splice(idx, 1); saveStorage(); await updateRegistrationEmbed(tour, client);
      return interaction.reply({ content: 'Unregistered', ephemeral: true });
    }

    // create_tournament
    if (cmd === 'create_tournament') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const name = interaction.options.getString('name');
      const bracket_channel = interaction.options.getString('bracket_channel') || '';
      const registration_channel = interaction.options.getString('registration_channel') || '';
      const announce_channel = interaction.options.getString('announce_channel') || '';
      const vote_channel = interaction.options.getString('vote_channel') || '';
      const maxP = interaction.options.getInteger('max_participants') || 0;
      const id = genTournamentId();
      storage.tournaments[id] = {
        id, name, status: 'registration', participants: [], rounds: [], size: 0,
        registrationMessageId: null, bracketMessageId: null,
        channels: { bracket: bracket_channel, registration: registration_channel, battleCategory: '', announce: announce_channel, vote: vote_channel },
        maxParticipants: maxP,
        roundReplyTimeoutHours: config.roundReplyTimeoutHours,
        voteDurationMinutes: config.voteDurationMinutes,
        createdAt: Date.now()
      };
      if (!storage.meta) storage.meta = {};
      storage.meta.currentTournament = id;
      saveStorage();
      return interaction.reply({ content: `Created tournament **${name}** (id: ${id}). Use /post_registration to publish.`, ephemeral: true });
    }

    // post_registration
    if (cmd === 'post_registration') {
      const tour = getTargetOrReply(); if (!tour) return;
      try {
        await postRegistrationEmbed(tour, client);
        await updateRegistrationEmbed(tour, client);
        return interaction.reply({ content: `Posted registration in <#${tour.channels.registration || config.registrationChannel || config.bracketChannel}>`, ephemeral: true });
      } catch (e) {
        return interaction.reply({ content: `Failed to post registration: ${e.message}`, ephemeral: true });
      }
    }

    // open_registration
    if (cmd === 'open_registration') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const tour = getTargetOrReply(); if (!tour) return;
      tour.status = 'registration'; saveStorage();
      if (!tour.registrationMessageId) { try { await postRegistrationEmbed(tour, client); } catch(e){} }
      await updateRegistrationEmbed(tour, client);
      return interaction.reply({ content: `Registration opened for ${tour.name}`, ephemeral: true });
    }

    // close_registration -> build bracket & assign fixtures
    if (cmd === 'close_registration') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const tour = getTargetOrReply(); if (!tour) return;
      if (tour.participants.length < 2) return interaction.reply({ content: 'Not enough participants (min 2).', ephemeral: true });
      tour.status = 'running';
      buildInitialBracket(tour);
      regenerateNextRounds(tour);
      saveStorage();
      try { await assignRoundToChannels(tour, 0, client); } catch (e) { console.error('assign error', e); }
      await updateBracketMessage(tour, client);
      return interaction.reply({ content: 'Registration closed. Bracket built and matches assigned.', ephemeral: false });
    }

    // assign_fixtures
    if (cmd === 'assign_fixtures') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const tour = getTargetOrReply(); if (!tour) return;
      if (!tour.rounds || !tour.rounds.length) return interaction.reply({ content: 'No bracket available.', ephemeral: true });
      try { await assignRoundToChannels(tour, 0, client); saveStorage(); await updateBracketMessage(tour, client); return interaction.reply({ content: 'Assignments done.', ephemeral: true }); }
      catch (e) { console.error(e); return interaction.reply({ content: 'Failed to assign', ephemeral: true }); }
    }

    // open_vote
    if (cmd === 'open_vote') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const matchId = interaction.options.getString('match_id');
      const tour = getTargetOrReply(); if (!tour) return;
      const found = findMatchById(tour, matchId);
      if (!found) return interaction.reply({ content: 'Match not found', ephemeral: true });
      try { await postVoteForMatch(tour, found.match, client); return interaction.reply({ content: `Vote opened in <#${tour.channels.vote || config.voteChannel || found.match.channelId}>`, ephemeral: true }); }
      catch (e) { console.error(e); return interaction.reply({ content: `Failed to open vote: ${e.message}`, ephemeral: true }); }
    }

    // end_match
    if (cmd === 'end_match') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const matchId = interaction.options.getString('match_id');
      const winner = interaction.options.getString('winner');
      const tour = getTargetOrReply(); if (!tour) return;
      const found = findMatchById(tour, matchId);
      if (!found) return interaction.reply({ content: 'Match not found', ephemeral: true });
      const match = found.match;
      if (winner !== 'p1' && winner !== 'p2') return interaction.reply({ content: 'Invalid winner. Use p1 or p2', ephemeral: true });
      match.winner = winner; match.status = 'finished';
      saveStorage();
      regenerateNextRounds(tour);
      await updateBracketMessage(tour, client);
      try {
        const ach = await client.channels.fetch(tour.channels.announce || config.announcementChannel || tour.channels.bracket || config.bracketChannel);
        if (ach) await ach.send(`Match ${match.id} finished. Winner: **${match[winner] ? match[winner].name : winner}**. Bracket updated.`);
      } catch (e) {}
      return interaction.reply({ content: `Match ${matchId} set to ${winner}`, ephemeral: true });
    }

    // end_tournament
    if (cmd === 'end_tournament') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const tour = getTargetOrReply(); if (!tour) return;
      const lastRound = tour.rounds && tour.rounds.length ? tour.rounds[tour.rounds.length - 1].matches : null;
      if (!lastRound || lastRound.length === 0) return interaction.reply({ content: 'Tournament has no final', ephemeral: true });
      const finalMatch = lastRound[0];
      if (!finalMatch || !finalMatch.winner) { tour.status = 'finished'; saveStorage(); return interaction.reply({ content: 'Tournament ended manually. No champion set.', ephemeral: false }); }
      const champ = finalMatch[finalMatch.winner];
      tour.status = 'finished';
      saveStorage();
      try {
        const ach = await client.channels.fetch(tour.channels.announce || config.announcementChannel || tour.channels.bracket || config.bracketChannel);
        if (ach) await ach.send(`Tournament **${tour.name}** finished. Champion: **${champ ? champ.name : 'Unknown'}**`);
      } catch (e) {}
      return interaction.reply({ content: `Tournament ended. Champion: ${champ ? champ.name : 'Unknown'}`, ephemeral: false });
    }

    // set_channels
    if (cmd === 'set_channels') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const bracket = interaction.options.getString('bracket_channel');
      const registration = interaction.options.getString('registration_channel');
      const battleCategory = interaction.options.getString('battle_category');
      const announce = interaction.options.getString('announce_channel');
      const vote = interaction.options.getString('vote_channel');
      if (bracket) config.bracketChannel = bracket;
      if (registration) config.registrationChannel = registration;
      if (battleCategory) config.battleCategory = battleCategory;
      if (announce) config.announcementChannel = announce;
      if (vote) config.voteChannel = vote;
      saveConfig();
      return interaction.reply({ content: 'Channels updated.', ephemeral: true });
    }

    // set_battle_channels
    if (cmd === 'set_battle_channels') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const csv = interaction.options.getString('channels');
      config.battleChannels = csv.split(',').map(s=>s.trim()).filter(Boolean);
      saveConfig();
      return interaction.reply({ content: `Battle channels set: ${config.battleChannels.join(', ')}`, ephemeral: true });
    }

    // set_organizer_roles
    if (cmd === 'set_organizer_roles') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: 'Manage Server required', ephemeral: true });
      const csv = interaction.options.getString('roles');
      config.organizerRoleIds = csv.split(',').map(s=>s.trim()).filter(Boolean);
      saveConfig();
      return interaction.reply({ content: 'Organizer roles set.', ephemeral: true });
    }

    // show_bracket
    if (cmd === 'show_bracket') {
      const tour = getTargetOrReply(); if (!tour) return;
      try {
        const buf = await drawBracketImage(tour, config.image || {});
        const att = new AttachmentBuilder(buf, { name: 'bracket.png' });
        return interaction.reply({ files: [att], ephemeral: false });
      } catch (e) { console.error('draw fail', e); return interaction.reply({ content: 'Failed to draw bracket', ephemeral: true }); }
    }

  } catch (e) {
    console.error('interaction error', e);
    try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Internal error', ephemeral: true }); } catch {}
  }
});

// ---------- START SERVER & LOGIN ----------
const app = express();
app.get('/', (req, res) => res.send('Organizer bot alive'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Keep-alive listening on ${port}`));

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN missing in env');
} else {
  client.login(process.env.BOT_TOKEN).catch(e => console.error('Login failed', e));
}
