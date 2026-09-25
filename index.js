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
  REGISTRATION_CHANNEL_ID: process.env.REGISTRATION_CHANNEL_ID || null,
  CHAT_CHANNEL_ID: process.env.CHAT_CHANNEL_ID || null
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
  intents: [GatewayIntentBits.Guilds],
  ws: {
    handshakeTimeout: 30000
  },
  rest: {
    timeout: 30000
  }
});

discordClient.on('debug', message => {
  const safeMessage = String(message)
    .replace(/(Provided token:)\s*.*/i, '$1 [oculto]')
    .replace(/(token[\"']?\s*[:=]\s*).*/i, '$1[oculto]');

  console.log(`🔎 Discord debug: ${safeMessage}`);
});

discordClient.on('warn', message => {
  console.warn(`⚠️ Discord aviso: ${message}`);
});

discordClient.on('error', error => {
  console.error('❌ Erro Discord:', error);
});

discordClient.on('shardError', (error, shardId) => {
  console.error(`❌ Erro do Gateway Discord no shard ${shardId}:`, error);
});

discordClient.on('shardReconnecting', shardId => {
  console.log(`🔄 Discord reconectando no shard ${shardId}...`);
});

discordClient.on('shardDisconnect', (event, shardId) => {
  console.error(
    `🔌 Discord desconectado no shard ${shardId}. ` +
    `Código: ${event?.code || 'desconhecido'}`
  );
});

discordClient.on('shardReady', (shardId, unavailableGuilds) => {
  console.log(
    `✅ Gateway Discord pronto no shard ${shardId}. ` +
    `Guilds indisponíveis: ${unavailableGuilds?.size || 0}`
  );
});

// ============================================================
// ESTADO
// ============================================================

const jogadoresOnline = new Map();

let mcClient = null;
let connecting = false;
let reconnectTimer = null;
let bedrockStarted = false;
let discordLoginTimeout = null;
let discordReconnectTimer = null;
let discordLoginAttempts = 0;
let shuttingDown = false;
let heartbeatInterval = null;
let connectionWatchdog = null;
let connectionAttemptId = 0;

let onlineChannelId = CONFIG.ONLINE_CHANNEL_ID;
let onlineMessageId = null;
let onlineInterval = null;
let updatingOnlineMessage = false;

let registrationChannelId = CONFIG.REGISTRATION_CHANNEL_ID;
let registrationInterval = null;
let sendingRegistration = false;

let chatChannelId = CONFIG.CHAT_CHANNEL_ID;

// ============================================================
// UTILITÁRIOS (CORRIGIDOS)
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
}

function playerNames() {
  return [...new Set(jogadoresOnline.values())]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// Extrai strings com segurança, resolvendo objetos UUID do bedrock-protocol
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

// Verifica se o registro é de remoção de jogador
function isRemoveRecord(packet, record) {
  const type = record?.type ?? record?.action ?? packet?.records?.type ?? packet?.type ?? packet?.action;

  if (type === 1 || type === '1') return true;
  if (typeof type === 'string') {
    const lower = type.toLowerCase();
    if (lower.includes('remove') || lower.includes('delete')) return true;
  }

  // Fallback: No protocolo Bedrock, pacotes de remoção enviam apenas UUID e não possuem nome/username
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
    console.log('📦 player_list sem registros.');
    return;
  }

  for (const record of records) {
    const id = playerId(record);
    const name = playerName(record);
    const removing = isRemoveRecord(packet, record);

    if (removing) {
      if (id) {
        jogadoresOnline.delete(id);
      }
      if (name) {
        for (const [key, savedName] of jogadoresOnline) {
          if (savedName.toLowerCase() === name.toLowerCase()) {
            jogadoresOnline.delete(key);
          }
        }
      }
    } else {
      if (id && name) {
        jogadoresOnline.set(id, name);
      }
    }
  }

  console.log(`👥 Lista: ${playerNames().length} jogador(es)`, playerNames());
  updateOnlineMessage();
}

// ============================================================
// EMBEDS
// ============================================================

function onlineEmbed() {
  const names = playerNames();
  let list = names.length ? names.map(name => `• ${name}`).join('\n') : 'Nenhum jogador online.';
  if (list.length > 1024) list = `${list.slice(0, 1000)}\n...`;

  return new EmbedBuilder()
    .setColor('#00FF00')
    .setTitle('🟢 Jogadores online')
    .addFields(
      { name: '👥 Total', value: String(names.length), inline: true },
      { name: '🌐 Servidor', value: `\`${CONFIG.MC_HOST}:${CONFIG.MC_PORT}\``, inline: true },
      { name: '🎮 Versão', value: `\`${CONFIG.MC_VERSION}\``, inline: true },
      { name: '📜 Nicks', value: list }
    )
    .setFooter({ text: 'Atualizado automaticamente a cada 30 segundos' })
    .setTimestamp();
}

function registrationEmbed() {
  const names = playerNames();
  let list = names.length ? names.map(name => `• ${name}`).join('\n') : 'Nenhum jogador online.';
  if (list.length > 1024) list = `${list.slice(0, 1000)}\n...`;

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

    console.log(`🔄 Status atualizado com ${playerNames().length} jogador(es).`);
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
// BEDROCK: CHAT -> DISCORD
// ============================================================

function chatText(packet) {
  const message = extractString(packet?.message ?? packet?.text ?? packet?.content);
  if (!message || !message.trim()) return null;

  const sender = extractString(
    packet?.source_name ?? packet?.sourceName ?? packet?.sender ?? packet?.username
  );
  const type = extractString(packet?.type)?.toLowerCase();

  // Mensagens normais têm remetente. Para avisos do servidor, preserva o texto.
  if (sender && sender !== '[object Object]') return `**${sender}**: ${message.trim()}`;
  if (type?.includes('whisper') && packet?.source_name) {
    return `**${extractString(packet.source_name)}**: ${message.trim()}`;
  }
  return `**Servidor**: ${message.trim()}`;
}

async function forwardMinecraftChat(packet) {
  if (!chatChannelId || !discordClient.isReady()) return;

  const content = chatText(packet);
  if (!content) return;

  try {
    const channel = await discordClient.channels.fetch(chatChannelId);
    if (!channel || !channel.isTextBased()) {
      console.error('❌ Canal de chat inválido.');
      return;
    }

    // Limita o tamanho para respeitar o limite de mensagem do Discord.
    await channel.send({ content: `🎮 ${content}`.slice(0, 2000) });
  } catch (error) {
    console.error('❌ Erro ao encaminhar chat do Minecraft:', error.message);
  }
}

// ============================================================
// BEDROCK: RECONEXÃO
// ============================================================

const CONNECTION_WATCHDOG = 30000;

function clearConnectionWatchdog() {
  if (connectionWatchdog) {
    clearTimeout(connectionWatchdog);
    connectionWatchdog = null;
  }
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;

  console.log(`🔄 Nova tentativa Bedrock em ${RECONNECT_DELAY / 1000}s...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (!shuttingDown) {
      connectBedrock();
    }
  }, RECONNECT_DELAY);
}

function handleBedrockClosed(client, reason, destroyClient = false) {
  // Ignora eventos atrasados de uma conexão antiga
  if (mcClient !== client) return;

  clearConnectionWatchdog();

  // Impede que a tentativa antiga continue viva quando houver timeout/erro.
  // Sem isso, ela pode entrar no servidor depois que a nova tentativa já abriu,
  // causando o erro server_id_conflict.
  if (destroyClient) {
    try {
      client.removeAllListeners();
      client.close();
    } catch (error) {
      console.warn('⚠️ Erro ao fechar tentativa antiga:', error.message);
    }
  }

  connecting = false;
  mcClient = null;
  clearPlayers();

  console.error('🔌 Conexão Bedrock encerrada:', safeStringify(reason));

  // Atualiza imediatamente o Discord para mostrar 0 jogadores
  updateOnlineMessage();

  // Agenda nova tentativa mesmo quando o protocolo não emite "close"
  scheduleReconnect();
}

function connectBedrock() {
  if (shuttingDown || connecting) return;

  connecting = true;
  const attemptId = ++connectionAttemptId;
  let microsoftAuthPending = !CONFIG.MC_OFFLINE;
  let lastMsaCode = null;

  console.log(
    `🔄 Conectando a ${CONFIG.MC_HOST}:${CONFIG.MC_PORT} ` +
    `(${CONFIG.MC_VERSION})...`
  );

  let client;

  try {
    client = bedrock.createClient({
      host: CONFIG.MC_HOST,
      port: CONFIG.MC_PORT,
      username: CONFIG.MC_USERNAME,
      version: CONFIG.MC_VERSION,
      offline: CONFIG.MC_OFFLINE,
      profilesFolder: process.env.MC_PROFILES_FOLDER || './auth-cache',

      // Este timeout vale para o transporte Bedrock, não para o login Microsoft.
      connectTimeout: 15000,
      conLog: console.log,

      onMsaCode: data => {
        // Não repete o mesmo código caso a biblioteca o emita novamente.
        if (data.user_code === lastMsaCode) return;
        lastMsaCode = data.user_code;
        microsoftAuthPending = true;

        console.log('');
        console.log('🔐 Autenticação Microsoft necessária.');
        console.log(`🌐 Acesse: ${data.verification_uri}`);
        console.log(`🔑 Código: ${data.user_code}`);
        console.log(
          '⏳ Use este código imediatamente. Ele expira aproximadamente ' +
          '15 minutos após ser gerado.'
        );
        console.log('');
      }
    });

    mcClient = client;

    const armConnectionWatchdog = () => {
      clearConnectionWatchdog();

      connectionWatchdog = setTimeout(() => {
        if (mcClient === client && connecting && !microsoftAuthPending) {
          console.error(
            `⏱️ Timeout ao conectar ao Bedrock após ` +
            `${CONNECTION_WATCHDOG / 1000}s.`
          );

          handleBedrockClosed(client, 'timeout de conexão', true);
        }
      }, CONNECTION_WATCHDOG);
    };

    // Não iniciar o watchdog durante a autenticação Microsoft.
    clearConnectionWatchdog();

    client.once('session', () => {
      // O token Microsoft foi obtido; agora começa o prazo do transporte.
      microsoftAuthPending = false;
      armConnectionWatchdog();
    });

    client.on('connect_allowed', () => {
      console.log('✅ RakNet permitido.');
    });

    client.on('join', () => {
      connecting = false;
      microsoftAuthPending = false;
      clearConnectionWatchdog();
      console.log('✅ Bot entrou no servidor Bedrock.');
    });

    client.on('spawn', () => {
      connecting = false;
      microsoftAuthPending = false;
      clearConnectionWatchdog();
      console.log('✅ Bot apareceu no mundo.');
    });

    client.on('player_list', packet => {
      console.log('📋 player_list recebido.');
      processPlayerList(packet);
    });

    client.on('text', packet => {
      console.log('💬 Chat recebido:', safeStringify(packet));
      forwardMinecraftChat(packet);
    });

    client.on('kick', packet => {
      console.error('🚫 Bot expulso:', safeStringify(packet));
    });

    client.on('disconnect', packet => {
      console.error(
        '🚫 Desconexão enviada pelo servidor:',
        safeStringify(packet)
      );
    });

    client.on('error', error => {
      if (error?.partialReadError) {
        console.warn('⚠️ Pacote incompatível ignorado:', error.message);
        return;
      }

      const errorText = String(error?.message || error);

      if (microsoftAuthPending) {
        console.error('⚠️ Erro durante a autenticação Microsoft:', errorText);
        console.error(
          'A tentativa atual será encerrada pela biblioteca; ' +
          'não será criada outra enquanto este login estiver ativo.'
        );
        return;
      }

      console.error('⚠️ Erro Bedrock:', error);

      /*
       * Se o erro ocorreu depois da autenticação, libera o estado e reconecta.
       * Durante o login Microsoft, o evento error não cria outra tentativa.
       */
      if (connecting) {
        handleBedrockClosed(client, 'erro durante a conexão', true);
      }
    });

    client.on('close', reason => {
      // Somente a tentativa atual pode alterar o estado e reconectar.
      if (attemptId === connectionAttemptId) {
        handleBedrockClosed(client, reason);
      }
    });
  } catch (error) {
    clearConnectionWatchdog();

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
  new SlashCommandBuilder().setName('parar-registro').setDescription('Para os registros'),
  new SlashCommandBuilder()
    .setName('configurar')
    .setDescription('Configura os canais do bot')
    .addSubcommand(subcommand => subcommand
      .setName('chat')
      .setDescription('Escolhe o canal que receberá o chat do Minecraft')
      .addChannelOption(option => option
        .setName('canal')
        .setDescription('Canal do chat do Minecraft')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))),
  new SlashCommandBuilder()
    .setName('parar')
    .setDescription('Desativa uma integração do bot')
    .addSubcommand(subcommand => subcommand
      .setName('chat')
      .setDescription('Para o encaminhamento do chat do Minecraft'))
].map(command => command.setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString()).toJSON());

function startBedrockOnce() {
  if (bedrockStarted || shuttingDown) return;

  bedrockStarted = true;
  console.log('🎮 Iniciando conexão Bedrock...');
  connectBedrock();
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
  console.log('✅ Comandos registrados.');
}

discordClient.once(Events.ClientReady, async client => {
  if (discordLoginTimeout) {
    clearTimeout(discordLoginTimeout);
    discordLoginTimeout = null;
  }
  if (discordReconnectTimer) {
    clearTimeout(discordReconnectTimer);
    discordReconnectTimer = null;
  }
  discordLoginAttempts = 0;

  console.log(`🤖 Discord conectado como ${client.user.tag}`);

  try {
    await registerCommands();

    if (onlineChannelId) startOnlineUpdates();
    if (registrationChannelId) startRegistration();
  } catch (error) {
    console.error('❌ Erro na inicialização do Discord:', error);
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
    return;
  }

  if (interaction.commandName === 'configurar' && interaction.options.getSubcommand() === 'chat') {
    const channel = interaction.options.getChannel('canal');
    chatChannelId = channel.id;
    await interaction.reply({
      content: `✅ Chat do Minecraft configurado em ${channel}. As próximas mensagens serão encaminhadas para lá.`,
      ...privateReply()
    });
    return;
  }

  if (interaction.commandName === 'parar' && interaction.options.getSubcommand() === 'chat') {
    chatChannelId = null;
    await interaction.reply({ content: '✅ Encaminhamento do chat parado.', ...privateReply() });
  }
});


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

  if (discordReconnectTimer) {
    clearTimeout(discordReconnectTimer);
    discordReconnectTimer = null;
  }

  if (discordLoginTimeout) {
    clearTimeout(discordLoginTimeout);
    discordLoginTimeout = null;
  }

  clearConnectionWatchdog();

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

function normalizedDiscordToken() {
  return CONFIG.DISCORD_TOKEN.trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^Bot\s+/i, '');
}

function scheduleDiscordLogin(reason) {
  if (shuttingDown || discordClient.isReady() || discordReconnectTimer) return;

  if (discordLoginTimeout) {
    clearTimeout(discordLoginTimeout);
    discordLoginTimeout = null;
  }

  console.error(`🔁 Reiniciando conexão do Gateway Discord: ${reason}`);

  try {
    discordClient.destroy();
  } catch (error) {
    console.warn('⚠️ Erro ao reiniciar o cliente Discord:', error.message);
  }

  const delay = Math.min(60000, 5000 * Math.max(1, discordLoginAttempts));
  discordReconnectTimer = setTimeout(() => {
    discordReconnectTimer = null;
    loginDiscord();
  }, delay);
}

function loginDiscord() {
  if (shuttingDown || discordClient.isReady()) return;

  discordLoginAttempts += 1;
  console.log(`🔐 Tentando conectar ao Discord (tentativa ${discordLoginAttempts})...`);

  discordLoginTimeout = setTimeout(() => {
    discordLoginTimeout = null;
    if (!discordClient.isReady()) {
      console.error(
        '⏱️ O Discord não chegou ao estado READY em 60 segundos; ' +
        'o Gateway será reiniciado automaticamente.'
      );
      scheduleDiscordLogin('timeout aguardando READY');
    }
  }, 60000);

  discordClient.login(normalizedDiscordToken())
    .then(() => {
      console.log('✅ Solicitação de login do Discord enviada.');
    })
    .catch(error => {
      if (discordLoginTimeout) {
        clearTimeout(discordLoginTimeout);
        discordLoginTimeout = null;
      }

      const code = error?.code ? ` [${error.code}]` : '';
      console.error(`❌ Falha no login do Discord${code}:`, error?.message || error);
      console.error(
        'Verifique se DISCORD_TOKEN contém apenas o token do bot, sem aspas ' +
        'e sem o prefixo "Bot ".'
      );
      if (error?.code === 'TokenInvalid' || error?.status === 401) {
        console.error('🛑 Retry automático desativado: corrija DISCORD_TOKEN no Render e faça um novo deploy.');
        return;
      }
      scheduleDiscordLogin('falha no login');
    });
}

// O login Microsoft do Minecraft não depende do Discord.
// Assim, o link microsoft.com/link aparece mesmo se o Discord
// estiver offline ou com problema de conexão.
startBedrockOnce();
loginDiscord();

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
