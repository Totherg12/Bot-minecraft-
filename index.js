process.env.DEBUG = '';

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  Events,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');
const bedrock = require('bedrock-protocol');
const express = require('express');

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const app = express();
const PORT = Number(process.env.PORT || 3000);
const RECONNECT_DELAY = 10000;

const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  MC_HOST: process.env.MC_HOST || 'ultra-04.bedhosting.com.br',
  MC_PORT: Number(process.env.MC_PORT || 37116),
  MC_USERNAME: process.env.MC_USERNAME || 'BotStatus',
  MC_VERSION: '1.26.51',
  MC_OFFLINE: false,
  ONLINE_CHANNEL_ID: process.env.ONLINE_CHANNEL_ID || null,
  REGISTRATION_CHANNEL_ID: process.env.REGISTRATION_CHANNEL_ID || null
};

if (!CONFIG.DISCORD_TOKEN || !CONFIG.CLIENT_ID) {
  console.error('❌ Configure DISCORD_TOKEN e CLIENT_ID no Render.');
  process.exit(1);
}

app.get('/', (_req, res) => res.status(200).send('Bot online!'));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP ativo na porta ${PORT}`);
});

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ============================================================
// ESTADO E MAPEAMENTOS DE PLACAR
// ============================================================

const jogadoresOnline = new Map();
const temposJogadores = new Map(); // Mapeia NOME -> TEMPO (em minutos)

// Mapeamentos para desvendar o Placar Oculto do Bedrock
const entitiesToNames = new Map(); // ID único da entidade -> Nome
const scoreToEntity = new Map();   // ID do Placar -> ID da Entidade

let mcClient = null;
let connecting = false;
let reconnectTimer = null;
let shuttingDown = false;
let heartbeatInterval = null;

let onlineChannelId = CONFIG.ONLINE_CHANNEL_ID;
let onlineMessageId = null;
let onlineInterval = null;
let updatingOnlineMessage = false;

let registrationChannelId = CONFIG.REGISTRATION_CHANNEL_ID;
let registrationInterval = null;
let sendingRegistration = false;

// ============================================================
// UTILITÁRIOS
// ============================================================

function privateReply() { return { flags: 64 }; }

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item), 2);
  } catch {
    return String(value);
  }
}

function clearPlayers() {
  jogadoresOnline.clear();
  temposJogadores.clear();
  entitiesToNames.clear();
  scoreToEntity.clear();
}

function playerNames() {
  return [...new Set(jogadoresOnline.values())]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function extractString(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    if (val.value != null) return String(val.value);
    if (typeof val.toString === 'function' && val.toString() !== '[object Object]') return val.toString();
  }
  return String(val);
}

function stripColors(str) {
  if (!str) return str;
  return str.replace(/§[0-9a-fk-or]/gi, '').trim();
}

function playerId(player) {
  const rawId = player?.uuid ?? player?.xuid ?? player?.xbox_user_id ?? player?.username ?? player?.name;
  const str = extractString(rawId);
  return str ? str.trim().toLowerCase() : null;
}

function playerName(player) {
  const rawName = player?.username ?? player?.name ?? player?.gamertag ?? player?.display_name;
  return extractString(rawName);
}

function packetRecords(packet) {
  if (Array.isArray(packet?.records?.records)) return packet.records.records;
  if (Array.isArray(packet?.records)) return packet.records;
  if (Array.isArray(packet?.entries)) return packet.entries;
  return [];
}

function isRemoveRecord(packet, record) {
  const type = record?.type ?? record?.action ?? packet?.records?.type ?? packet?.type ?? packet?.action;
  if (type === 1 || type === '1') return true;
  if (typeof type === 'string' && (type.toLowerCase().includes('remove') || type.toLowerCase().includes('delete'))) return true;
  return !playerName(record) && playerId(record);
}

function processPlayerList(packet) {
  const records = packetRecords(packet);
  if (!records.length) return;

  for (const record of records) {
    const id = playerId(record);
    const name = playerName(record);
    const removing = isRemoveRecord(packet, record);

    if (removing) {
      if (id) jogadoresOnline.delete(id);
      if (name) {
        for (const [key, savedName] of jogadoresOnline) {
          if (savedName.toLowerCase() === name.toLowerCase()) jogadoresOnline.delete(key);
        }
        temposJogadores.delete(name);
        for (const [entId, entName] of entitiesToNames) {
          if (entName.toLowerCase() === name.toLowerCase()) entitiesToNames.delete(entId);
        }
      }
    } else {
      if (id && name) {
        jogadoresOnline.set(id, name);
        // O servidor avisa globalmente qual é o entity_unique_id deste jogador assim que ele entra
        const entId = record.entity_unique_id ?? record.entity_id ?? record.runtime_entity_id;
        if (entId != null) {
          entitiesToNames.set(String(entId), name);
        }
      }
    }
  }

  console.log(`👥 Lista: ${playerNames().length} jogador(es)`);
  updateOnlineMessage();
}

// ============================================================
// EMBEDS
// ============================================================

function getPlayerListString() {
  const names = playerNames();
  if (!names.length) return 'Nenhum jogador online.';

  let list = names.map(name => {
    const tempo = temposJogadores.get(name);
    if (tempo !== undefined) {
      return `• ${name} — \`[${tempo} min]\``;
    }
    return `• ${name}`;
  }).join('\n');

  return list.length > 1024 ? `${list.slice(0, 1000)}\n...` : list;
}

