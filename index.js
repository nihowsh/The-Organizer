// index.js
require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const { REST, Routes, Client, GatewayIntentBits, Partials, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const { drawBracketImage } = require('./bracketDrawer'); // keep your bracket generator

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STORAGE_PATH = path.join(__dirname, 'storage.json');

const config = fs.existsSync(CONFIG_PATH) ? fs.readJsonSync(CONFIG_PATH) : {};
// ensure defaults
config.battleChannels = config.battleChannels || [];
config.organizerRoleIds = config.organizerRoleIds || [];

const storage = fs.existsSync(STORAGE_PATH) ? fs.readJsonSync(STORAGE_PATH) : { tournaments: {} };

function saveConfig() { fs.writeJsonSync(CONFIG_PATH, config, { spaces: 2 }); }
function saveStorage() { fs.writeJsonSync(STORAGE_PATH, storage, { spaces: 2 }); }

// ---------- AUTO DEPLOY SLASH COMMANDS ----------
const commands = [
  { name: 'register', description: 'Register for the next tournament (legacy)' },
  { name: 'unregister', description: 'Unregister from the tournament (legacy)' },
  { name: 'start_tournament', description: 'Start the tournament (organizer only) (legacy)' },
  { name: 'show_bracket', description: 'Show bracket image' },
  { name: 'set_winner', description: 'Set winner for a match (organizer only)', options:[
      { name:'match_id', description:'Match ID', type:3, required:true},
      { name:'winner', description:'p1 or p2', type:3, required:true}
    ]},
  { name: 'create_tournament', description: 'Create a new tournament (organizer only)', options:[
      { name:'name', description:'Tournament name', type:3, required:true},
      { name:'bracket_channel', description:'Bracket channel ID', type:3, required:false},
      { name:'registration_channel', description:'Registration channel ID', type:3, required:false},
      { name:'battle_category', description:'Category ID for battles', type:3, required:false},
      { name:'announce_channel', description:'Announcement channel ID', type:3, required:false},
      { name:'vote_channel', description:'Vote channel ID', type:3, required:false},
      { name:'max_participants', description:'max participants (0=unlimited)', type:4, required:false}
    ]},
  { name: 'post_registration', description: 'Post registration embed (reaction-based)' },
  { name: 'open_registration', description: 'Open registration for current tournament', options:[
      { name:'tournament', description:'id or "current"', type:3, required:false }
    ]},
  { name: 'close_registration', description: 'Close registration and build bracket (organizer only)' },
  { name: 'set_channels', description: 'Set default channels (organizer only)', options:[
      { name:'bracket_channel', description:'Bracket channel ID', type:3, required:false},
      { name:'registration_channel', description:'Registration channel ID', type:3, required:false},
      { name:'battle_category', description:'Battle category ID', type:3, required:false},
      { name:'announce_channel', description:'Announce channel ID', type:3, required:false},
      { name:'vote_channel', description:'Vote channel ID', type:3, required:false}
    ]},
  { name: 'set_battle_channels', description: 'Set list of battle channels (comma separated IDs)', options:[
      { name:'channels', description:'Comma separated channel IDs', type:3, required:true}
    ]},
  { name: 'set_organizer_roles', description: 'Set organizer role IDs (comma separated)', options:[
      { name:'roles', description:'Comma separated role IDs', type:3, required:true}
    ]},
  { name: 'assign_fixtures', description: 'Assign round matches to battle channels and announce (organizer only)' },
  { name: 'end_match', description: 'End a match and set winner (organizer only)', options:[
      { name:'match_id', description:'Match ID', type:3, required:true},
      { name:'winner', description:'p1 or p2', type:3, required:true}
    ]},
  { name: 'open_vote', description: 'Open vote for a match (organizer only)', options:[
      { name:'match_id', description:'Match ID', type:3, required:true}
    ]},
  { name: 'force_update_bracket', description: 'Force update bracket image' }
];

async function autoDeployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    console.log('Auto-deploying slash commands...');
    if (process.env.GUILD_ID && process.env.CLIENT_ID) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
      console.log('✓ Guild commands deployed.');
    } else if (process.env.CLIENT_ID) {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('✓ Global commands deployed.');
    } else console.warn('CLIENT_ID missing - cannot deploy commands.');
  } catch (err) {
    console.error('Failed to deploy commands', err);
  }
}
autoDeployCommands();
// ---------- end deploy ----------

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions], partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User] });

