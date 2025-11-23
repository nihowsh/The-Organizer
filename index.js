// index.js - The Organizer (multi-tournament, persistent)
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

const { drawBracketImage } = require('./bracketDrawer'); // you already have this

// ---------- CONFIG / STORAGE ----------
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STORAGE_PATH = path.join(__dirname, 'storage.json');

const defaultConfig = {
  bracketChannel: "",
  registrationChannel: "",
  battleCategory: "",
  announcementChannel: "",
  voteChannel: "",
  battleChannels: [], // explicit text channels to use in round-robin
  organizerRoleIds: [],
  roundReplyTimeoutHours: 24,
  voteDurationMinutes: 60,
  image: { width: 1400, height: 900, bgColor: "#2a0710", textColor: "#fff", prelimColor: "#8844ff" }
};

let config = fs.existsSync(CONFIG_PATH) ? fs.readJsonSync(CONFIG_PATH) : defaultConfig;
config = Object.assign({}, defaultConfig, config);

let storage = fs.existsSync(STORAGE_PATH) ? fs.readJsonSync(STORAGE_PATH) : { tournaments: {}, meta: { currentTournament: null } };

function saveConfig() { fs.writeJsonSync(CONFIG_PATH, config, { spaces: 2 }); }
function saveStorage() { fs.writeJsonSync(STORAGE_PATH, storage, { spaces: 2 }); }

// ---------- UTILS ----------
function nextPowerOfTwo(n) { let p = 1; while (p < n) p <<= 1; return p; }

function genTournamentId() { return `t_${Date.now().toString(36)}_${Math.floor(Math.random()*1000)}`; }