function onlineEmbed() {
  const names = playerNames();
  const list = getPlayerListString();

  return new EmbedBuilder()
    .setColor('#00FF00')
    .setTitle('🟢 Jogadores online')
    .addFields(
      { name: '👥 Total', value: String(names.length), inline: true },
      { name: '🌐 Servidor', value: `\`${CONFIG.MC_HOST}:${CONFIG.MC_PORT}\``, inline: true },
      { name: '🎮 Versão', value: `\`${CONFIG.MC_VERSION}\``, inline: true },
      { name: '📜 Jogadores', value: list }
    )
    .setFooter({ text: 'Atualizado automaticamente a cada 30 segundos' })
    .setTimestamp();
}

function registrationEmbed() {
  const names = playerNames();
  const list = getPlayerListString();
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());

  return new EmbedBuilder()
    .setColor('#3498DB')
    .setTitle('📋 Registro de jogadores online')
    .addFields(
      { name: '👥 Total', value: String(names.length), inline: true },
      { name: '🕒 Horário', value: time, inline: true },
      { name: '📜 Jogadores', value: list }
    )
    .setFooter({ text: 'Novo registro a cada 45 segundos' })
    .setTimestamp();
}

// ============================================================
// DISCORD
// ============================================================

async function updateOnlineMessage() {
  if (!onlineChannelId || updatingOnlineMessage || !discordClient.isReady()) return;
  updatingOnlineMessage = true;
  try {
    const channel = await discordClient.channels.fetch(onlineChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    let message = null;
    if (onlineMessageId) {
      try { message = await channel.messages.fetch(onlineMessageId); } catch { message = null; }
    }

    if (message) await message.edit({ embeds: [onlineEmbed()] });
    else { message = await channel.send({ embeds: [onlineEmbed()] }); onlineMessageId = message.id; }
  } catch (error) {
    console.error('❌ Erro ao atualizar status:', error.message);
  } finally {
    updatingOnlineMessage = false;
  }
}

function startOnlineUpdates() {
  if (onlineInterval) clearInterval(onlineInterval);
  if (!onlineChannelId) return;
  updateOnlineMessage();
  onlineInterval = setInterval(updateOnlineMessage, 30000);
}

function stopOnlineUpdates() {
  if (onlineInterval) clearInterval(onlineInterval);
  onlineInterval = null;
  onlineChannelId = null;
  onlineMessageId = null;
}

async function sendRegistration() {
  if (!registrationChannelId || sendingRegistration || !discordClient.isReady()) return;
  sendingRegistration = true;
  try {
    const channel = await discordClient.channels.fetch(registrationChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    await channel.send({ embeds: [registrationEmbed()] });
  } catch (error) {
    console.error('❌ Erro ao enviar registro:', error.message);
  } finally {
    sendingRegistration = false;
  }
}

function startRegistration() {
  if (registrationInterval) clearInterval(registrationInterval);
  if (!registrationChannelId) return;
  sendRegistration();
  registrationInterval = setInterval(sendRegistration, 45000);
}

function stopRegistration() {
  if (registrationInterval) clearInterval(registrationInterval);
  registrationInterval = null;
  registrationChannelId = null;
}

// ============================================================
// BEDROCK
// ============================================================

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  console.log(`🔄 Nova tentativa Bedrock em ${RECONNECT_DELAY / 1000}s...`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectBedrock(); }, RECONNECT_DELAY);
}

