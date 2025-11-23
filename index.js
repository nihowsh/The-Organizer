// index.js
require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Partials, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const { drawBracketImage } = require('./bracketDrawer');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STORAGE_PATH = path.join(__dirname, 'storage.json');

const config = fs.existsSync(CONFIG_PATH) ? fs.readJsonSync(CONFIG_PATH) : {};
const storage = fs.existsSync(STORAGE_PATH) ? fs.readJsonSync(STORAGE_PATH) : { tournaments: {} };

// simple in-memory timers map { timerId: NodeTimeout }
const timers = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

const TOURNEY_ID = 'current'; // single active tournament; extendable

// default tournament object in storage if absent
if (!storage.tournaments[TOURNEY_ID]) {
  storage.tournaments[TOURNEY_ID] = {
    name: 'Wordsmith of the Month',
    status: 'registration', // registration | running | finished
    participants: [], // { id, name, joinedAt }
    rounds: [],
    size: 0,
    bracketMessageId: null,
    createdAt: Date.now()
  };
  fs.writeJsonSync(STORAGE_PATH, storage, { spaces: 2 });
}

function saveStorage() {
  fs.writeJsonSync(STORAGE_PATH, storage, { spaces: 2 });
}

// helper: create next power of two
function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Build initial bracket given participants (first-come-first-serve BYEs) */
function buildInitialBracket(tournament) {
  const parts = tournament.participants.slice(); // in order
  const N = parts.length;
  const P = nextPowerOfTwo(N);
  const byes = P - N;

  // players who get byes are the earliest ones
  const byePlayers = parts.slice(0, byes);
  const playPlayers = parts.slice(byes);

  // create slots array length P, fill with players or null
  const slots = [];
  // put byes first (they get onto slots), then the remaining
  const ordered = [...byePlayers, ...playPlayers];
  for (let i = 0; i < P; i++) {
    slots.push(ordered[i] || null);
  }

  // create first round matches (P/2)
  const firstRound = [];
  for (let i = 0; i < P; i += 2) {
    const p1 = slots[i] ? { id: slots[i].id, name: slots[i].name } : null;
    const p2 = slots[i+1] ? { id: slots[i+1].id, name: slots[i+1].name } : null;
    firstRound.push({ id: `R1M${i/2+1}`, p1, p2, winner: null, status: 'pending' });
  }

  // compute rounds array size = log2(P)
  const rounds = [firstRound];
  let prevCount = firstRound.length;
  while (prevCount > 1) {
    const nextCount = Math.ceil(prevCount / 2);
    rounds.push(new Array(nextCount).fill(null).map((_, idx) => ({ id: `R${rounds.length+1}M${idx+1}`, p1: null, p2: null, winner: null, status: 'locked' })));
    prevCount = nextCount;
  }

  tournament.rounds = rounds;
  tournament.size = P;
}

// helper to regenerate later rounds from winners
function regenerateNextRounds(tournament) {
  const rounds = tournament.rounds;
  for (let r = 0; r < rounds.length - 1; r++) {
    const curr = rounds[r];
    const next = rounds[r+1];
    // fill next round slots from winners (or BYEs)
    let idx = 0;
    for (let i = 0; i < curr.length; i += 2) {
      const m1 = curr[i];
      const m2 = curr[i+1];
      const winner1 = m1 && m1.winner ? (m1.winner === 'p1' ? m1.p1 : m1.p2) : null;
      const winner2 = m2 && m2.winner ? (m2.winner === 'p1' ? m2.p1 : m2.p2) : null;
      next[idx].p1 = winner1;
      next[idx].p2 = winner2;
      // if any of p1/p2 present then unlock
      next[idx].status = (next[idx].p1 || next[idx].p2) ? 'pending' : 'locked';
      idx++;
    }
  }
}

// restore timers from storage on startup (for round deadlines)
function restoreTimers() {
  const t = storage.tournaments[TOURNEY_ID];
  if (!t) return;
  // scan all matches for timeouts stored in 'deadline' property (if used)
  for (const round of t.rounds) {
    for (const match of round) {
      if (match && match.deadlineTs && !match.finished) {
        const msLeft = match.deadlineTs - Date.now();
        if (msLeft > 0) {
          scheduleMatchTimeout(t, match, msLeft);
        } else {
          // timeout already expired while offline -> handle immediately
          handleMatchTimeout(t, match);
        }
      }
    }
  }
}

// schedule a match timeout (ms milliseconds)
function scheduleMatchTimeout(tournament, match, ms) {
  if (!match || !match.id) return;
  // clear existing
  if (timers.has(match.id)) clearTimeout(timers.get(match.id));
  const to = setTimeout(() => {
    timers.delete(match.id);
    handleMatchTimeout(tournament, match);
  }, ms);
  timers.set(match.id, to);
}