function isOrganizerMember(member) {
  if (!member) return false;
  if (member.permissions && member.permissions.has && member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  const roles = config.organizerRoleIds || [];
  for (const r of roles) if (member.roles && member.roles.cache && member.roles.cache.has(r)) return true;
  return false;
}

// ---------- BRACKET BUILDING ----------
function buildInitialBracket(tour) {
  // participants: array of { id, name, joinedAt }
  const parts = (tour.participants || []).slice();
  const N = parts.length;
  const P = nextPowerOfTwo(Math.max(2, N)); // minimum bracket of 2
  const byes = P - N;

  // BYEs considered earliest registrants (first-come-first-serve)
  const byePlayers = parts.slice(0, byes);
  const playPlayers = parts.slice(byes);
  const ordered = [...byePlayers, ...playPlayers];

  // create slots
  const slots = [];
  for (let i = 0; i < P; i++) slots.push(ordered[i] || null);

  // first round matches
  const firstRound = [];
  for (let i = 0; i < P; i += 2) {
    const p1 = slots[i] ? { id: slots[i].id, name: slots[i].name } : null;
    const p2 = slots[i + 1] ? { id: slots[i + 1].id, name: slots[i + 1].name } : null;
    const match = { id: `R1M${i/2+1}`, p1, p2, winner: null, status: 'pending', roundIndex: 0, channelId: null, votes: {}, roundCount: 0, lastPoster: null };
    // auto resolve BYE matches where other side missing
    if (p1 && !p2) { match.winner = 'p1'; match.status = 'finished'; }
    if (!p1 && p2) { match.winner = 'p2'; match.status = 'finished'; }
    firstRound.push(match);
  }

  // subsequent rounds
  const rounds = [ { isPrelim: false, matches: firstRound } ];
  let prevCount = firstRound.length;
  while (prevCount > 1) {
    const nextCount = Math.ceil(prevCount / 2);
    const arr = [];
    for (let i = 0; i < nextCount; i++) {
      arr.push({ id: `R${rounds.length+1}M${i+1}`, p1: null, p2: null, winner: null, status: 'locked', roundIndex: rounds.length, channelId: null, votes: {}, roundCount: 0, lastPoster: null });
    }
    rounds.push({ isPrelim: false, matches: arr });
    prevCount = nextCount;
  }

  // If participants were not full power of two, optionally create PRELIMS as optional concept:
  // We'll store a prelim flag when needed later; actual prelims are just round 0 if implemented.
  tour.rounds = rounds;
  tour.size = P;
}

// regenerate next rounds based on winners in current rounds
function regenerateNextRounds(tour) {
  const rounds = tour.rounds || [];
  for (let r = 0; r < rounds.length - 1; r++) {
    const curr = rounds[r].matches;
    const next = rounds[r + 1].matches;
    let idx = 0;
    for (let i = 0; i < curr.length; i += 2) {
      const m1 = curr[i];
      const m2 = curr[i + 1];
      const winner1 = m1 && m1.winner ? (m1.winner === 'p1' ? m1.p1 : m1.p2) : null;
      const winner2 = m2 && m2.winner ? (m2.winner === 'p1' ? m2.p1 : m2.p2) : null;
      next[idx].p1 = winner1;
      next[idx].p2 = winner2;
      next[idx].status = (next[idx].p1 || next[idx].p2) ? 'pending' : 'locked';
      idx++;
    }
  }
}

// ---------- CHANNEL & FIXTURE ASSIGN ----------
async function assignRoundToChannels(tour, roundIndex = 0, client) {
  const round = tour.rounds && tour.rounds[roundIndex] ? tour.rounds[roundIndex].matches : null;
  if (!round) throw new Error('Round not found');

  const explicit = config.battleChannels && config.battleChannels.length > 0 ? config.battleChannels : (tour.channels && tour.channels.battleChannels ? tour.channels.battleChannels : []);
  const categoryId = tour.channels && tour.channels.battleCategory ? tour.channels.battleCategory : config.battleCategory || null;

  // If explicit channels configured, use them round-robin.
  // Else if category provided, create channels per match.
  let chanIdx = 0;
  const announcements = [];
  for (const match of round) {
    if (!match) continue;
    if (!match.p1 && !match.p2) { match.channelId = null; continue; }

    if (!match.channelId) {
      if (explicit && explicit.length > 0) {
        match.channelId = explicit[chanIdx % explicit.length];
        chanIdx++;
      } else if (categoryId && client) {
        // create a channel name safe
        try {
          const guild = client.guilds.cache.first(); // ASSUMPTION: bot runs in a single-guild context; if multi, tournament should store guildId
          if (guild) {
            const name = `battle-${match.id.toLowerCase()}`.replace(/[^a-z0-9-]/g, '-').slice(0, 90);
            const created = await guild.channels.create({ name, type: 0, parent: categoryId || null });
            match.channelId = created.id;
          }
        } catch (e) {
          console.error('create channel fail', e);
        }
      } else {
        // fallback to bracket channel
        match.channelId = tour.channels && tour.channels.bracket ? tour.channels.bracket : config.bracketChannel || null;
      }
    }

    // prepare announce message
    const p1n = match.p1 ? match.p1.name : 'TBD';
    const p2n = match.p2 ? match.p2.name : 'TBD';
    announcements.push({ matchId: match.id, p1: match.p1, p2: match.p2, channelId: match.channelId, text: `Match ${match.id}: **${p1n}** vs **${p2n}** — Battle will take place in <#${match.channelId}>.` });
  }

  // post announcements in announce channel (if set)
  const announceId = tour.channels && tour.channels.announce ? tour.channels.announce : config.announcementChannel || tour.channels.bracket || config.bracketChannel;
  if (announceId) {
    try {
      const ch = await client.channels.fetch(announceId);
      if (ch) {
        for (const a of announcements) {
          const mention = `${a.p1 ? `<@${a.p1.id}>` : ''} ${a.p2 ? `<@${a.p2.id}>` : ''}`;
          await ch.send(`${a.text} ${mention}`);
        }
      }
    } catch (e) {
      console.error('announce channel post failed', e);
    }
  }
}

// ---------- REGISTRATION EMBED / REACTIONS ----------
async function postRegistrationEmbed(tour, client) {
  const chanId = tour.channels && tour.channels.registration ? tour.channels.registration : config.registrationChannel || config.bracketChannel || null;
  if (!chanId) throw new Error('No registration channel set for tournament');
  const ch = await client.channels.fetch(chanId);
  if (!ch) throw new Error('Registration channel not found');

  const names = tour.participants && tour.participants.length ? tour.participants.map((p, i) => `${i+1}. ${p.name}`).join('\n') : 'No participants yet';

  const embed = {
    title: `${tour.name} — Registration`,
    description: `React with ✅ to register.\nFirst-come-first-serve byes. Max: ${tour.maxParticipants || 'Unlimited'}`,
    fields: [{ name: `Participants (${tour.participants.length})`, value: names }],
    timestamp: new Date()
  };

  const msg = await ch.send({ embeds: [embed] });
  await msg.react('✅');

  tour.registrationMessageId = msg.id;
  saveStorage();
  return msg;
}

async function updateRegistrationEmbed(tour, client) {
  if (!tour.registrationMessageId) return;
  const chanId = tour.channels && tour.channels.registration ? tour.channels.registration : config.registrationChannel || config.bracketChannel || null;
  if (!chanId) return;
  try {
    const ch = await client.channels.fetch(chanId);
    const msg = await ch.messages.fetch(tour.registrationMessageId);
    const names = tour.participants && tour.participants.length ? tour.participants.map((p, i) => `${i+1}. ${p.name}`).join('\n') : 'No participants yet';
    const embed = msg.embeds[0] ? msg.embeds[0].toJSON() : { title: `${tour.name} — Registration`, description: `React with ✅ to register.` };
    embed.fields = [{ name: `Participants (${tour.participants.length})`, value: names }];
    await msg.edit({ embeds: [embed] });
  } catch (e) {
    console.error('updateRegistrationEmbed failed', e);
  }
}

// ---------- VOTING ----------
async function postVoteForMatch(tour, match, client) {
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

  // collector to auto-tally after configured minutes
  const durationMs = (tour.voteDurationMinutes || config.voteDurationMinutes || 60) * 60 * 1000;
  const collector = msg.createMessageComponentCollector({ componentType: 2, time: durationMs });

  const votes = new Map();
  collector.on('collect', async (i) => {
    if (!votes.has(i.user.id)) votes.set(i.user.id, null); // placeholder to prevent double-vote
    const parts = i.customId.split('_');
    const choice = parts[2]; // p1/p2
    votes.set(i.user.id, choice);
    await i.reply({ content: `Vote recorded for ${choice}`, ephemeral: true });
  });

  collector.on('end', async () => {
    const tally = { p1: 0, p2: 0 };
    for (const v of votes.values()) {
      if (v === 'p1') tally.p1++;
      if (v === 'p2') tally.p2++;
    }
    let winnerKey = null;
    if (tally.p1 > tally.p2) winnerKey = 'p1';
    else if (tally.p2 > tally.p1) winnerKey = 'p2';
    else winnerKey = 'p1'; // default tiebreaker to p1

    match.votes = Object.fromEntries(votes);
    match.winner = winnerKey;
    match.status = 'finished';
    saveStorage();
    regenerateNextRounds(tour);
    await updateBracketMessage(tour, client);
    // announce
    try {
      const announceId = tour.channels && tour.channels.announce ? tour.channels.announce : config.announcementChannel || tour.channels.bracket || config.bracketChannel;
      if (announceId) {
        const ach = await client.channels.fetch(announceId);
        await ach.send(`Voting ended for ${match.id}. Results: p1=${tally.p1}, p2=${tally.p2}. Winner: **${match[winnerKey] ? match[winnerKey].name : winnerKey}**`);
      }
    } catch (e) { console.error('announce after vote fail', e); }
  });

  return msg;
}

// ---------- FIND MATCH ----------
function findMatchById(tour, matchId) {
  if (!tour || !tour.rounds) return null;
  for (let r = 0; r < tour.rounds.length; r++) {
    const rnd = tour.rounds[r].matches;
    for (const m of rnd) {
      if (m && m.id === matchId) return { match: m, roundIndex: r };
    }
  }
  return null;
}

// ---------- BRACKET IMAGE UPDATER ----------
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
  } catch (e) {
    console.error('updateBracketMessage error', e);
  }
}

