// deploy-commands.js
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');

const commands = [
  {
    name: 'register',
    description: 'Register for the next tournament'
  },
  {
    name: 'unregister',
    description: 'Unregister from the tournament'
  },
  {
    name: 'start_tournament',
    description: 'Start the tournament (organizer only)'
  },
  {
    name: 'show_bracket',
    description: 'Show bracket image'
  },
  {
    name: 'set_winner',
    description: 'Set winner for a match (organizer only)',
    options: [
      { name: 'match_id', description: 'Match ID', type: 3, required: true },
      { name: 'winner', description: 'p1 or p2', type: 3, required: true }
    ]
  }
];

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log('Successfully registered (guild) commands.');
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log('Successfully registered (global) commands.');
    }
  } catch (error) {
    console.error(error);
  }
})();
