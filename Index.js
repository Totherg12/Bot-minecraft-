const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, Events } = require('discord.js');
const express = require('express');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

// Servidor Express HTTP obrigatório para o Render manter o bot acordado
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Bot do Minecraft Bedrock está online e operando!');
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

// Configurações do Bot (serão puxadas das Variáveis de Ambiente do Render)
const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  MC_HOST: 'ultra-04.bedhosting.com.br',
  MC_PORT: 37116
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('online')
    .setDescription('Exibe os jogadores e o status atual do servidor de Minecraft Bedrock')
].map(command => command.toJSON());

async function getBedrockServerStatus() {
  try {
    const res = await fetch('https://api.mcstatus.io/v2/status/bedrock/' + CONFIG.MC_HOST + ':' + CONFIG.MC_PORT);
    if (res.ok) {
      const data = await res.json();
      if (data && data.online) {
        const playersList = data.players && data.players.list ? data.players.list.map(p => p.name_clean || p.name_raw) : [];
        return {
          online: true,
          playersOnline: data.players ? data.players.online : 0,
          playersMax: data.players ? data.players.max : 0,
          list: playersList
        };
      }
    }
  } catch (err) {
    console.error('Erro na API:', err.message);
  }

  try {
    const res = await fetch('https://api.mcsrvstat.us/bedrock/2/' + CONFIG.MC_HOST + ':' + CONFIG.MC_PORT);
    if (res.ok) {
      const data = await res.json();
      if (data && data.online) {
        return {
          online: true,
          playersOnline: data.players ? data.players.online : 0,
          playersMax: data.players ? data.players.max : 0,
          list: data.players && data.players.list ? data.players.list : []
        };
      }
    }
  } catch (err) {
    console.error('Erro no fallback:', err.message);
  }

  return { online: false, playersOnline: 0, playersMax: 0, list: [] };
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    console.log('Comando /online registrado com sucesso no Discord!');
  } catch (error) {
    console.error('Erro ao registrar comandos:', error);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Bot conectado como: ${c.user.tag}`);
  await registerCommands();

  const updatePresence = async () => {
    const status = await getBedrockServerStatus();
    if (status.online) {
      client.user.setActivity(`${status.playersOnline}/${status.playersMax} no Bedrock`, { type: 3 });
    } else {
      client.user.setActivity('Servidor Offline', { type: 3 });
    }
  };

  updatePresence();
  setInterval(updatePresence, 120000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'online') {
    await interaction.deferReply();

    const data = await getBedrockServerStatus();

    if (!data.online) {
      const offlineEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('🔴 Servidor Offline')
        .setDescription('Não foi possível conectar a **' + CONFIG.MC_HOST + ':' + CONFIG.MC_PORT + '**.')
        .setTimestamp();
      return interaction.editReply({ embeds: [offlineEmbed] });
    }

    const playerListFormatted = data.list.length > 0 
      ? data.list.map(p => `• ${p}`).join('\n') 
      : 'Nenhum jogador detectado (ou query desativada no servidor).';

    const listFinal = playerListFormatted.length > 1024 
      ? playerListFormatted.substring(0, 1020) + '...' 
      : playerListFormatted;

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('🟢 Status do Servidor Minecraft Bedrock')
      .addFields(
        { name: '🌐 Endereço', value: `\`${CONFIG.MC_HOST}:${CONFIG.MC_PORT}\``, inline: true },
        { name: '👥 Jogadores Online', value: `**${data.playersOnline} / ${data.playersMax}**`, inline: true },
        { name: '📜 Jogadores em jogo', value: listFinal }
      )
      .setFooter({ text: 'Dados obtidos via API Web (Bedrock)' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
});

client.login(CONFIG.DISCORD_TOKEN);