// ---------- TIMERS (deadlines) ----------
const timers = new Map(); // matchId -> timeout

function scheduleMatchTimeout(tour, match, client, ms) {
  if (!match || !match.id) return;
  if (timers.has(match.id)) clearTimeout(timers.get(match.id));
  const to = setTimeout(async () => {
    timers.delete(match.id);
    // handle timeout: mark timed_out and create a vote or notify organizers
    match.status = 'timed_out';
    saveStorage();
    // post voting in vote channel (organizer may choose to open vote instead)
    try {
      await postVoteForMatch(tour, match, client);
    } catch (e) {
      console.error('Failed to post vote after timeout', e);
    }
  }, ms);
  timers.set(match.id, to);
}

function restoreTimers(client) {
  if (!storage.tournaments) return;
  for (const id of Object.keys(storage.tournaments)) {
    const tour = storage.tournaments[id];
    if (!tour || !tour.rounds) continue;
    for (const rnd of tour.rounds) {
      for (const m of rnd.matches) {
        if (!m) continue;
        if (m.deadlineTs && !m.winner && m.status !== 'finished' && m.deadlineTs > Date.now()) {
          scheduleMatchTimeout(tour, m, client, m.deadlineTs - Date.now());
        }
      }
    }
  }
}

// ---------- DISCORD CLIENT & COMMANDS ----------
const commands = [
  { name: 'create_tournament', description: 'Create a tournament (organizer only)', options: [
      { name: 'name', description: 'Tournament name', type: 3, required: true },
      { name: 'bracket_channel', description: 'Bracket channel id', type: 3, required: false },
      { name: 'registration_channel', description: 'Registration channel id', type: 3, required: false },
      { name: 'announce_channel', description: 'Announce channel id', type: 3, required: false },
      { name: 'vote_channel', description: 'Vote channel id', type: 3, required: false },
      { name: 'max_participants', description: 'Max participants (0=unlimited)', type: 4, required: false }
    ] },
  { name: 'post_registration', description: 'Post registration embed for a tournament', options: [{ name:'tournament', description:'tournament id or "current"', type:3, required:false }] },
  { name: 'open_registration', description: 'Open registration for a tournament', options: [{ name:'tournament', description:'id or current', type:3, required:false }] },
  { name: 'close_registration', description: 'Close registration and build bracket', options: [{ name:'tournament', description:'id or current', type:3, required:false }] },
  { name: 'assign_fixtures', description: 'Assign fixtures to battle channels', options: [{ name:'tournament',description:'id or current',type:3,required:false }] },
  { name: 'open_vote', description: 'Open vote for a match', options: [{ name:'tournament',type:3,required:false }, { name:'match_id',type:3,required:true }] },
  { name: 'end_match', description: 'End a match and set winner', options:[ { name:'tournament',type:3,required:false }, { name:'match_id',type:3,required:true }, { name:'winner',type:3,required:true } ] },
  { name: 'end_tournament', description: 'End a tournament and announce champion', options:[ { name:'tournament',type:3,required:false } ] },
  { name: 'set_channels', description: 'Set default channels', options: [
      { name:'bracket_channel', type:3 }, { name:'registration_channel', type:3 }, { name:'battle_category', type:3 },
      { name:'announce_channel', type:3 }, { name:'vote_channel', type:3 }
    ] },
  { name: 'set_battle_channels', description: 'Set battle channels (comma separated)', options:[ { name:'channels', type:3, required:true } ] },
  { name: 'set_organizer_roles', description: 'Set organizer role IDs (comma separated)', options:[ { name:'roles', type:3, required:true } ] },
  { name: 'show_bracket', description: 'Show bracket image', options:[ { name:'tournament', type:3, required:false } ] },
  { name: 'register', description: 'Register (legacy)', options:[ { name:'tournament', type:3, required:false } ] },
  { name: 'unregister', description: 'Unregister (legacy)', options:[ { name:'tournament', type:3, required:false } ] }
];

