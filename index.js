// index.js
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
const { drawBracketImage } = require('./bracketDrawer');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STORAGE_PATH = path.join(__dirname, 'storage.json');

const config = fs.existsSync(CONFIG_PATH) ? fs.readJsonSync(CONFIG_PATH) : {};
config.battleChannels = config.battleChannels || [];
config.organizerRoleIds = config.organizerRoleIds || [];

const storage = fs.existsSync(STORAGE_PATH) ? fs.readJsonSync(STORAGE_PATH) : { tournaments: {} };

function saveConfig() { fs.writeJsonSync(CONFIG_PATH, config, { spaces: 2 }); }
function saveStorage() { fs.writeJsonSync(STORAGE_PATH, storage, { spaces: 2 }); }

// ----- Auto deploy slash commands (keeps your old commands) -----
const commands = [
  { name: 'register', description: 'Register for the next tournament' },
  { name: 'unregister', description: 'Unregister from the tournament' },
  { name: 'create_tournament', description: 'Create a tournament', options:[
      { name:'name', description:'Tournament name', type:3, required:true},
      { name:'bracket_channel', description:'Bracket channel ID', type:3, required:false},
      { name:'registration_channel', description:'Registration channel ID', type:3, required:false},
      { name:'battle_category', description:'Battle category ID', type:3, required:false},
      { name:'announce_channel', description:'Announcement channel ID', type:3, required:false},
      { name:'vote_channel', description:'Vote channel ID', type:3, required:false},
      { name:'max_participants', description:'max participants (0=unlimited)', type:4, required:false}
  ]},
  { name:'post_registration', description:'Post registration embed' },
  { name:'open_registration', description:'Open registration' },
  { name:'close_registration', description:'Close registration and build bracket' },
  { name:'set_channels', description:'Set default channels', options:[
      { name:'bracket_channel', type:3 }, { name:'registration_channel', type:3 },
      { name:'battle_category', type:3 }, { name:'announce_channel', type:3 }, { name:'vote_channel', type:3 }
  ]},
  { name:'set_battle_channels', description:'Set battle channels (comma separated)', options:[{ name:'channels', type:3 }] },
  { name:'set_organizer_roles', description:'Set organizer roles (comma separated)', options:[{ name:'roles', type:3 }] },
  { name:'assign_fixtures', description:'Assign fixtures to battle channels' },
  { name:'open_vote', description:'Open vote for a match', options:[{ name:'match_id', type:3, required:true }] },
  { name:'end_match', description:'End a match (organizer only)', options:[
      { name:'match_id', type:3, required:true }, { name:'winner', type:3, required:true }
  ]},
  { name:'show_bracket', description:'Show bracket image' },
  { name:'force_update_bracket', description:'Force update bracket image' }
];

async function autoDeployCommands() {
  if (!process.env.BOT_TOKEN || !process.env.CLIENT_ID) return;
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    if (process.env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
      console.log('Guild commands deployed.');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('Global commands deployed.');
    }
  } catch (err) { console.error('deploy commands failed', err); }
}
autoDeployCommands();

// ----- Client -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

const TOURNEY_ID = 'current';
if (!storage.tournaments[TOURNAMENT_ID_SAFE()]) {
  storage.tournaments[TOURNAMENT_ID_SAFE()] = createEmptyTournament('Wordsmith of the Month');
  saveStorage();
}

// helpers
function TOURNAMENT_ID_SAFE() { return TOURNEY_ID; }
function createEmptyTournament(name) {
  return {
    id: TOURNEY_ID,
    name: name || 'My Tournament',
    status: 'registration', // registration | running | finished
    participants: [], // {id, name, joinedAt}
    rounds: [], // array of { matches: [ { id, p1, p2, winner, channelId, votes, lastPoster, roundCount, status } ], isPrelim }
    size: 0, // main bracket size (power of two)
    registrationMessageId: null,
    bracketMessageId: null,
    channels: {
      bracket: config.bracketChannel || '',
      registration: config.registrationChannel || '',
      battleCategory: config.battleCategory || '',
      announce: config.announcementChannel || '',
      vote: config.voteChannel || ''
    },
    maxParticipants: config.maxParticipants || 0,
    createdAt: Date.now()
  };
}