const timers = new Map();
const TOURNEY_ID = 'current';

// ensure a current tournament container exists
if (!storage.tournaments[TOURNEY_ID]) {
  storage.tournaments[TOURNEY_ID] = {
    id: TOURNEY_ID,
    name: 'Wordsmith of the Month',
    status: 'registration',
    participants: [],
    rounds: [],
    size: 0,
    registrationMessageId: null,
    bracketMessageId: null,
    channels: {
      bracket: config.bracketChannel || '',
      registration: config.registrationChannel || '',
      battleCategory: config.battleCategory || '',
      announce: config.announcementChannel || '',
      vote: config.voteChannel || ''
    },
    maxParticipants: 0,
    createdAt: Date.now()
  };
  saveStorage();
}

// util
function nextPowerOfTwo(n){ let p=1; while(p<n) p<<=1; return p; }

// buildInitialBracket and regenerateNextRounds kept same as your old logic
function buildInitialBracket(tournament) {
  const parts = tournament.participants.slice();
  const N = parts.length;
  const P = nextPowerOfTwo(N);
  const byes = P - N;
  const byePlayers = parts.slice(0, byes);
  const playPlayers = parts.slice(byes);
  const ordered = [...byePlayers, ...playPlayers];
  const slots = [];
  for (let i=0;i<P;i++) slots.push(ordered[i] || null);
  const firstRound = [];
  for (let i=0;i<P;i+=2) {
    const p1 = slots[i] ? { id: slots[i].id, name: slots[i].name } : null;
    const p2 = slots[i+1] ? { id: slots[i+1].id, name: slots[i+1].name } : null;
    firstRound.push({ id: `R1M${i/2+1}`, p1, p2, winner: null, status: 'pending' });
  }
  const rounds = [firstRound];
  let prevCount = firstRound.length;
  while(prevCount>1){
    const nextCount = Math.ceil(prevCount/2);
    rounds.push(new Array(nextCount).fill(null).map((_,idx)=>({ id:`R${rounds.length+1}M${idx+1}`, p1:null, p2:null, winner:null, status:'locked' })));
    prevCount = nextCount;
  }
  tournament.rounds = rounds;
  tournament.size = P;
}

function regenerateNextRounds(tournament) {
  const rounds = tournament.rounds;
  for (let r=0;r<rounds.length-1;r++){
    const curr = rounds[r];
    const next = rounds[r+1];
    let idx=0;
    for (let i=0;i<curr.length;i+=2){
      const m1 = curr[i];
      const m2 = curr[i+1];
      const winner1 = m1 && m1.winner ? (m1.winner==='p1'?m1.p1:m1.p2) : null;
      const winner2 = m2 && m2.winner ? (m2.winner==='p1'?m2.p1:m2.p2) : null;
      next[idx].p1 = winner1;
      next[idx].p2 = winner2;
      next[idx].status = (next[idx].p1 || next[idx].p2) ? 'pending' : 'locked';
      idx++;
    }
  }
}