// when someone fails to post in time
async function handleMatchTimeout(tournament, match) {
  // mark status finished and create a vote between whoever posted vs absent
  match.status = 'timed_out';
  // create vote: if one side posted, compare posted vs null => auto-vote between player and absent -> we create a vote where players can choose winner manually
  const p1 = match.p1;
  const p2 = match.p2;
  // find bracketChannel
  const bracketChannel = config.bracketChannel;
  try {
    const channel = await client.channels.fetch(bracketChannel);
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId(`vote_${match.id}_p1`).setLabel(p1 ? p1.name : 'Player1').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`vote_${match.id}_p2`).setLabel(p2 ? p2.name : 'Player2').setStyle(ButtonStyle.Danger)
      );
    const msg = await channel.send({ content: `Match ${match.id} ended due to inactivity. Vote for the winner:`, components: [row] });
    // create a collector for X minutes (default from config)
    createVoteCollector(msg, match, tournament, (winnerKey) => {
      // on finish
      match.winner = winnerKey; // 'p1' or 'p2'
      match.status = 'finished';
      regenerateNextRounds(tournament);
      saveStorage();
      updateBracketMessage(tournament); // regenerate image
    });
  } catch (e) {
    console.error('Failed to post timeout vote:', e);
  }
  saveStorage();
}

// create a collector on a message with two buttons
function createVoteCollector(message, match, tournament, onFinish) {
  const filter = (i) => i.isButton();
  const collector = message.createMessageComponentCollector({ filter, time: (config.defaultVoteDurationMinutes || 60) * 60 * 1000 });

  const votes = new Map();
  collector.on('collect', async (i) => {
    const id = i.user.id;
    // single vote per user
    if (votes.has(id)) {
      await i.reply({ content: 'You already voted.', ephemeral: true });
      return;
    }
    const [ , mid, choice ] = i.customId.split('_'); // vote_R1M1_p1
    votes.set(id, choice);
    await i.reply({ content: `Vote received for ${choice}`, ephemeral: true });
  });

  collector.on('end', async () => {
    // tally
    const tally = { p1: 0, p2: 0 };
    for (const v of votes.values()) {
      if (v === 'p1') tally.p1++;
      if (v === 'p2') tally.p2++;
    }
    let winnerKey = null;
    if (tally.p1 > tally.p2) winnerKey = 'p1';
    else if (tally.p2 > tally.p1) winnerKey = 'p2';
    else winnerKey = 'p1'; // default tiebreaker: p1
    try {
      await message.channel.send(`Voting ended. Results: p1=${tally.p1}, p2=${tally.p2}. Winner: ${winnerKey}`);
    } catch (e) {}
    if (onFinish) onFinish(winnerKey);
  });
}

// builds and uploads bracket image to bracketChannel; stores message id
async function updateBracketMessage(tournament) {
  try {
    const buf = await drawBracketImage(tournament, config.image || {});
    const attachment = new AttachmentBuilder(buf, { name: 'bracket.png' });
    const channel = await client.channels.fetch(config.bracketChannel);
    if (!channel) return;
    // if previous message exists, edit it, else send new
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
  } catch (e) {
    console.error('Failed to update bracket message:', e);
  }
}

// create battle channel for a match inside configured category
async function createBattleChannelForMatch(guild, match) {
  try {
    const categoryId = config.battleCategory;
    // build channel name safe
    const p1n = match.p1 ? sanitizeName(match.p1.name) : 'tbd';
    const p2n = match.p2 ? sanitizeName(match.p2.name) : 'tbd';
    const channelName = `battle-${match.id.toLowerCase()}`.replace(/[^a-z0-9-]/g, '-').slice(0, 90);

    const channel = await guild.channels.create({
      name: channelName,
      type: 0, // GuildText
      parent: categoryId || null,
      permissionOverwrites: []
    });

    // send instructions
    await channel.send(`Match ${match.id} — ${match.p1 ? match.p1.name : 'TBD'} vs ${match.p2 ? match.p2.name : 'TBD'}\nThis battle is 3 rounds. Each reply resets your opponent's 24-hour timer.\nWhen both finish, bot will create a vote automatically.`);
    return channel;
  } catch (e) {
    console.error('Failed to create battle channel:', e);
  }
}

function sanitizeName(name) {
  if (!name) return 'unknown';
  return name.replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '-').toLowerCase();
}

