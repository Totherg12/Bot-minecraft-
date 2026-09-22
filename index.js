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

app.get('/', (_req, res) => res.status(200).send('Bot online!'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 HTTP ativo na porta ${PORT}`));

const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

// ============================================================
// ESTADO E BANCO DE DADOS TEMPORÁRIO (REDE DE ARRASTÃO)
// ============================================================

const jogadoresOnline = new Map(); // Nome -> { uuid, entityId }

// Placar Global
const globalScoreIdentity = new Map(); // scoreboard_id -> entity_unique_id
const globalScoreName = new Map();     // scoreboard_id -> custom_name (Nome fake)
const scoresByObjective = new Map();   // objective_name -> Map<scoreboard_id, score>
let listObjective = null;              // Qual o nome do placar que fica no menu de pausa

// Hologramas físicos (Fallback)
const temposPorHolograma = new Map();
const runtimeToNames = new Map();

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
function isAdmin(interaction) { return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator); }

function clearPlayers() {
  jogadoresOnline.clear();
  globalScoreIdentity.clear();
  globalScoreName.clear();
  scoresByObjective.clear();
  temposPorHolograma.clear();
  runtimeToNames.clear();
  listObjective = null;
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
  return extractString(rawId)?.trim().toLowerCase() || null;
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

// ============================================================
// CRUZAMENTO DE DADOS (ACHANDO O TEMPO DO JOGADOR)
// ============================================================

function getPlayerTime(playerName) {
  const pData = jogadoresOnline.get(playerName);
  const entId = pData ? pData.entityId : null;

  // 1. Tenta buscar no Placar Global
  // Se o servidor avisou que um dos placares é o "list" (menu de pausa), focamos nele.
  const objectivesToCheck = listObjective ? [listObjective] : [...scoresByObjective.keys()];

  for (const obj of objectivesToCheck) {
    const scores = scoresByObjective.get(obj);
    if (!scores) continue;

    for (const [sId, score] of scores.entries()) {
      // Método A: Verifica se o ID Físico da entidade bate
      if (entId && globalScoreIdentity.get(sId) === entId) return score;

      // Método B: Verifica se o servidor enviou o nome no placar
      const cName = globalScoreName.get(sId);
      if (cName && cName.toLowerCase().includes(playerName.toLowerCase())) return score;
    }
  }

  // 2. Fallback: Se o jogador estiver perto do bot e tiver holograma
  if (temposPorHolograma.has(playerName)) {
    return temposPorHolograma.get(playerName);
  }

  return undefined;
}

// ============================================================
// GERAÇÃO DOS EMBEDS (MENSAGENS)
// ============================================================

function getPlayerListString() {
  const names = [...jogadoresOnline.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (!names.length) return 'Nenhum jogador online.';

  let list = names.map(name => {
    const tempo = getPlayerTime(name);
    if (tempo !== undefined) {
      return `• ${name} — \`[${tempo} min]\``;
    }
    return `• ${name}`;
  }).join('\n');

  return list.length > 1024 ? `${list.slice(0, 1000)}\n...` : list;
}

function onlineEmbed() {
  const list = getPlayerListString();
  return new EmbedBuilder()
    .setColor('#00FF00')
    .setTitle('🟢 Jogadores online')
    .addFields(
      { name: '👥 Total', value: String(jogadoresOnline.size), inline: true },
      { name: '🌐 Servidor', value: `\`${CONFIG.MC_HOST}:${CONFIG.MC_PORT}\``, inline: true },
      { name: '🎮 Versão', value: `\`${CONFIG.MC_VERSION}\``, inline: true },
      { name: '📜 Jogadores', value: list }
    )
    .setFooter({ text: 'Atualizado automaticamente a cada 30 segundos' })
    .setTimestamp();
}

function registrationEmbed() {
  const list = getPlayerListString();
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());

  return new EmbedBuilder()
    .setColor('#3498DB')
    .setTitle('📋 Registro de jogadores online')
    .addFields(
      { name: '👥 Total', value: String(jogadoresOnline.size), inline: true },
      { name: '🕒 Horário', value: time, inline: true },
      { name: '📜 Jogadores', value: list }
    )
    .setFooter({ text: 'Novo registro a cada 45 segundos' })
    .setTimestamp();
}

// ============================================================
// CONEXÃO DISCORD
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
  } catch (error) {} finally { updatingOnlineMessage = false; }
}

function startOnlineUpdates() {
  if (onlineInterval) clearInterval(onlineInterval);
  if (!onlineChannelId) return;
  updateOnlineMessage();
  onlineInterval = setInterval(updateOnlineMessage, 30000);
}

function stopOnlineUpdates() {
  if (onlineInterval) clearInterval(onlineInterval);
  onlineInterval = null; onlineChannelId = null; onlineMessageId = null;
}