// registration helpers (reaction-based)
async function postRegistrationEmbed(tournament) {
  const chanId = tournament.channels.registration || config.registrationChannel || config.bracketChannel;
  if (!chanId) throw new Error('No registration channel set');
  const ch = await client.channels.fetch(chanId);
  if (!ch) throw new Error('Registration channel not found');
  const embed = {
    title: `${tournament.name} — Registration`,
    description: `React with ✅ to register.\nFirst-come-first-serve byes. Max: ${tournament.maxParticipants || 'Unlimited'}`,
    fields: [{ name: `Participants (${tournament.participants.length})`, value: tournament.participants.map((p,i)=>`${i+1}. ${p.name}`).join('\n') || 'No participants yet' }],
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
    const ch = await client.channels.fetch(tournament.channels.registration || config.registrationChannel || config.bracketChannel);
    const msg = await ch.messages.fetch(tournament.registrationMessageId);
    const names = tournament.participants.map((p,i)=>`${i+1}. ${p.name}`).join('\n') || 'No participants yet';
    const embed = msg.embeds[0] ? msg.embeds[0].toJSON() : { title: `${tournament.name} — Registration`, description: `React with ✅ to register.` };
    embed.fields = [{ name: `Participants (${tournament.participants.length})`, value: names }];
    await msg.edit({ embeds: [embed] });
  } catch(e) { console.error('updateRegistrationEmbed error', e); }
}

function tryRegisterUser(tournament, user) {
  if (tournament.status!=='registration') return { ok:false, reason:'Registration closed' };
  if (tournament.maxParticipants && tournament.participants.length>=tournament.maxParticipants) return { ok:false, reason:'Tournament full' };
  if (tournament.participants.find(p=>p.id===user.id)) return { ok:false, reason:'Already registered' };
  tournament.participants.push({ id: user.id, name: user.username || user.tag || 'unknown', joinedAt: Date.now() });
  saveStorage();
  return { ok:true };
}
function tryUnregisterUser(tournament, user) {
  const idx = tournament.participants.findIndex(p=>p.id===user.id);
  if (idx===-1) return { ok:false, reason:'Not registered' };
  tournament.participants.splice(idx,1);
  saveStorage();
  return { ok:true };
}

// assign matches of a round to battle channels and announce
async function assignRoundToChannels(tournament, roundIndex = 0) {
  const channels = config.battleChannels || tournament.channels.battleChannels || [];
  if (!channels || channels.length===0) throw new Error('No battle channels configured');
  const round = tournament.rounds[roundIndex];
  const announceChanId = tournament.channels.announce || config.announcementChannel || tournament.channels.bracket || config.bracketChannel;
  const announceCh = await client.channels.fetch(announceChanId).catch(()=>null);
  let chanIdx = 0;
  for (const match of round) {
    if (!match) continue;
    // assign channel id if not assigned already
    if (!match.channelId) {
      const chId = channels[chanIdx % channels.length];
      match.channelId = chId;
      chanIdx++;
    }
    // post announcement per match
    try {
      if (announceCh) {
        const p1name = match.p1?match.p1.name:'TBD';
        const p2name = match.p2?match.p2.name:'TBD';
        await announceCh.send(`Match ${match.id}: **${p1name}** vs **${p2name}** — Battle will take place in <#${match.channelId}>. <@${match.p1?match.p1.id:''}> <@${match.p2?match.p2.id:''}>`);
      }
    } catch(e){ console.error('announce fail', e); }
  }
  saveStorage();
  await updateBracketMessage(tournament);
}

// createBattleChannelForMatch: will only create channel if you gave category but we also support pre-configured "battleChannels" so we won't always create
async function createBattleChannelForMatch(guild, match) {
  // If config.battleChannels includes explicit channels, we don't create new channels
  if (config.battleChannels && config.battleChannels.length>0) {
    // simply return a fake "channel" object reference by channel id
    const chId = match.channelId || config.battleChannels[0];
    return { id: chId, send: async (m)=> { const ch = await client.channels.fetch(chId); return ch.send(m); } };
  }
  const categoryId = config.battleCategory || (match.tournament && match.tournament.channels && match.tournament.channels.battleCategory) || null;
  const channelName = `battle-${match.id.toLowerCase()}`.replace(/[^a-z0-9-]/g,'-').slice(0,90);
  try {
    const ch = await guild.channels.create({ name: channelName, type: 0, parent: categoryId || null });
    await ch.send(`Match ${match.id} — ${match.p1?match.p1.name:'TBD'} vs ${match.p2?match.p2.name:'TBD'}\nOrganizer will start/end match only.`);
    return ch;
  } catch (e) {
    console.error('createBattleChannelForMatch error', e);
    return null;
  }
}