function nextPowerOfTwo(n){ let p=1; while(p<n) p<<=1; return p; }
function prevPowerOfTwo(n){ let p=1; while((p<<1) <= n) p<<=1; return p; }

// Build bracket with Prelims (separate round) according to confirmed system
function buildBracketWithPrelims(tournament) {
  const parts = tournament.participants.slice(); // registration order
  const N = parts.length;
  if (N < 2) { tournament.rounds = []; tournament.size = 0; return; }

  // next power and "half" logic
  const Pnext = nextPowerOfTwo(N);
  const half = Pnext / 2;
  const prelimMatches = Math.max(0, N - half); // number of prelim matches
  const prelimPlayers = prelimMatches * 2;
  const directCount = N - prelimPlayers;

  const directPlayers = parts.slice(0, directCount); // these auto-qualify to main bracket
  const prelimList = parts.slice(directCount); // last registered -> go to prelims

  const rounds = [];

  // create prelim round if needed
  if (prelimMatches > 0) {
    const prelimRound = { isPrelim: true, matches: [] };
    for (let i = 0; i < prelimList.length; i += 2) {
      const a = prelimList[i] ? { id: prelimList[i].id, name: prelimList[i].name } : null;
      const b = prelimList[i+1] ? { id: prelimList[i+1].id, name: prelimList[i+1].name } : null;
      prelimRound.matches.push({
        id: `P${Math.floor(i/2)+1}`,
        p1: a, p2: b, winner: null, channelId: null, votes: {}, lastPoster: null, roundCount: 0, status: 'pending'
      });
    }
    rounds.push(prelimRound);
  }

  // main bracket size = half (power of two)
  const mainSize = half;
  tournament.size = mainSize;

  // prepare slots for main first round: fill with directPlayers then placeholders (null) for prelim winners
  const slots = [];
  for (let i = 0; i < mainSize; i++) {
    const player = directPlayers[i] ? { id: directPlayers[i].id, name: directPlayers[i].name } : null;
    slots.push(player);
  }
  // If there are still empty slots (directPlayers < mainSize), leave them null; prelim winners will fill via regeneration

  // Build first round matches of main bracket
  const firstRound = { isPrelim: false, matches: [] };
  for (let i = 0; i < mainSize; i += 2) {
    const p1 = slots[i] || null;
    const p2 = slots[i+1] || null;
    firstRound.matches.push({ id: `R1M${i/2+1}`, p1, p2, winner: null, channelId: null, votes: {}, lastPoster: null, roundCount: 0, status: (p1||p2)?'pending':'locked' });
  }
  rounds.push(firstRound);

  // Create subsequent rounds until final
  let prevCount = firstRound.matches.length;
  let roundIdx = 1;
  while (prevCount > 1) {
    const nextCount = Math.ceil(prevCount / 2);
    const rr = { isPrelim: false, matches: [] };
    for (let i = 0; i < nextCount; i++) {
      rr.matches.push({ id: `R${roundIdx+1}M${i+1}`, p1: null, p2: null, winner: null, channelId: null, votes: {}, lastPoster: null, roundCount: 0, status: 'locked' });
    }
    rounds.push(rr);
    prevCount = nextCount;
    roundIdx++;
  }

  tournament.rounds = rounds;
  // After building rounds, place prelim winners into main first round slots by regenerating
  regenerateNextRounds(tournament);
  saveStorage();
}

