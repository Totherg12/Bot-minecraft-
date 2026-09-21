const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, Events } = require('discord.js');
const bedrock = require('bedrock-protocol');
const express = require('express');

// Servidor HTTP obrigatório para o Render manter o bot acordado 24/7
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Bot do Minecraft Bedrock com Fake Client está online!');
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

// Guarda em memória os nicks obtidos diretamente do servidor de jogo
let cachedPlayers = [];
let isConnected = false;

function connectBedrockClient() {
  console.log('🔄 A conectar o cliente fake ao servidor Bedrock...');

  try {
    const mcClient = bedrock.createClient({
      host: CONFIG.MC_HOST,
      port: CONFIG.MC_PORT,
      offline: true,
      connectTimeout: 15000
    });

    mcClient.on('join', () => {
      console.log('✅ Cliente fake conectado com sucesso ao mundo!');
      isConnected = true;
    });

    // Intercepta a lista de jogadores enviada pelo servidor em direto
    mcClient.on('player_list', (packet) => {
      if (packet && packet.records && packet.records.records) {
        // Limpa a lista antiga para atualizar com os nicks atuais
        cachedPlayers = [];
        packet.records.records.forEach(player => {
          if (player.username && !cachedPlayers.includes(player.username)) {
            cachedPlayers.push(player.username);
          }
        });
      }
    });

    mcClient.on('error', (err) => {
      console.error('⚠️ Erro no protocolo Bedrock:', err.message);
      isConnected = false;
    });

    mcClient.on('close', () => {
      console.log('🔌 Conexão fechada. A tentar reconectar em 15 segundos...');
      isConnected = false;
      cachedPlayers = [];
      setTimeout(connectBedrockClient, 15000);
    });

  } catch (e) {
    console.error('Falha ao iniciar cliente:', e.message);
    setTimeout(connectBedrockClient, 15000);
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('online')
    .setDescription('Exibe os nicks reais dos jogadores online no servidor')
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    console.log('Comando /online registado com sucesso!');
  } catch (error) {
    console.error('Erro ao registar comandos:', error);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Bot conectado como: ${c.user.tag}`);
  await registerCommands();
  connectBedrockClient();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'online') {
    await interaction.deferReply();

    const playerListFormatted = cachedPlayers.length > 0
      ? cachedPlayers.map(p => `• ${p}`).join('\n')
      : 'Nenhum nick detetado na tabela de jogadores de momento.';

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