// voting helper: posts voting message to configured vote channel or match channel
async function postVoteForMatch(tournament, match) {
  const voteChanId = tournament.channels.vote || config.voteChannel || match.channelId;
  if (!voteChanId) throw new Error('No vote channel defined');
  const ch = await client.channels.fetch(voteChanId);
  const p1label = match.p1?match.p1.name:'Player 1';
  const p2label = match.p2?match.p2.name:'Player 2';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote_${match.id}_p1`).setLabel(p1label).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vote_${match.id}_p2`).setLabel(p2label).setStyle(ButtonStyle.Danger)
  );
  const m = await ch.send({ content: `Vote for winner of ${match.id}: ${p1label} vs ${p2label}`, components: [row] });
  // collector (optional) - we will allow button handler to tally saved votes; collector used earlier for temporary
  // Here, we just post and let button interactions record votes in match.votes
  return m;
}

// find match by id
function findMatchById(tournament, matchId) {
  for (const rnd of tournament.rounds) {
    for (const m of rnd) {
      if (m && m.id === matchId) return { match: m, round: rnd };
    }
  }
  return null;
}

// reaction based registration
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    const tour = Object.values(storage.tournaments).find(t=>t.registrationMessageId === msg.id);
    if (!tour) return;
    if (reaction.emoji.name !== '✅') return;
    const res = tryRegisterUser(tour, user);
    await updateRegistrationEmbed(tour);
    if (!res.ok) {
      try { await user.send(`Registration failed: ${res.reason}`); } catch {}
    }
  } catch(e){ console.error('reaction add', e); }
});
client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    const tour = Object.values(storage.tournaments).find(t=>t.registrationMessageId === msg.id);
    if (!tour) return;
    if (reaction.emoji.name !== '✅') return;
    const res = tryUnregisterUser(tour, user);
    await updateRegistrationEmbed(tour);
    if (!res.ok) {
      try { await user.send(`Unregister failed: ${res.reason}`); } catch {}
    }
  } catch(e){ console.error('reaction remove', e); }
});