// regenerate next rounds from winners including mapping prelim winners into main bracket
function regenerateNextRounds(tournament) {
  const rounds = tournament.rounds || [];
  if (!rounds.length) return;
  // If first round is prelim, winners of prelim must fill into next round (which is main first round)
  let startIdx = 0;
  if (rounds[0].isPrelim) startIdx = 0; // we'll handle specially
  // First, if there is a prelim round, fill placeholders in main first round by winners (if present)
  if (rounds[0].isPrelim) {
    const prelim = rounds[0];
    const main = rounds[1];
    // main match slots might contain nulls; replace nulls from left to right with prelim winners in order of prelim matches
    // Count how many main slots are null
    const mainSlots = [];
    for (const m of main.matches) {
      mainSlots.push(m.p1 || null);
      mainSlots.push(m.p2 || null);
    }
    // Flatten prelim winners array (if any)
    const preliminaryWinners = prelim.matches.map(pm => pm.winner ? (pm.winner === 'p1' ? pm.p1 : pm.p2) : null);
    // Place winners into earliest null slots
    let widx = 0;
    for (let si = 0; si < mainSlots.length && widx < preliminaryWinners.length; si++) {
      if (!mainSlots[si] && preliminaryWinners[widx]) {
        // find target match and position
        const matchIndex = Math.floor(si / 2);
        const pos = (si % 2 === 0) ? 'p1' : 'p2';
        main.matches[matchIndex][pos] = preliminaryWinners[widx];
        main.matches[matchIndex].status = 'pending';
        widx++;
      }
    }
    // continue: after placing prelim winners, continue to fill next rounds based on finished winners
  }

  // now standard propagation for all rounds
  for (let r = 0; r < rounds.length - 1; r++) {
    const curr = rounds[r].matches;
    const next = rounds[r + 1].matches;
    let idx = 0;
    for (let i = 0; i < curr.length; i += 2) {
      const m1 = curr[i];
      const m2 = curr[i + 1];
      const winner1 = m1 && m1.winner ? (m1.winner === 'p1' ? m1.p1 : m1.p2) : null;
      const winner2 = m2 && m2.winner ? (m2.winner === 'p1' ? m2.p1 : m2.p2) : null;
      if (!next[idx]) continue;
      next[idx].p1 = winner1;
      next[idx].p2 = winner2;
      next[idx].status = (next[idx].p1 || next[idx].p2) ? 'pending' : 'locked';
      idx++;
    }
  }
  saveStorage();
}

// find match by id (search all rounds)
function findMatchById(tournament, matchId) {
  for (const round of (tournament.rounds || [])) {
    for (const m of (round.matches || [])) if (m && m.id === matchId) return { match: m, round };
  }
  return null;
}

// registration embed functions
async function postRegistrationEmbed(tournament) {
  const chanId = tournament.channels.registration || config.registrationChannel || tournament.channels.bracket || config.bracketChannel;
  if (!chanId) throw new Error('No registration channel set in config or tournament');
  const ch = await client.channels.fetch(chanId);
  if (!ch) throw new Error('Registration channel not found');
  const parts = tournament.participants || [];
  const embed = {
    title: `${tournament.name} — Registration`,
    description: `React with ✅ to register.\nFirst-come-first-serve byes. Max: ${tournament.maxParticipants || 'Unlimited'}`,
    fields: [{ name: `Participants (${parts.length})`, value: parts.map((p,i)=>`${i+1}. ${p.name}`).join('\n') || 'No participants yet' }],
    timestamp: new Date()
  };
  const msg = await ch.send({ embeds: [embed] });
  await msg.react('✅');
  tournament.registrationMessageId = msg.id;
  saveStorage();
  return msg;
}

async function updateRegistrationEmbed(tournament) {
  if (!tournament.registrationMessageId) return;
  try {
    const ch = await client.channels.fetch(tournament.channels.registration || config.registrationChannel || tournament.channels.bracket || config.bracketChannel);
    const msg = await ch.messages.fetch(tournament.registrationMessageId);
    const names = tournament.participants.map((p,i)=>`${i+1}. ${p.name}`).join('\n') || 'No participants yet';
    const embed = msg.embeds[0] ? msg.embeds[0].toJSON() : { title:`${tournament.name} — Registration`, description:'React with ✅ to register.' };
    embed.fields = [{ name: `Participants (${tournament.participants.length})`, value: names }];
    await msg.edit({ embeds: [embed] });
  } catch (e) { console.error('updateRegistrationEmbed error', e); }
}

