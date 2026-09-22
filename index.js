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
// ESTADO E MAPEAMENTOS
// ============================================================

const jogadoresOnline = new Map();
const temposJogadores = new Map(); // Mapeia NOME -> TEMPO (em minutos)
const entitiesToNames = new Map(); // Mapeia ID DA ENTIDADE -> NOME

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

function privateReply() {
  return { flags: 64 };
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  );
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return `${item}n`;
      return item;
    }, 2);
  } catch {
    return String(value);
  }
}

function clearPlayers() {
  jogadoresOnline.clear();
  temposJogadores.clear();
  entitiesToNames.clear();
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
    if (typeof val.toString === 'function' && val.toString() !== '[object Object]') {
      return val.toString();
    }
  }
  return String(val);
}

function playerId(player) {
  const rawId = player?.uuid ?? player?.xuid ?? player?.xbox_user_id ??
    player?.entity_unique_id ?? player?.entity_runtime_id ??
    player?.username ?? player?.name ?? player?.gamertag;

  const str = extractString(rawId);
  return str ? str.trim().toLowerCase() : null;
}

function playerName(player) {
  const rawName = player?.username ?? player?.name ??
    player?.gamertag ?? player?.display_name ??
    player?.skin_data?.display_name ?? player?.player_name;

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
  if (typeof type === 'string') {
    const lower = type.toLowerCase();
    if (lower.includes('remove') || lower.includes('delete')) return true;
  }

  const hasName = Boolean(playerName(record));
  const hasId = Boolean(playerId(record));
  if (!hasName && hasId) {
    return true;
  }

  return false;
}

function processPlayerList(packet) {
  const records = packetRecords(packet);
  if (!records.length) {
    return;
  }

  for (const record of records) {
    const id = playerId(record);
    const name = playerName(record);
    const removing = isRemoveRecord(packet, record);

    if (removing) {
      if (id) jogadoresOnline.delete(id);
      if (name) {
        for (const [key, savedName] of jogadoresOnline) {
          if (savedName.toLowerCase() === name.toLowerCase()) {
            jogadoresOnline.delete(key);
          }
        }
        
        // Remove os dados do jogador ao desconectar
        temposJogadores.delete(name);
        for (const [entId, entName] of entitiesToNames) {
          if (entName.toLowerCase() === name.toLowerCase()) {
            entitiesToNames.delete(entId);
          }
        }
      }
    } else {
      if (id && name) {
        jogadoresOnline.set(id, name);
        // Salva o ID da entidade para parear com os pontos do Scoreboard depois
        if (record.entity_unique_id != null) {
          entitiesToNames.set(String(record.entity_unique_id), name);
        }
      }
    }
  }

  console.log(`👥 Lista: ${playerNames().length} jogador(es)`);
  updateOnlineMessage();
}

// ============================================================
// EMBEDS COM TEMPO
// ============================================================