// ---------- Interaction handling (slash commands) ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const t = storage.tournaments[TOURNEY_ID];

  if (interaction.commandName === 'register') {
    if (t.status !== 'registration') {
      await interaction.reply({ content: 'Registration is closed.', ephemeral: true });
      return;
    }
    const exists = t.participants.find(p => p.id === interaction.user.id);
    if (exists) {
      await interaction.reply({ content: 'You are already registered.', ephemeral: true });
      return;
    }
    t.participants.push({ id: interaction.user.id, name: interaction.member.displayName || interaction.user.username, joinedAt: Date.now() });
    saveStorage();
    await interaction.reply({ content: 'Registered for the tournament.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'unregister') {
    if (t.status !== 'registration') {
      await interaction.reply({ content: 'Cannot unregister now.', ephemeral: true });
      return;
    }
    const idx = t.participants.findIndex(p => p.id === interaction.user.id);
    if (idx === -1) {
      await interaction.reply({ content: 'You are not registered.', ephemeral: true });
      return;
    }
    t.participants.splice(idx, 1);
    saveStorage();
    await interaction.reply({ content: 'You have been unregistered.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'start_tournament') {
    // permission check
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !interaction.member.roles.cache.some(r => r.name.toLowerCase().includes('organizer'))) {
      await interaction.reply({ content: 'You must be an organizer or have Manage Server to start.', ephemeral: true });
      return;
    }
    if (t.status !== 'registration') {
      await interaction.reply({ content: 'Tournament already started or finished.', ephemeral: true });
      return;
    }
    if (t.participants.length < 2) {
      await interaction.reply({ content: 'Not enough participants (min 2).', ephemeral: true });
      return;
    }
    t.status = 'running';
    buildInitialBracket(t);
    saveStorage();
    await updateBracketMessage(t);
    await interaction.reply({ content: `Tournament started with ${t.participants.length} participants.`, ephemeral: false });

    // create initial battle channels for round 1 pending matches
    const guild = interaction.guild;
    const r1 = t.rounds[0];
    for (const match of r1) {
      // if both null skip
      if (!match.p1 && !match.p2) continue;
      // create channel
      const channel = await createBattleChannelForMatch(guild, match);
      // store channel id in match for reference
      match.channelId = channel ? channel.id : null;
      // If someone is BYE -> auto mark winner
      if (match.p1 && !match.p2) {
        match.winner = 'p1';
        match.status = 'finished';
      } else if (!match.p1 && match.p2) {
        match.winner = 'p2';
        match.status = 'finished';
      } else {
        match.status = 'pending';
        // set a first-round deadline only when first message from either posted; otherwise when someone posts we set deadlines
      }
    }
    regenerateNextRounds(t);
    saveStorage();
    await updateBracketMessage(t);
    return;
  }

  if (interaction.commandName === 'show_bracket') {
    const buf = await drawBracketImage(t, config.image || {});
    const attachment = new AttachmentBuilder(buf, { name: 'bracket.png' });
    await interaction.reply({ files: [attachment], ephemeral: false });
    return;
  }

  if (interaction.commandName === 'set_winner') {
    // simple organizer only command to force-set winner
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !interaction.member.roles.cache.some(r => r.name.toLowerCase().includes('organizer'))) {
      await interaction.reply({ content: 'You must be an organizer to use this.', ephemeral: true });
      return;
    }
    const matchId = interaction.options.getString('match_id');
    const winner = interaction.options.getString('winner'); // 'p1' or 'p2'
    const found = findMatchById(t, matchId);
    if (!found) {
      await interaction.reply({ content: 'Match not found.', ephemeral: true });
      return;
    }
    const { match } = found;
    if (winner !== 'p1' && winner !== 'p2') {
      await interaction.reply({ content: 'Invalid winner. use p1 or p2', ephemeral: true });
      return;
    }
    match.winner = winner;
    match.status = 'finished';
    regenerateNextRounds(t);
    saveStorage();
    await updateBracketMessage(t);
    await interaction.reply({ content: `Winner for ${matchId} set to ${winner}.`, ephemeral: true });
    return;
  }
});

client.on('messageCreate', async (message) => {
  // watch for battle channel replies only
  if (!message.guild) return;
  const t = storage.tournaments[TOURNEY_ID];
  if (t.status !== 'running') return;

  // find match by channel id
  for (const round of t.rounds) {
    for (const match of round) {
      if (!match || !match.channelId) continue;
      if (match.channelId === message.channel.id) {
        // treat as a round post; if both present then this may be Round 2/3 depending how you structure
        await handleBattleChannelMessage(t, match, message);
        return;
      }
    }
  }
});