function tryRegisterUser(tournament, user) {
  if (tournament.status !== 'registration') return { ok:false, reason:'Registration closed' };
  if (tournament.maxParticipants && tournament.participants.length >= tournament.maxParticipants) return { ok:false, reason:'Tournament full' };
  if (tournament.participants.find(p => p.id === user.id)) return { ok:false, reason:'Already registered' };
  tournament.participants.push({ id: user.id, name: user.username || user.tag || 'unknown', joinedAt: Date.now() });
  saveStorage();
  return { ok:true };
}
function tryUnregisterUser(tournament, user) {
  const idx = tournament.participants.findIndex(p=>p.id===user.id);
  if (idx === -1) return { ok:false, reason:'Not registered' };
  tournament.participants.splice(idx,1);
  saveStorage();
  return { ok:true };
}

// assign round matches to configured battle channels and announce
async function assignRoundToChannels(tournament, roundIndex = 0) {
  const channels = config.battleChannels || tournament.channels.battleChannels || [];
  if (!channels || channels.length === 0) throw new Error('No battle channels configured (set_battle_channels)');
  const round = tournament.rounds[roundIndex];
  const announceChanId = tournament.channels.announce || config.announcementChannel || tournament.channels.bracket || config.bracketChannel;
  const announceCh = announceChanId ? await client.channels.fetch(announceChanId).catch(()=>null) : null;
  let cIdx = 0;
  for (const match of round.matches) {
    if (!match) continue;
    if (!match.channelId) {
      match.channelId = channels[cIdx % channels.length];
      cIdx++;
    }
    if (announceCh) {
      const p1 = match.p1 ? match.p1.name : 'TBD';
      const p2 = match.p2 ? match.p2.name : 'TBD';
      await announceCh.send({ content: `Match **${match.id}**: **${p1}** vs **${p2}** — Battle in <#${match.channelId}>. ${match.p1?`<@${match.p1.id}>`:''} ${match.p2?`<@${match.p2.id}>`:''}` }).catch(()=>{});
    }
  }
  saveStorage();
  await updateBracketMessage(tournament);
}

// post vote message (buttons) in vote channel or match channel
async function postVoteForMatch(tournament, match) {
  const voteChanId = tournament.channels.vote || config.voteChannel || match.channelId;
  if (!voteChanId) throw new Error('No vote channel defined');
  const ch = await client.channels.fetch(voteChanId);
  const p1label = match.p1 ? match.p1.name : 'Player 1';
  const p2label = match.p2 ? match.p2.name : 'Player 2';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote_${match.id}_p1`).setLabel(p1label).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vote_${match.id}_p2`).setLabel(p2label).setStyle(ButtonStyle.Danger)
  );
  const m = await ch.send({ content: `Vote for winner of ${match.id}: ${p1label} vs ${p2label}`, components: [row] });
  match.votingMessageId = m.id;
  match.status = 'voting';
  saveStorage();
  return m;
}

// find match by id helper already present (uses object rounds)
function findMatchByIdGlobal(matchId) {
  return findMatchById(storage.tournaments[TOURNAMENT_ID_SAFE()], matchId);
}