// deploy commands
async function deployCommands() {
  if (!process.env.BOT_TOKEN || !process.env.CLIENT_ID) {
    console.warn('Missing CLIENT_ID or BOT_TOKEN - cannot deploy commands automatically');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    if (process.env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
      console.log('Guild commands deployed');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('Global commands deployed (may take up to 1 hour)');
    }
  } catch (e) {
    console.error('Deploy failed', e);
  }
}
deployCommands();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

// ---------- EVENT: READY ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // ensure at least a "current" pointer exists
  if (!storage.meta) storage.meta = {};
  if (!storage.meta.currentTournament && Object.keys(storage.tournaments).length > 0) {
    storage.meta.currentTournament = Object.keys(storage.tournaments)[0];
    saveStorage();
  }
  // restore timers
  restoreTimers(client);
  // update bracket messages for all tournaments to ensure message ids are valid
  for (const id of Object.keys(storage.tournaments)) {
    const t = storage.tournaments[id];
    try { await updateBracketMessage(t, client); } catch (e) {}
  }
});

// ---------- REACTION REGISTRATION ----------
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    // find tournament by registrationMessageId
    const tour = Object.values(storage.tournaments).find(t => t.registrationMessageId === msg.id);
    if (!tour) return;
    if (reaction.emoji.name !== '✅') return;
    if (tour.status !== 'registration') {
      try { await user.send('Registration is closed for this tournament.'); } catch (e) {}
      return;
    }
    if (tour.maxParticipants && tour.participants.length >= tour.maxParticipants) {
      try { await user.send('Tournament is full'); } catch (e) {}
      return;
    }
    if (tour.participants.find(p => p.id === user.id)) {
      try { await user.send('You are already registered'); } catch (e) {}
      return;
    }
    tour.participants.push({ id: user.id, name: user.username || user.tag, joinedAt: Date.now() });
    saveStorage();
    await updateRegistrationEmbed(tour, client);
  } catch (e) { console.error('reaction add error', e); }
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
    if (idx !== -1) {
      tour.participants.splice(idx, 1);
      saveStorage();
      await updateRegistrationEmbed(tour, client);
    }
  } catch (e) { console.error('reaction remove error', e); }
});