// handle button votes
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (!id.startsWith('vote_')) return;
    const [, matchId, choice] = id.split('_'); // vote_R1M1_p1
    const t = storage.tournaments[TOURNEY_ID];
    const found = findMatchById(t, matchId);
    if (!found) {
      await interaction.reply({ content: 'Match not found', ephemeral: true });
      return;
    }
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

  if (!interaction.isChatInputCommand()) return;

  const t = storage.tournaments[TOURNEY_ID];

  // LEGACY quick register/unregister
  if (interaction.commandName === 'register') {
    if (t.status !== 'registration') return interaction.reply({ content:'Registration is closed.', ephemeral:true });
    if (t.participants.find(p=>p.id===interaction.user.id)) return interaction.reply({ content:'Already registered', ephemeral:true });
    t.participants.push({ id: interaction.user.id, name: interaction.member.displayName || interaction.user.username, joinedAt: Date.now()});
    saveStorage();
    await interaction.reply({ content:'Registered', ephemeral:true});
    await updateRegistrationEmbed(t);
    return;
  }
  if (interaction.commandName === 'unregister') {
    if (t.status !== 'registration') return interaction.reply({ content:'Cannot unregister now', ephemeral:true});
    const idx = t.participants.findIndex(p=>p.id===interaction.user.id);
    if (idx===-1) return interaction.reply({ content:'You are not registered', ephemeral:true});
    t.participants.splice(idx,1); saveStorage(); await updateRegistrationEmbed(t);
    return interaction.reply({ content:'Unregistered', ephemeral:true});
  }

  // create_tournament
  if (interaction.commandName === 'create_tournament') {
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

  // post_registration
  if (interaction.commandName === 'post_registration') {
    const tour = storage.tournaments['current'] || Object.values(storage.tournaments).slice(-1)[0];
    if (!tour) return interaction.reply({ content:'No tournament found', ephemeral:true});
    try {
      const msg = await postRegistrationEmbed(tour);
      await updateRegistrationEmbed(tour);
      return interaction.reply({ content:`Posted registration in <#${tour.channels.registration || config.registrationChannel || config.bracketChannel}>`, ephemeral:true});
    } catch (e) {
      return interaction.reply({ content:`Failed to post registration: ${e.message}`, ephemeral:true});
    }
  }

  // open_registration (alias)
  if (interaction.commandName === 'open_registration') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const tour = storage.tournaments['current'] || Object.values(storage.tournaments).slice(-1)[0];
    if (!tour) return interaction.reply({ content:'No tournament found', ephemeral:true});
    tour.status = 'registration'; saveStorage();
    if (!tour.registrationMessageId) { try { await postRegistrationEmbed(tour); } catch(e){ console.error(e); } }
    await updateRegistrationEmbed(tour);
    return interaction.reply({ content:`Registration opened for ${tour.name}`, ephemeral:true });
  }

  // close_registration -> build bracket + assign channels (organizer)
  if (interaction.commandName === 'close_registration') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const tour = storage.tournaments['current'] || Object.values(storage.tournaments).slice(-1)[0];
    if (!tour) return interaction.reply({ content:'No tournament found', ephemeral:true });
    if (tour.participants.length < 2) return interaction.reply({ content:'Not enough participants (min 2).', ephemeral:true });
    tour.status = 'running';
    buildInitialBracket(tour);
    regenerateNextRounds(tour);
    // assign matches to battle channels (based on config.battleChannels)
    try { await assignRoundToChannels(tour, 0); } catch(e){ console.error('assignRoundToChannels error', e); }
    saveStorage();
    await updateBracketMessage(tour);
    return interaction.reply({ content:`Registration closed. Bracket built and matches assigned.`, ephemeral:false });
  }

  // set_channels (update config)
  if (interaction.commandName === 'set_channels') {
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

  // set_battle_channels (comma separated)
  if (interaction.commandName === 'set_battle_channels') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const csv = interaction.options.getString('channels');
    config.battleChannels = csv.split(',').map(s=>s.trim()).filter(Boolean);
    saveConfig();
    return interaction.reply({ content:`Battle channels set: ${config.battleChannels.join(', ')}`, ephemeral:true });
  }

  // set_organizer_roles
  if (interaction.commandName === 'set_organizer_roles') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content:'Manage Server required', ephemeral:true });
    const csv = interaction.options.getString('roles');
    config.organizerRoleIds = csv.split(',').map(s=>s.trim()).filter(Boolean);
    saveConfig();
    return interaction.reply({ content:`Organizer roles set.`, ephemeral:true });
  }

  // assign_fixtures manual
  if (interaction.commandName === 'assign_fixtures') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const tour = storage.tournaments['current'] || Object.values(storage.tournaments).slice(-1)[0];
    if (!tour || !tour.rounds || !tour.rounds.length) return interaction.reply({ content:'No bracket available.', ephemeral:true });
    try { await assignRoundToChannels(tour, 0); saveStorage(); await updateBracketMessage(tour); return interaction.reply({ content:'Assignments done.', ephemeral:true }); } catch(e){ console.error(e); return interaction.reply({ content:'Failed to assign', ephemeral:true }); }
  }

  // end_match - organizer only
  if (interaction.commandName === 'end_match') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const matchId = interaction.options.getString('match_id');
    const winner = interaction.options.getString('winner');
    const tour = storage.tournaments['current'] || Object.values(storage.tournaments).slice(-1)[0];
    const found = findMatchById(tour, matchId);
    if (!found) return interaction.reply({ content:'Match not found', ephemeral:true });
    const match = found.match;
    if (winner !== 'p1' && winner !== 'p2') return interaction.reply({ content:'Invalid winner. Use p1 or p2', ephemeral:true });
    match.winner = winner; match.status = 'finished';
    regenerateNextRounds(tour); saveStorage(); await updateBracketMessage(tour);
    // announce
    const announceChId = tour.channels.announce || config.announcementChannel || tour.channels.bracket || config.bracketChannel;
    try {
      const ach = await client.channels.fetch(announceChId);
      await ach.send(`Match ${match.id} finished. Winner: **${match[winner] ? match[winner].name : winner}**. Next matches will be updated in bracket.`);
    } catch(e){ console.error('announce fail', e); }
    return interaction.reply({ content:`Match ${matchId} set to ${winner}`, ephemeral:true });
  }

  // open_vote - organizer triggers vote posting for match
  if (interaction.commandName === 'open_vote') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const matchId = interaction.options.getString('match_id');
    const tour = storage.tournaments['current'] || Object.values(storage.tournaments).slice(-1)[0];
    const found = findMatchById(tour, matchId);
    if (!found) return interaction.reply({ content:'Match not found', ephemeral:true });
    const match = found.match;
    try {
      const vm = await postVoteForMatch(tour, match);
      match.votingMessageId = vm.id;
      match.status = 'voting';
      saveStorage();
      return interaction.reply({ content:`Vote opened in <#${(tour.channels.vote||config.voteChannel||match.channelId)}>`, ephemeral:true });
    } catch(e){ console.error(e); return interaction.reply({ content:`Failed to open vote: ${e.message}`, ephemeral:true}); }
  }

  // force_update_bracket
  if (interaction.commandName === 'force_update_bracket') {
    const tour = storage.tournaments['current'] || Object.values(storage.tournaments).slice(-1)[0];
    if (!tour) return interaction.reply({ content:'No tournament found', ephemeral:true });
    await updateBracketMessage(tour);
    return interaction.reply({ content:'Bracket updated', ephemeral:true });
  }

  // legacy set_winner
  if (interaction.commandName === 'set_winner') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const matchId = interaction.options.getString('match_id');
    const winner = interaction.options.getString('winner');
    const found = findMatchById(storage.tournaments[TOURNEY_ID], matchId);
    if (!found) return interaction.reply({ content:'Match not found', ephemeral:true });
    const match = found.match;
    match.winner = winner; match.status = 'finished';
    regenerateNextRounds(storage.tournaments[TOURNEY_ID]); saveStorage(); await updateBracketMessage(storage.tournaments[TOURNEY_ID]);
    return interaction.reply({ content:`Winner set`, ephemeral:true });
  }

  // start_tournament (legacy)
  if (interaction.commandName === 'start_tournament') {
    if (!isOrganizer(interaction)) return interaction.reply({ content:'Only organizers', ephemeral:true });
    const t = storage.tournaments[TOURNEY_ID];
    if (t.status !== 'registration') return interaction.reply({ content:'Already started', ephemeral:true });
    if (t.participants.length < 2) return interaction.reply({ content:'Not enough participants', ephemeral:true });
    t.status = 'running'; buildInitialBracket(t); regenerateNextRounds(t); saveStorage();
    // auto assign to battle channels if configured
    try { await assignRoundToChannels(t, 0); } catch(e){console.error(e);}
    await updateBracketMessage(t);
    return interaction.reply({ content:`Tournament started with ${t.participants.length} players`, ephemeral:false });
  }

  // show_bracket
  if (interaction.commandName === 'show_bracket') {
    const t0 = storage.tournaments[TOURNEY_ID];
    if (!t0) return interaction.reply({ content:'No tournament found', ephemeral:true });
    try {
      const buf = await drawBracketImage(t0, config.image || {});
      const att = new AttachmentBuilder(buf, { name: 'bracket.png' });
      return interaction.reply({ files: [att], ephemeral:false });
    } catch(e){ console.error(e); return interaction.reply({ content:'Failed to draw bracket', ephemeral:true }); }
  }
});