// buttons handler: votes
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (!id.startsWith('vote_')) return;
    const [, matchId, choice] = id.split('_'); // vote_R1M1_p1
    const t = storage.tournaments[TOURNAMENT_ID_SAFE()];
    const found = findMatchById(t, matchId);
    if (!found) return interaction.reply({ content:'Match not found', ephemeral:true });
    const match = found.match;
    match.votes = match.votes || {};
    if (match.votes[interaction.user.id]) return interaction.reply({ content:'You already voted', ephemeral:true });
    match.votes[interaction.user.id] = choice;
    await interaction.reply({ content:`Vote recorded for ${choice}`, ephemeral:true });
    saveStorage();
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  // all commands below
  const cmd = interaction.commandName;
  const t = storage.tournaments[TOURNAMENT_ID_SAFE()];

  // register / unregister
  if (cmd === 'register') {
    const res = tryRegisterUser(t, interaction.user);
    if (!res.ok) return interaction.reply({ content:`Registration failed: ${res.reason}`, ephemeral:true });
    await updateRegistrationEmbed(t);
    return interaction.reply({ content:'Registered for the tournament.', ephemeral:true });
  }
  if (cmd === 'unregister') {
    const res = tryUnregisterUser(t, interaction.user);
    if (!res.ok) return interaction.reply({ content:`Unregister failed: ${res.reason}`, ephemeral:true });
    await updateRegistrationEmbed(t);
    return interaction.reply({ content:'You have been unregistered.', ephemeral:true });
  }

  // create_tournament
  if (cmd === 'create_tournament') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers can create tournaments', ephemeral:true });
    const name = interaction.options.getString('name');
    const bracket_channel = interaction.options.getString('bracket_channel') || '';
    const registration_channel = interaction.options.getString('registration_channel') || '';
    const battle_category = interaction.options.getString('battle_category') || '';
    const announce_channel = interaction.options.getString('announce_channel') || '';
    const vote_channel = interaction.options.getString('vote_channel') || '';
    const maxP = interaction.options.getInteger('max_participants') || 0;
    const id = `t_${Date.now()}`;
    storage.tournaments[id] = {
      id, name, status:'registration', participants:[], rounds:[], size:0, registrationMessageId:null, bracketMessageId:null,
      channels: { bracket: bracket_channel, registration: registration_channel, battleCategory: battle_category, announce: announce_channel, vote: vote_channel },
      maxParticipants: maxP, createdAt: Date.now()
    };
    saveStorage();
    return interaction.reply({ content:`Created tournament **${name}** (id: ${id}). Use /post_registration on it.`, ephemeral:true });
  }

  // post_registration (post for current tournament)
  if (cmd === 'post_registration') {
    const tour = storage.tournaments[TOURNAMENT_ID_SAFE()];
    try {
      await postRegistrationEmbed(tour);
      await updateRegistrationEmbed(tour);
      return interaction.reply({ content:'Registration posted.', ephemeral:true });
    } catch (e) {
      return interaction.reply({ content:`Failed: ${e.message}`, ephemeral:true });
    }
  }

  // open_registration
  if (cmd === 'open_registration') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const tour = storage.tournaments[TOURNAMENT_ID_SAFE()];
    tour.status = 'registration'; saveStorage();
    if (!tour.registrationMessageId) { try { await postRegistrationEmbed(tour); } catch(e){} }
    await updateRegistrationEmbed(tour);
    return interaction.reply({ content:`Registration opened for ${tour.name}`, ephemeral:true });
  }

  // close_registration -> build bracket & preassign prelims & assign fixtures for round 0 (prelims) or round 1
  if (cmd === 'close_registration') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const tour = storage.tournaments[TOURNAMENT_ID_SAFE()];
    if (tour.participants.length < 2) return interaction.reply({ content:'Not enough participants (min 2).', ephemeral:true });
    tour.status = 'running';
    buildBracketWithPrelims(tour);
    // announce prelims if they exist
    const hasPrelims = tour.rounds.length > 0 && tour.rounds[0].isPrelim;
    if (hasPrelims) {
      const preRound = tour.rounds[0];
      const announceChId = tour.channels.announce || config.announcementChannel || tour.channels.bracket || config.bracketChannel;
      try {
        const ach = await client.channels.fetch(announceChId);
        await ach.send({ content: `🟣 PRELIMS BEGIN!\nThere are ${preRound.matches.length} prelim matches. These matches decide which players will fill the final spots in the main bracket.` });
      } catch(e){ console.error('announce prelims fail', e); }
      // assign prelim matches to channels and announce
      try { await assignRoundToChannels(tour, 0); } catch(e){ console.error('assign prelims', e); }
    } else {
      // assign main round
      try { await assignRoundToChannels(tour, 0); } catch(e){ console.error('assign main', e); }
    }
    saveStorage();
    await updateBracketMessage(tour);
    return interaction.reply({ content:'Registration closed and bracket built.', ephemeral:false });
  }

  // set_channels
  if (cmd === 'set_channels') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
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
    return interaction.reply({ content:'Channels updated.', ephemeral:true });
  }

  // set_battle_channels
  if (cmd === 'set_battle_channels') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const csv = interaction.options.getString('channels') || '';
    config.battleChannels = csv.split(',').map(s=>s.trim()).filter(Boolean);
    saveConfig();
    return interaction.reply({ content:`Battle channels set.`, ephemeral:true });
  }

  // set_organizer_roles
  if (cmd === 'set_organizer_roles') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content:'Manage Server required', ephemeral:true });
    const csv = interaction.options.getString('roles') || '';
    config.organizerRoleIds = csv.split(',').map(s=>s.trim()).filter(Boolean);
    saveConfig();
    return interaction.reply({ content:'Organizer roles saved.', ephemeral:true });
  }

  // assign_fixtures (manual)
  if (cmd === 'assign_fixtures') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const tour = storage.tournaments[TOURNAMENT_ID_SAFE()];
    if (!tour.rounds || !tour.rounds.length) return interaction.reply({ content:'No bracket available', ephemeral:true });
    try { await assignRoundToChannels(tour, 0); saveStorage(); await updateBracketMessage(tour); return interaction.reply({ content:'Assigned fixtures for first round.', ephemeral:true }); } catch(e){ console.error(e); return interaction.reply({ content:'Failed to assign fixtures', ephemeral:true); }
  }

  // open_vote for a match
  if (cmd === 'open_vote') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const matchId = interaction.options.getString('match_id');
    const tour = storage.tournaments[TOURNAMENT_ID_SAFE()];
    const f = findMatchById(tour, matchId);
    if (!f) return interaction.reply({ content:'Match not found', ephemeral:true });
    try {
      await postVoteForMatch(tour, f.match);
      saveStorage();
      return interaction.reply({ content:'Vote opened.', ephemeral:true });
    } catch(e){ console.error(e); return interaction.reply({ content:`Failed to open vote: ${e.message}`, ephemeral:true); }
  }

  // end_match (organizer sets winner, triggers regen and bracket update)
  if (cmd === 'end_match') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const matchId = interaction.options.getString('match_id');
    const winner = interaction.options.getString('winner'); // p1 or p2
    const tour = storage.tournaments[TOURNAMENT_ID_SAFE()];
    const f = findMatchById(tour, matchId);
    if (!f) return interaction.reply({ content:'Match not found', ephemeral:true });
    const match = f.match;
    if (winner !== 'p1' && winner !== 'p2') return interaction.reply({ content:'Invalid winner (use p1 or p2)', ephemeral:true });
    match.winner = winner; match.status = 'finished';
    // announce winner
    const announceChId = tour.channels.announce || config.announcementChannel || tour.channels.bracket || config.bracketChannel;
    try {
      const ach = announceChId ? await client.channels.fetch(announceChId).catch(()=>null) : null;
      if (ach) await ach.send({ content: `Match ${match.id} finished. Winner: **${match[winner] ? match[winner].name : winner}**.` }).catch(()=>{});
    } catch(e){ console.error('announce fail', e); }
    regenerateNextRounds(tour);
    saveStorage();
    await updateBracketMessage(tour);
    return interaction.reply({ content:`Match ${matchId} marked finished. Bracket updated.`, ephemeral:true });
  }

  // force_update_bracket
  if (cmd === 'force_update_bracket') {
    const tour = storage.tournaments[TOURNAMENT_ID_SAFE()];
    await updateBracketMessage(tour);
    return interaction.reply({ content:'Bracket updated', ephemeral:true });
  }

  // show_bracket
  if (cmd === 'show_bracket') {
    const tour = storage.tournaments[TOURNAMENT_ID_SAFE()];
    try {
      const buf = await drawBracketImage(tour, config.image || {});
      const att = new AttachmentBuilder(buf, { name:'bracket.png' });
      return interaction.reply({ files:[att], ephemeral:false });
    } catch(e){ console.error(e); return interaction.reply({ content:'Failed to draw bracket', ephemeral:true); }
  }

});