// ---------- MESSAGE CREATE for battle channel posts ----------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  // find tournament/match where message.channel.id === match.channelId
  for (const tid of Object.keys(storage.tournaments)) {
    const tour = storage.tournaments[tid];
    if (!tour || tour.status !== 'running' || !tour.rounds) continue;
    for (const rnd of tour.rounds) {
      for (const match of rnd.matches) {
        if (!match || !match.channelId) continue;
        if (match.channelId === message.channel.id) {
          // only allow participants
          const uid = message.author.id;
          if (!((match.p1 && match.p1.id === uid) || (match.p2 && match.p2.id === uid))) return;
          // alternate posting
          if (match.lastPoster && match.lastPoster === uid) {
            try { await message.reply({ content: 'Wait for your opponent to reply (alternate turns).', ephemeral: true }); } catch (e) {}
            return;
          }
          match.lastPoster = uid;
          match.roundCount = (match.roundCount || 0) + 1;
          match.deadlineTs = Date.now() + (tour.roundReplyTimeoutHours || config.roundReplyTimeoutHours) * 60 * 60 * 1000;
          match.finished = false;
          saveStorage();
          scheduleMatchTimeout(tour, match, client, (match.deadlineTs - Date.now()));
          // notify briefly
          try {
            const opponentId = (match.p1 && match.p1.id === uid) ? (match.p2 && match.p2.id) : (match.p1 && match.p1.id);
            const note = await message.channel.send(`Post recorded from ${message.author.username}. ${opponentId ? `<@${opponentId}>` : ''} you have ${tour.roundReplyTimeoutHours || config.roundReplyTimeoutHours} hours to reply.`);
            setTimeout(() => note.delete().catch(() => {}), 12 * 1000);
          } catch (e) {}
          return;
        }
      }
    }
  }
});

