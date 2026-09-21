process.env.DEBUG =
'minecraft-protocol';

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, Events } = require('discord.js');
const bedrock = require('bedrock-protocol');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Bot do Minecraft Bedrock online!');
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  MC_HOST: 'ultra-04.bedhosting.com.br',
  MC_PORT: 37116
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let cachedPlayers = [];

function connectBedrockClient() {
  console.log('🔄 A conectar o cliente fake ao servidor Bedrock...');
  try {
    const mcClient = bedrock.createClient({
      host: CONFIG.MC_HOST,
      port: CONFIG.MC_PORT,
      username: 'BotStatus',
      version: '1.26.51', // <--- Força a versão exata exigida pelo servidor[span_4](start_span)[span_4](end_span)
      offline: true,
      connectTimeout: 15000
      conLog: console.log
    });

    mcClient.on('join', () => {
      console.log('✅ Cliente fake conectado com sucesso ao mundo!');
    });

    mcClient.on('player_list', (packet) => {
      if (packet && packet.records && packet.records.records) {
        cachedPlayers = [];
        packet.records.records.forEach(player => {
          if (player.username && !cachedPlayers.includes(player.username)) {
            cachedPlayers.push(player.username);
          }
        });
        console.log(`📋 Nicks atualizados: ${cachedPlayers.join(', ')}`);
      }
    });

    mcClient.on('error', (err) => {
      console.error('⚠️ Erro no protocolo Bedrock:', err.message);
    });

    mcClient.on('close', () => {
      console.log('🔌 Conexão fechada. A tentar reconectar em 10s...');
      setTimeout(connectBedrockClient, 10000);
    });
  } catch (e) {
    console.error('Erro ao criar cliente bedrock:', e.message);
    setTimeout(connectBedrockClient, 10000);
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('online')
    .setDescription('Exibe os nicks reais dos jogadores online no servidor')
].map(command => command.toJSON());

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Bot conectado como: ${c.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    console.log('Comando /online registado com sucesso!');
  } catch (error) {
    console.error('Erro ao registar comandos:', error);
  }
  connectBedrockClient();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'online') {
    await interaction.deferReply();

    const playerListFormatted = cachedPlayers.length > 0
      ? cachedPlayers.map(p => `• ${p}`).join('\n')
      : 'Nenhum nick detetado ainda (a aguardar sincronização do cliente fake).';

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('🟢 Jogadores Online (Conexão Direta)')
      .addFields(
        { name: '🌐 Endereço', value: `\`${CONFIG.MC_HOST}:${CONFIG.MC_PORT}\``, inline: true },
        { name: '👥 Total Detetado', value: `**${cachedPlayers.length}**`, inline: true },
        { name: '📜 Lista de Nicks', value: playerListFormatted.substring(0, 1024) }
      )
      .setFooter({ text: 'Obtido via Fake Client / RakNet' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
});

client.login(CONFIG.DISCORD_TOKEN);