// organizer check
function isOrganizer(interaction) {
  if (!interaction || !interaction.member) return false;
  if (interaction.member.permissions && interaction.member.permissions.has && interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  const roles = config.organizerRoleIds || [];
  for (const r of roles) if (interaction.member.roles.cache.has(r)) return true;
  return false;
}

// update bracket image in bracket channel
async function updateBracketMessage(tournament) {
  try {
    const buf = await drawBracketImage(tournament, config.image || {});
    const attachment = new AttachmentBuilder(buf, { name:'bracket.png' });
    const chId = tournament.channels.bracket || config.bracketChannel;
    if (!chId) return;
    const ch = await client.channels.fetch(chId).catch(()=>null);
    if (!ch) return;
    if (tournament.bracketMessageId) {
      try {
        const prev = await ch.messages.fetch(tournament.bracketMessageId);
        await prev.edit({ files:[attachment] });
      } catch(e) {
        const sent = await ch.send({ files:[attachment] });
        tournament.bracketMessageId = sent.id;
      }
    } else {
      const sent = await ch.send({ files:[attachment] });
      tournament.bracketMessageId = sent.id;
    }
    saveStorage();
  } catch (e) { console.error('updateBracketMessage error', e); }
}

// message reaction registration
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    const tour = Object.values(storage.tournaments).find(t => t.registrationMessageId === msg.id);
    if (!tour) return;
    if (reaction.emoji.name !== '✅') return;
    const res = tryRegisterUser(tour, user);
    await updateRegistrationEmbed(tour);
    if (!res.ok) try { await user.send(`Registration failed: ${res.reason}`); } catch(_) {}
  } catch(e){ console.error('reaction add', e); }
});
client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    const tour = Object.values(storage.tournaments).find(t => t.registrationMessageId === msg.id);
    if (!tour) return;
    if (reaction.emoji.name !== '✅') return;
    const res = tryUnregisterUser(tour, user);
    await updateRegistrationEmbed(tour);
    if (!res.ok) try { await user.send(`Unregister failed: ${res.reason}`); } catch(_) {}
  } catch(e){ console.error('reaction remove', e); }
});