function connectBedrock() {
  if (shuttingDown || connecting) return;
  connecting = true;

  let client;
  try {
    client = bedrock.createClient({
      host: CONFIG.MC_HOST,
      port: CONFIG.MC_PORT,
      username: CONFIG.MC_USERNAME,
      version: CONFIG.MC_VERSION,
      offline: CONFIG.MC_OFFLINE,
      connectTimeout: 15000,
      onMsaCode: data => {
        console.log(`🌐 Acesse: ${data.verification_uri}`);
        console.log(`🔑 Código: ${data.user_code}`);
      }
    });

    mcClient = client;

    client.on('join', () => { connecting = false; console.log('✅ Bot entrou no servidor Bedrock.'); });
    client.on('player_list', packet => processPlayerList(packet));

    // 🎯 Captura a relação de Placares (Scoreboards) e Jogadores Globalmente
    client.on('set_scoreboard_identity', packet => {
      if (packet.action === 0) { // 0 = Registrar identidade ao Placar
        for (const entry of packet.entries) {
          if (entry.scoreboard_id != null && entry.entity_unique_id != null) {
            scoreToEntity.set(String(entry.scoreboard_id), String(entry.entity_unique_id));
          }
        }
      }
    });

    // 🎯 Captura e atualiza o número de tempo
    client.on('set_score', packet => {
      if (packet.action !== 0) return; // 0 = Atualização de valor

      for (const entry of packet.entries) {
        let playerName = null;

        const rawEntId = entry.entity_unique_id != null ? String(entry.entity_unique_id) : null;
        const scoreId = entry.scoreboard_id != null ? String(entry.scoreboard_id) : null;

        // Tenta achar o nome pela Entidade Direta
        if (rawEntId && rawEntId !== '0') playerName = entitiesToNames.get(rawEntId);
        
        // Tenta achar pelo mapeamento que o scoreboard_identity revelou
        if (!playerName && scoreId) {
          const mappedEnt = scoreToEntity.get(scoreId);
          if (mappedEnt) playerName = entitiesToNames.get(mappedEnt);
        }

        // Tenta achar por um nome falso direto na lista (usado muito em PocketMine)
        if (!playerName && entry.custom_name) {
          const cName = stripColors(extractString(entry.custom_name));
          playerName = playerNames().find(n => n.toLowerCase() === cName.toLowerCase());
        }

        if (playerName) temposJogadores.set(playerName, entry.score);
      }
    });

    client.on('error', error => { if (!error?.partialReadError) console.error('⚠️ Erro Bedrock:', error.message); });
    client.on('close', () => { connecting = false; if (mcClient === client) { mcClient = null; clearPlayers(); } scheduleReconnect(); });
  } catch (error) {
    connecting = false; mcClient = null; scheduleReconnect();
  }
}

// ============================================================
// COMANDOS
// ============================================================

const commands = [
  new SlashCommandBuilder().setName('online').setDescription('Mostra os jogadores online'),
  new SlashCommandBuilder()
    .setName('configurar-online').setDescription('Escolhe o canal do status')
    .addChannelOption(option => option.setName('canal').setDescription('Canal de status').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('parar-online').setDescription('Para o status automático'),
  new SlashCommandBuilder()
    .setName('configurar-registro').setDescription('Escolhe o canal dos registros')
    .addChannelOption(option => option.setName('canal').setDescription('Canal de registros').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('parar-registro').setDescription('Para os registros')
].map(command => command.setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString()).toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
}

discordClient.once(Events.ClientReady, async client => {
  console.log(`🤖 Discord conectado como ${client.user.tag}`);
  try {
    await registerCommands(); connectBedrock();
    if (onlineChannelId) startOnlineUpdates();
    if (registrationChannelId) startRegistration();
  } catch (error) { console.error('❌ Erro na inicialização:', error); }
});

discordClient.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Apenas administradores podem usar os comandos.', ...privateReply() });

  if (interaction.commandName === 'online') return interaction.reply({ embeds: [onlineEmbed()] });
  if (interaction.commandName === 'configurar-online') {
    onlineChannelId = interaction.options.getChannel('canal').id; onlineMessageId = null; startOnlineUpdates();
    return interaction.reply({ content: `✅ Status configurado.`, ...privateReply() });
  }
  if (interaction.commandName === 'parar-online') { stopOnlineUpdates(); return interaction.reply({ content: '✅ Status parado.', ...privateReply() }); }
  if (interaction.commandName === 'configurar-registro') {
    registrationChannelId = interaction.options.getChannel('canal').id; startRegistration();
    return interaction.reply({ content: `✅ Registros configurados.`, ...privateReply() });
  }
  if (interaction.commandName === 'parar-registro') { stopRegistration(); return interaction.reply({ content: '✅ Registros parados.', ...privateReply() }); }
});

discordClient.on(Events.Error, error => console.error('❌ Erro Discord:', error));

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => console.log(`💓 Bot ativo | Jogadores: ${playerNames().length}`), 30000);
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (onlineInterval) clearInterval(onlineInterval);
  if (registrationInterval) clearInterval(registrationInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  try { mcClient?.close(); } catch (e) {}
  try { discordClient.destroy(); } catch (e) {}
  process.exit(exitCode);
}

startHeartbeat();
discordClient.login(CONFIG.DISCORD_TOKEN).catch(() => shutdown('falha no login', 1));
process.on('uncaughtException', () => shutdown('uncaughtException', 1));
process.on('unhandledRejection', () => shutdown('unhandledRejection', 1));
process.on('SIGTERM', () => shutdown('SIGTERM recebido', 0));
process.on('SIGINT', () => shutdown('SIGINT recebido', 0));