// ---------- INTERACTION (slash commands + button votes) ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // Button votes
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (!id.startsWith('vote_')) return;
      const parts = id.split('_'); // vote_R1M1_p1
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
          saveStorage();
          await interaction.reply({ content: `Vote recorded for ${choice}`, ephemeral: true });
          return;
        }
      }
      await interaction.reply({ content: 'Match not found', ephemeral: true });
      return;
    }

    // Chat commands
    if (!interaction.isChatInputCommand()) return;

    const cmd = interaction.commandName;
    const argTournament = interaction.options.getString('tournament') || 'current';
    const tournamentId = (argTournament === 'current') ? (storage.meta && storage.meta.currentTournament) : (argTournament || null);
    const tournament = tournamentId ? storage.tournaments[tournamentId] : null;

    // helper: get target tournament (fallback to current if not provided)
    function getTargetTournamentOrReply() {
      if (argTournament === 'current') {
        const cur = storage.meta && storage.meta.currentTournament;
        if (!cur) { interaction.reply({ content: 'No current tournament selected', ephemeral: true }); return null; }
        return storage.tournaments[cur];
      }
      const t = storage.tournaments[argTournament];
      if (!t) { interaction.reply({ content: `Tournament ${argTournament} not found`, ephemeral: true }); return null; }
      return t;
    }

    // register (legacy)
    if (cmd === 'register') {
      const tour = getTargetTournamentOrReply();
      if (!tour) return;
      if (tour.status !== 'registration') return interaction.reply({ content: 'Registration is closed.', ephemeral: true });
      if (tour.participants.find(p => p.id === interaction.user.id)) return interaction.reply({ content: 'Already registered', ephemeral: true });
      if (tour.maxParticipants && tour.participants.length >= tour.maxParticipants) return interaction.reply({ content: 'Tournament is full', ephemeral: true });
      tour.participants.push({ id: interaction.user.id, name: interaction.member.displayName || interaction.user.username, joinedAt: Date.now() });
      saveStorage();
      await updateRegistrationEmbed(tour, client);
      return interaction.reply({ content: 'Registered', ephemeral: true });
    }

    if (cmd === 'unregister') {
      const tour = getTargetTournamentOrReply();
      if (!tour) return;
      if (tour.status !== 'registration') return interaction.reply({ content: 'Cannot unregister now', ephemeral: true });
      const idx = tour.participants.findIndex(p => p.id === interaction.user.id);
      if (idx === -1) return interaction.reply({ content: 'You are not registered', ephemeral: true });
      tour.participants.splice(idx, 1);
      saveStorage();
      await updateRegistrationEmbed(tour, client);
      return interaction.reply({ content: 'Unregistered', ephemeral: true });
    }

    // create_tournament
    if (cmd === 'create_tournament') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers can create tournaments', ephemeral: true });
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
      // set as current if none
      if (!storage.meta) storage.meta = {};
      storage.meta.currentTournament = id;
      saveStorage();
      return interaction.reply({ content: `Created tournament **${name}** (id: ${id}). Use /post_registration to publish.`, ephemeral: true });
    }

    // post_registration
    if (cmd === 'post_registration') {
      const tour = getTargetTournamentOrReply();
      if (!tour) return;
      try {
        const msg = await postRegistrationEmbed(tour, client);
        await updateRegistrationEmbed(tour, client);
        return interaction.reply({ content: `Posted registration in <#${tour.channels.registration || config.registrationChannel || config.bracketChannel}>`, ephemeral: true });
      } catch (e) {
        return interaction.reply({ content: `Failed to post registration: ${e.message}`, ephemeral: true });
      }
    }

    // open_registration
    if (cmd === 'open_registration') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const tour = getTargetTournamentOrReply();
      if (!tour) return;
      tour.status = 'registration';
      saveStorage();
      if (!tour.registrationMessageId) {
        try { await postRegistrationEmbed(tour, client); } catch (e) { console.error(e); }
      }
      await updateRegistrationEmbed(tour, client);
      return interaction.reply({ content: `Registration opened for ${tour.name}`, ephemeral: true });
    }

    // close_registration -> build bracket
    if (cmd === 'close_registration') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const tour = getTargetTournamentOrReply();
      if (!tour) return;
      if (tour.participants.length < 2) return interaction.reply({ content: 'Not enough participants (min 2).', ephemeral: true });
      tour.status = 'running';
      buildInitialBracket(tour);
      regenerateNextRounds(tour);
      saveStorage();
      // assign fixtures for round 0
      try {
        await assignRoundToChannels(tour, 0, client);
      } catch (e) { console.error('assignRound error', e); }
      await updateBracketMessage(tour, client);
      return interaction.reply({ content: `Registration closed. Bracket built and matches assigned.`, ephemeral: false });
    }

    // assign_fixtures
    if (cmd === 'assign_fixtures') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const tour = getTargetTournamentOrReply();
      if (!tour) return;
      if (!tour.rounds || !tour.rounds.length) return interaction.reply({ content: 'No bracket available.', ephemeral: true });
      try {
        await assignRoundToChannels(tour, 0, client);
        saveStorage();
        await updateBracketMessage(tour, client);
        return interaction.reply({ content: 'Assignments done.', ephemeral: true });
      } catch (e) {
        console.error(e);
        return interaction.reply({ content: 'Failed to assign', ephemeral: true });
      }
    }

    // open_vote
    if (cmd === 'open_vote') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const matchId = interaction.options.getString('match_id');
      const tour = getTargetTournamentOrReply();
      if (!tour) return;
      const found = findMatchById(tour, matchId);
      if (!found) return interaction.reply({ content: 'Match not found', ephemeral: true });
      try {
        const vm = await postVoteForMatch(tour, found.match, client);
        return interaction.reply({ content: `Vote opened in <#${tour.channels.vote || config.voteChannel || found.match.channelId}>`, ephemeral: true });
      } catch (e) {
        console.error(e);
        return interaction.reply({ content: `Failed to open vote: ${e.message}`, ephemeral: true });
      }
    }

    // end_match
    if (cmd === 'end_match') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const matchId = interaction.options.getString('match_id');
      const winner = interaction.options.getString('winner'); // p1 or p2
      const tour = getTargetTournamentOrReply();
      if (!tour) return;
      const found = findMatchById(tour, matchId);
      if (!found) return interaction.reply({ content: 'Match not found', ephemeral: true });
      const match = found.match;
      if (winner !== 'p1' && winner !== 'p2') return interaction.reply({ content: 'Invalid winner. Use p1 or p2', ephemeral: true });
      match.winner = winner;
      match.status = 'finished';
      saveStorage();
      regenerateNextRounds(tour);
      await updateBracketMessage(tour, client);
      // announce
      try {
        const ach = await client.channels.fetch(tour.channels.announce || config.announcementChannel || tour.channels.bracket || config.bracketChannel);
        if (ach) await ach.send(`Match ${match.id} finished. Winner: **${match[winner] ? match[winner].name : winner}**. Bracket updated.`);
      } catch (e) { console.error('announce fail', e); }
      return interaction.reply({ content: `Match ${matchId} set to ${winner}`, ephemeral: true });
    }

    // end_tournament
    if (cmd === 'end_tournament') {
      if (!isOrganizerMember(interaction.member)) return interaction.reply({ content: 'Only organizers', ephemeral: true });
      const tour = getTargetTournamentOrReply();
      if (!tour) return;
      // find final match winner
      const lastRound = tour.rounds && tour.rounds.length ? tour.rounds[tour.rounds.length - 1].matches : null;
      if (!lastRound || lastRound.length === 0) return interaction.reply({ content: 'Tournament has no final', ephemeral: true });
      const finalMatch = lastRound[0];
      if (!finalMatch || !finalMatch.winner) {
        tour.status = 'finished';
        saveStorage();
        return interaction.reply({ content: 'Tournament ended manually. No champion set.', ephemeral: false });
      }
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
      config.battleChannels = csv.split(',').map(s => s.trim()).filter(Boolean);
      saveConfig();
      return interaction.reply({ content: `Battle channels set: ${config.battleChannels.join(', ')}`, ephemeral: true });
    }

    // set_organizer_roles
    if (cmd === 'set_organizer_roles') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: 'Manage Server required', ephemeral: true });
      const csv = interaction.options.getString('roles');
      config.organizerRoleIds = csv.split(',').map(s => s.trim()).filter(Boolean);
      saveConfig();
      return interaction.reply({ content: 'Organizer roles set.', ephemeral: true });
    }

    // show_bracket
    if (cmd === 'show_bracket') {
      const tour = getTargetTournamentOrReply();
      if (!tour) return;
      try {
        const buf = await drawBracketImage(tour, config.image || {});
        const att = new AttachmentBuilder(buf, { name: 'bracket.png' });
        return interaction.reply({ files: [att], ephemeral: false });
      } catch (e) {
        console.error('draw fail', e);
        return interaction.reply({ content: 'Failed to draw bracket', ephemeral: true });
      }
    }

  } catch (e) {
    console.error('interaction handler error', e);
    try { if (interaction.replied === false && interaction.deferred === false) await interaction.reply({ content: 'Internal error', ephemeral: true }); } catch {}
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