// messageCreate: track battle channel posts (alternate posting), update deadlines, but DO NOT auto-end
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const tour = storage.tournaments[TOURNAMENT_ID_SAFE()];
  if (!tour || tour.status !== 'running') return;
  for (const round of tour.rounds || []) {
    for (const match of round.matches || []) {
      if (!match || !match.channelId) continue;
      if (match.channelId === message.channel.id) {
        const uid = message.author.id;
        if (!((match.p1 && match.p1.id === uid) || (match.p2 && match.p2.id === uid))) return;
        match.lastPoster = match.lastPoster || null;
        if (match.lastPoster === uid) {
          try { await message.reply({ content:'It is not your turn. Wait for opponent to reply.', ephemeral:true }); } catch(_) {}
          return;
        }
        match.lastPoster = uid;
        match.roundCount = (match.roundCount || 0) + 1;
        match.deadlineTs = Date.now() + (config.roundReplyTimeoutHours || 24) * 3600 * 1000;
        match.finished = false;
        saveStorage();
        // notify opponent
        const opponentId = (match.p1 && match.p1.id === uid) ? (match.p2 && match.p2.id) : (match.p1 && match.p1.id);
        try {
          const note = await message.channel.send(`Post received from ${message.author.username}. ${opponentId?`<@${opponentId}>`:''} you have ${config.roundReplyTimeoutHours || 24} hours to reply.`);
          setTimeout(()=>note.delete().catch(()=>{}), 12_000);
        } catch(_) {}
        // update bracket after each valid post to keep visuals fresh
        await updateBracketMessage(tour);
        return;
      }
    }
  }
});

// express keep alive
const app = express();
app.get('/', (req,res)=>res.send('Tourney bot alive'));
const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log(`Keep-alive on ${port}`));

// login
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // update bracket on startup if exists
  const tour = storage.tournaments[TOURNAMENT_ID_SAFE()];
  if (tour && tour.rounds && tour.rounds.length) await updateBracketMessage(tour);
});
client.login(process.env.BOT_TOKEN);