async function sendRegistration() {
  if (!registrationChannelId || sendingRegistration || !discordClient.isReady()) return;
  sendingRegistration = true;
  try {
    const channel = await discordClient.channels.fetch(registrationChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    await channel.send({ embeds: [registrationEmbed()] });
  } catch (error) {} finally { sendingRegistration = false; }
}

function startRegistration() {
  if (registrationInterval) clearInterval(registrationInterval);
  if (!registrationChannelId) return;
  sendRegistration();
  registrationInterval = setInterval(sendRegistration, 45000);
}

function stopRegistration() {
  if (registrationInterval) clearInterval(registrationInterval);
  registrationInterval = null; registrationChannelId = null;
}

// ============================================================
// CONEXÃO BEDROCK
// ============================================================

function processPlayerList(packet) {
  const records = packetRecords(packet);
  if (!records.length) return;

  for (const record of records) {
    const id = playerId(record);
    const name = playerName(record);
    const removing = isRemoveRecord(packet, record);

    if (removing) {
      if (name) jogadoresOnline.delete(name);
      else if (id) {
        for (const [n, data] of jogadoresOnline.entries()) {
          if (data.uuid === id) jogadoresOnline.delete(n);
        }
      }
    } else if (name) {
      const entId = record.entity_unique_id ?? record.entity_id ?? record.runtime_entity_id;
      jogadoresOnline.set(name, { uuid: id, entityId: entId != null ? String(entId) : null });
    }
  }
  updateOnlineMessage();
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
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

    // 🎯 Captura a criação de objetivos no Placar
    client.on('set_display_objective', packet => {
      console.log(`[DEBUG PLACAR] Servidor enviou objetivo: Slot '${packet.display_slot}' -> Nome '${packet.objective_name}'`);
      if (packet.display_slot === 'list') listObjective = packet.objective_name;
    });

    // 🎯 Captura TODOS os valores de placar enviados
    client.on('set_score', packet => {
      if (packet.action !== 0) return;
      for (const entry of packet.entries) {
        const obj = entry.objective_name;
        if (!scoresByObjective.has(obj)) scoresByObjective.set(obj, new Map());
        scoresByObjective.get(obj).set(String(entry.scoreboard_id), entry.score);

        if (entry.identity_type === 3 && entry.custom_name) {
          globalScoreName.set(String(entry.scoreboard_id), stripColors(extractString(entry.custom_name)));
        } else if (entry.entity_unique_id != null) {
          globalScoreIdentity.set(String(entry.scoreboard_id), String(entry.entity_unique_id));
        }
      }
    });

    // 🎯 Captura mapeamento de Identidades do Placar
    client.on('set_scoreboard_identity', packet => {
      if (packet.action !== 0) return;
      for (const entry of packet.entries) {
        if (entry.scoreboard_id != null && entry.entity_unique_id != null) {
          globalScoreIdentity.set(String(entry.scoreboard_id), String(entry.entity_unique_id));
        }
      }
    });

    // Fallback: Lendo hologramas na cabeça (se o bot vir alguém)
    client.on('add_player', packet => {
      const name = extractString(packet.username);
      if (name && packet.runtime_id) runtimeToNames.set(String(packet.runtime_id), name);
      if (name && packet.metadata) {
        for (const item of packet.metadata) {
          if (item.key === 4 || item.key === 'nametag') {
             const match = stripColors(extractString(item.value)).match(/([\d.,]+)\s*TEMPO/i);
             if (match) temposPorHolograma.set(name, match[1]);
          }
        }
      }
    });

    client.on('error', error => { if (!error?.partialReadError) console.error('⚠️ Erro Bedrock:', error.message); });
    client.on('close', () => { connecting = false; if (mcClient === client) { mcClient = null; clearPlayers(); } scheduleReconnect(); });
  } catch (error) {
    connecting = false; mcClient = null; scheduleReconnect();
  }
}

// ============================================================
// COMANDOS E INICIALIZAÇÃO DO DISCORD
// ============================================================

const commands = [
  new SlashCommandBuilder().setName('online').setDescription('Mostra os jogadores online'),
  new SlashCommandBuilder().setName('configurar-online').setDescription('Escolhe o canal do status').addChannelOption(opt => opt.setName('canal').setDescription('Canal').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('parar-online').setDescription('Para o status'),
  new SlashCommandBuilder().setName('configurar-registro').setDescription('Escolhe o canal dos registros').addChannelOption(opt => opt.setName('canal').setDescription('Canal').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('parar-registro').setDescription('Para os registros')
].map(command => command.setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString()).toJSON());

discordClient.once(Events.ClientReady, async client => {
  console.log(`🤖 Discord conectado como ${client.user.tag}`);
  try {
    await new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN).put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    connectBedrock();
    if (onlineChannelId) startOnlineUpdates();
    if (registrationChannelId) startRegistration();
  } catch (error) {}
});

discordClient.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Apenas administradores podem usar.', ...privateReply() });

  if (interaction.commandName === 'online') return interaction.reply({ embeds: [onlineEmbed()] });
  if (interaction.commandName === 'configurar-online') {
    onlineChannelId = interaction.options.getChannel('canal').id; onlineMessageId = null; startOnlineUpdates();
    return interaction.reply({ content: `✅ Status configurado.`, ...privateReply() });
  }
  if (interaction.commandName === 'parar-online') { stopOnlineUpdates(); return interaction.reply({ content: '✅ Parado.', ...privateReply() }); }
  if (interaction.commandName === 'configurar-registro') {
    registrationChannelId = interaction.options.getChannel('canal').id; startRegistration();
    return interaction.reply({ content: `✅ Registros configurados.`, ...privateReply() });
  }
  if (interaction.commandName === 'parar-registro') { stopRegistration(); return interaction.reply({ content: '✅ Parado.', ...privateReply() }); }
});

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => console.log(`💓 Bot ativo | Jogadores: ${jogadoresOnline.size}`), 30000);
}

startHeartbeat();
discordClient.login(CONFIG.DISCORD_TOKEN).catch(() => process.exit(1));
process.on('uncaughtException', () => {}); process.on('unhandledRejection', () => {});