async function handleBattleChannelMessage(tournament, match, message) {
  // store that someone posted and set deadline for opponent
  // round tracking minimal: we record lastPoster and increment a 'roundCount' property per match
  match.lastPoster = match.lastPoster || null;
  match.roundCount = match.roundCount || 0;

  // only participants can post
  const uid = message.author.id;
  if (!((match.p1 && match.p1.id === uid) || (match.p2 && match.p2.id === uid))) {
    // not a combatant, ignore or warn
    return;
  }

  // if lastPoster is same as author, ignore (must alternate)
  if (match.lastPoster === uid) {
    await message.reply({ content: 'It is not your turn. Wait for your opponent to reply.', ephemeral: true }).catch(()=>{});
    return;
  }

  // record posting: increment roundCount only when both posted? Here we treat each alternating post as progressing
  match.lastPoster = uid;
  match.roundCount += 1;
  // set deadline for opponent: now + X hours
  const timeoutMs = (config.roundReplyTimeoutHours || 24) * 60 * 60 * 1000;
  match.deadlineTs = Date.now() + timeoutMs;
  match.finished = false;

  saveStorage();

  // reschedule timer
  scheduleMatchTimeout(tournament, match, timeoutMs);

  // if roundCount >= 6 (3 rounds each -> 6 posts) then start voting
  if (match.roundCount >= 6) {
    // finish match entries and create vote
    match.status = 'voting';
    // post vote in bracket channel
    try {
      const channel = await client.channels.fetch(config.bracketChannel);
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId(`vote_${match.id}_p1`).setLabel(match.p1 ? match.p1.name : 'Player 1').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`vote_${match.id}_p2`).setLabel(match.p2 ? match.p2.name : 'Player 2').setStyle(ButtonStyle.Danger)
        );
      const msg = await channel.send({ content: `Voting for match ${match.id}: ${match.p1 ? match.p1.name : 'TBD'} vs ${match.p2 ? match.p2.name : 'TBD'}`, components: [row] });
      createVoteCollector(msg, match, tournament, (winnerKey) => {
        match.winner = winnerKey;
        match.status = 'finished';
        regenerateNextRounds(tournament);
        saveStorage();
        updateBracketMessage(tournament);
      });
      // clear deadline timer
      if (timers.has(match.id)) {
        clearTimeout(timers.get(match.id));
        timers.delete(match.id);
      }
    } catch (e) {
      console.error('Failed to post match vote:', e);
    }
  } else {
    // notify channel/opponent of timer
    const opponentId = (match.p1 && match.p1.id === message.author.id) ? (match.p2 && match.p2.id) : (match.p1 && match.p1.id);
    try {
      const ch = await message.channel.send(`Post received from ${message.author.username}. ${opponentId ? `<@${opponentId}>` : ''} you have ${config.roundReplyTimeoutHours || 24} hours to reply.`);
      // optionally delete this notice later
      setTimeout(()=>ch.delete().catch(()=>{}), 15*1000);
    } catch(e){}
  }
  saveStorage();
  updateBracketMessage(tournament);
}

// helper to find match by id
function findMatchById(tournament, matchId) {
  for (const round of tournament.rounds) {
    for (const match of round) {
      if (match && match.id === matchId) return { match, round };
    }
  }
  return null;
}

// respond to button interactions for votes
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const id = interaction.customId;
  if (!id.startsWith('vote_')) return;
  // id = vote_R1M1_p1
  const parts = id.split('_');
  const matchId = parts[1];
  const choice = parts[2]; // p1/p2
  const t = storage.tournaments[TOURNEY_ID];
  const found = findMatchById(t, matchId);
  if (!found) {
    await interaction.reply({ content: 'Match not found', ephemeral: true });
    return;
  }
  const match = found.match;
  // store votes in match.votes: { userId: choice }
  match.votes = match.votes || {};
  if (match.votes[interaction.user.id]) {
    await interaction.reply({ content: 'You already voted', ephemeral: true });
    return;
  }
  match.votes[interaction.user.id] = choice;
  await interaction.reply({ content: `Vote recorded for ${choice}`, ephemeral: true });
  saveStorage();
  // do not close here: collector created earlier will tally
});

// basic ready
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // restore timers from storage
  restoreTimers();

  // keep bracket current on startup
  const t = storage.tournaments[TOURNEY_ID];
  if (t && t.rounds && t.rounds.length) {
    updateBracketMessage(t);
  }
});

// express keep-alive
const app = express();
app.get('/', (req, res) => res.send('Tourney bot alive'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Keep-alive server listening on ${port}`));

client.login(process.env.BOT_TOKEN);