// helper: check if an interaction user is an organizer
function isOrganizer(interaction) {
  if (!interaction || !interaction.member) return false;
  // ManageGuild always allowed
  if (interaction.member.permissions && interaction.member.permissions.has && interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  // check configured roles
  const roles = config.organizerRoleIds || [];
  for (const rid of roles) if (interaction.member.roles.cache.has(rid)) return true;
  return false;
}

// updateBracketMessage uses tournament-specific bracket channel
async function updateBracketMessage(tournament) {
  try {
    const buf = await drawBracketImage(tournament, config.image || {});
    const attachment = new AttachmentBuilder(buf, { name:'bracket.png' });
    const chId = tournament.channels.bracket || config.bracketChannel;
    if (!chId) return;
    const channel = await client.channels.fetch(chId);
    if (!channel) return;
    if (tournament.bracketMessageId) {
      try {
        const prev = await channel.messages.fetch(tournament.bracketMessageId);
        await prev.edit({ files: [attachment] });
      } catch (e) {
        const sent = await channel.send({ files: [attachment] });
        tournament.bracketMessageId = sent.id;
      }
    } else {
      const sent = await channel.send({ files: [attachment] });
      tournament.bracketMessageId = sent.id;
    }
    saveStorage();
  } catch (e) { console.error('updateBracketMessage error', e); }
}

// on ready: restore timers (if any) and refresh bracket message
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // optionally update bracket on boot
  const t = storage.tournaments[TOURNEY_ID];
  if (t && t.rounds && t.rounds.length) {
    await updateBracketMessage(t);
  }
});