function getPlayerListString() {
  const names = playerNames();
  if (!names.length) return 'Nenhum jogador online.';

  let list = names.map(name => {
    const tempo = temposJogadores.get(name);
    // Se o bot conseguiu capturar o tempo no placar, exibe ao lado do nome
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

  const time = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium'
  }).format(new Date());

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
// DISCORD: STATUS E REGISTROS
// ============================================================

async function updateOnlineMessage() {
  if (!onlineChannelId || updatingOnlineMessage || !discordClient.isReady()) return;
  updatingOnlineMessage = true;

  try {
    const channel = await discordClient.channels.fetch(onlineChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.error('❌ Canal de status inválido.');
      return;
    }

    let message = null;
    if (onlineMessageId) {
      try { message = await channel.messages.fetch(onlineMessageId); } catch { message = null; }
    }

    if (message) {
      await message.edit({ embeds: [onlineEmbed()] });
    } else {
      message = await channel.send({ embeds: [onlineEmbed()] });
      onlineMessageId = message.id;
    }
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
  console.log('🔄 Status automático a cada 30 segundos.');
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
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.error('❌ Canal de registros inválido.');
      return;
    }
    await channel.send({ embeds: [registrationEmbed()] });
    console.log('📝 Novo registro acumulativo enviado.');
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
  console.log('📝 Registros automáticos a cada 45 segundos.');
}

function stopRegistration() {
  if (registrationInterval) clearInterval(registrationInterval);
  registrationInterval = null;
  registrationChannelId = null;
}

// ============================================================
// BEDROCK: RECONEXÃO E LEITURA DE PLACARES
// ============================================================

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;

  console.log(`🔄 Nova tentativa Bedrock em ${RECONNECT_DELAY / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBedrock();
  }, RECONNECT_DELAY);
}

function connectBedrock() {
  if (shuttingDown || connecting) return;
  connecting = true;

  console.log(`🔄 Conectando a ${CONFIG.MC_HOST}:${CONFIG.MC_PORT} (${CONFIG.MC_VERSION})...`);

  let client;
  try {
    client = bedrock.createClient({
      host: CONFIG.MC_HOST,
      port: CONFIG.MC_PORT,
      username: CONFIG.MC_USERNAME,
      version: CONFIG.MC_VERSION,
      offline: CONFIG.MC_OFFLINE,
      connectTimeout: 15000,
      conLog: console.log,
      onMsaCode: data => {
        console.log('🔐 Autenticação Microsoft necessária.');
        console.log(`🌐 Acesse: ${data.verification_uri}`);
        console.log(`🔑 Código: ${data.user_code}`);
      }
    });

    mcClient = client;

    client.on('connect_allowed', () => console.log('✅ RakNet permitido.'));
    client.on('join', () => {
      connecting = false;
      console.log('✅ Bot entrou no servidor Bedrock.');
    });
    client.on('spawn', () => {
      connecting = false;
      console.log('✅ Bot apareceu no mundo.');
    });
    client.on('player_list', packet => {
      processPlayerList(packet);
    });

    // 🏆 ESCUTANDO O PLACAR (SCOREBOARD) PARA LER O TEMPO
    client.on('set_score', packet => {
      if (packet.action !== 0) return; // 0 significa adicionar/atualizar placar

      for (const entry of packet.entries) {
        let playerName = null;

        // Tipo 1 ou 2 significa que o placar está atrelado à Entidade do Jogador
        if ((entry.identity_type === 1 || entry.identity_type === 2) && entry.entity_unique_id != null) {
          playerName = entitiesToNames.get(String(entry.entity_unique_id));
        } 
        // Tipo 3 é um nome falso em texto (muito usado em sidebars customizadas de Bedrock)
        else if (entry.identity_type === 3 && entry.custom_name) {
          const cName = extractString(entry.custom_name);
          // Procura se tem algum player online com esse nome exato do placar
          playerName = playerNames().find(n => n.toLowerCase() === cName.toLowerCase());
        }

        if (playerName) {
          temposJogadores.set(playerName, entry.score);
        }
      }
    });

    client.on('kick', packet => console.error('🚫 Bot expulso:', safeStringify(packet)));
    client.on('disconnect', packet => console.error('🚫 Desconexão enviada:', safeStringify(packet)));

    client.on('error', error => {
      if (error?.partialReadError) return;
      console.error('⚠️ Erro Bedrock:', error);
    });

    client.on('close', reason => {
      console.error('🔌 Conexão Bedrock fechada:', safeStringify(reason));
      connecting = false;
      if (mcClient === client) {
        mcClient = null;
        clearPlayers();
      }
      scheduleReconnect();
    });
  } catch (error) {
    connecting = false;
    mcClient = null;
    console.error('❌ Falha ao criar cliente Bedrock:', error);
    scheduleReconnect();
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
  console.log('✅ Comandos registrados.');
}

discordClient.once(Events.ClientReady, async client => {
  console.log(`🤖 Discord conectado como ${client.user.tag}`);
  try {
    await registerCommands();
    connectBedrock();
    if (onlineChannelId) startOnlineUpdates();
    if (registrationChannelId) startRegistration();
  } catch (error) {
    console.error('❌ Erro na inicialização:', error);
  }
});

discordClient.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: '❌ Apenas administradores podem usar os comandos.',
      ...privateReply()
    });
    return;
  }

  if (interaction.commandName === 'online') {
    await interaction.reply({ embeds: [onlineEmbed()] });
    return;
  }

  if (interaction.commandName === 'configurar-online') {
    const channel = interaction.options.getChannel('canal');
    onlineChannelId = channel.id;
    onlineMessageId = null;
    startOnlineUpdates();
    await interaction.reply({
      content: `✅ Status configurado em ${channel} e enviado imediatamente.`,
      ...privateReply()
    });
    return;
  }

  if (interaction.commandName === 'parar-online') {
    stopOnlineUpdates();
    await interaction.reply({ content: '✅ Status parado.', ...privateReply() });
    return;
  }

  if (interaction.commandName === 'configurar-registro') {
    const channel = interaction.options.getChannel('canal');
    registrationChannelId = channel.id;
    startRegistration();
    await interaction.reply({
      content: `✅ Registros configurados em ${channel}.`,
      ...privateReply()
    });
    return;
  }

  if (interaction.commandName === 'parar-registro') {
    stopRegistration();
    await interaction.reply({ content: '✅ Registros parados.', ...privateReply() });
  }
});

discordClient.on(Events.Error, error => console.error('❌ Erro Discord:', error));

// ============================================================
// SINAL DE VIDA E ENCERRAMENTO SEGURO
// ============================================================

function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  heartbeatInterval = setInterval(() => {
    console.log(
      `💓 Bot ativo | Discord: ${discordClient.isReady() ? 'online' : 'offline'} | ` +
      `Minecraft: ${mcClient ? 'conectado' : 'desconectado'} | ` +
      `Jogadores: ${playerNames().length}`
    );
  }, 30000);
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`🛑 Encerrando o processo: ${reason}`);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (onlineInterval) clearInterval(onlineInterval);
  if (registrationInterval) clearInterval(registrationInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  try {
    mcClient?.close();
  } catch (error) {
    console.error('⚠️ Erro ao fechar Minecraft:', error);
  }

  try {
    discordClient.destroy();
  } catch (error) {
    console.error('⚠️ Erro ao fechar Discord:', error);
  }

  process.exit(exitCode);
}

startHeartbeat();

discordClient.login(CONFIG.DISCORD_TOKEN).catch(error => {
  console.error('❌ Falha no login do Discord:', error);
  shutdown('falha no login do Discord', 1);
});

process.on('uncaughtException', error => {
  console.error('❌ Erro fatal não tratado:');
  console.error(error);
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', error => {
  console.error('❌ Promise rejeitada sem tratamento:');
  console.error(error);
  shutdown('unhandledRejection', 1);
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM recebido pelo Render', 0);
});

process.on('SIGINT', () => {
  shutdown('SIGINT recebido', 0);
});