// messageCreate listener for battle channel messages
client.on('messageCreate', async (message) => {
  if (!message.guild) return;
  const t = storage.tournaments[TOURNEY_ID];
  if (!t || t.status !== 'running') return;
  // check if message is in a battle channel of any match
  for (const round of t.rounds) {
    for (const match of round) {
      if (!match || !match.channelId) continue;
      if (match.channelId === message.channel.id) {
        // only allow participants to post (others ignored)
        const uid = message.author.id;
        if (!((match.p1 && match.p1.id===uid) || (match.p2 && match.p2.id===uid))) return;
        // alternate posting enforced
        match.lastPoster = match.lastPoster || null;
        if (match.lastPoster === uid) {
          try { await message.reply({ content: 'It is not your turn. Wait for your opponent to reply.', ephemeral: true }); } catch {}
          return;
        }
        match.lastPoster = uid;
        match.roundCount = (match.roundCount || 0) + 1;
        match.deadlineTs = Date.now() + (config.roundReplyTimeoutHours || 24) * 60 * 60 * 1000;
        match.finished = false;
        saveStorage();
        // notify
        const opponentId = (match.p1 && match.p1.id === uid) ? (match.p2 && match.p2.id) : (match.p1 && match.p1.id);
        try {
          const ch = await message.channel.send(`Post received from ${message.author.username}. ${opponentId ? `<@${opponentId}>` : ''} you have ${config.roundReplyTimeoutHours || 24} hours to reply.`);
          setTimeout(()=>ch.delete().catch(()=>{}), 15*1000);
        } catch(e){}
        // IMPORTANT: Do NOT auto-end after 3 rounds. Only organizers end match using /end_match or /open_vote.
        return;
      }
    }
  }
});

// keep-alive express
const app = express();
app.get('/', (req,res)=>res.send('Tourney bot alive'));
const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log(`Keep-alive on ${port}`));

client.login(process.env.BOT_TOKEN);

