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
// ESTADO
// ============================================================

const jogadoresOnline = new Map();

let mcClient = null;
let connecting = false;
let reconnectTimer = null;
let shuttingDown = false;
let listInterval = null;

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
}

function playerNames() {
  return [...new Set(jogadoresOnline.values())]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// Remove códigos de cores/formatação do Minecraft (ex: §a, §f, §r)
function cleanFormatting(str) {
  return str.replace(/§[0-9a-fk-or]/gi, '').trim();
}

// Processa o retorno em texto do comando /list
function parseListResponse(packet) {
  let text = '';

  if (packet.parameters && Array.isArray(packet.parameters)) {
    text = packet.parameters.map(p => cleanFormatting(String(p))).join(' ');
  } else if (packet.message) {
    text = cleanFormatting(packet.message);
  }

  if (!text) return;

  // Filtra apenas mensagens relacionadas à contagem/lista de jogadores
  const isListResponse = /online|jogadores|players|há|there are/i.test(text);
  if (!isListResponse) return;

  const parts = text.split(':');
  if (parts.length > 1) {
    const namesText = parts.slice(1).join(':').trim();
    if (namesText) {
      const rawNames = namesText.split(',').map(n => n.trim()).filter(Boolean);
      jogadoresOnline.clear();
      for (const name of rawNames) {
        const cleanName = name.replace(/^•\s*/, '').trim();
        if (cleanName && cleanName.toLowerCase() !== 'nenhum') {
          jogadoresOnline.set(cleanName, cleanName);
        }
      }
    } else {
      jogadoresOnline.clear();
    }
  } else if (/0\s*online|0\s*jogadores|nenhum|no players/i.test(text)) {
    jogadoresOnline.clear();
  }
}

// ============================================================
// COMANDO /LIST A CADA 2 SEGUNDOS
// ============================================================

function startListInterval() {
  if (listInterval) clearInterval(listInterval);

  listInterval = setInterval(() => {
    if (mcClient) {
      try {
        mcClient.queue('command_request', {
          command: '/list',
          origin: {
            type: 'player',
            uuid: mcClient.uuid || '',
            request_id: ''
          },
          internal: false
        });
      } catch (err) {
        // Ignora erros pontuais de envio na fila
      }
    }
  }, 2000);

  console.log('⏱️ Envio do /list a cada 2 segundos iniciado.');
}

function stopListInterval() {
  if (listInterval) clearInterval(listInterval);
  listInterval = null;
}

// ============================================================
// EMBEDS
// ============================================================

function onlineEmbed(realOnlineCount) {
  const names = playerNames();
  let list = names.length ? names.map(name => `• ${name}`).join('\n') : 'Nenhum jogador online.';
  if (list.length > 1024) list = `${list.slice(0, 1000)}\n...`;

  const totalDisplay = realOnlineCount !== undefined ? String(realOnlineCount) : String(names.length);

  return new EmbedBuilder()
    .setColor('#00FF00')
    .setTitle('🟢 Jogadores online')
    .addFields(
      { name: '👥 Total', value: totalDisplay, inline: true },
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

    if (!message) {
      const recentMessages = await channel.messages.fetch({ limit: 10 });
      message = recentMessages.find(m => m.author.id === discordClient.user.id);
      if (message) onlineMessageId = message.id;
    }

    const embed = onlineEmbed(jogadoresOnline.size);
    if (message) {
      await message.edit({ embeds: [embed] });
    } else {
      message = await channel.send({ embeds: [embed] });
      onlineMessageId = message.id;
    }

    console.log(`🔄 Status atualizado no Discord (${jogadoresOnline.size} jogadores).`);
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
// BEDROCK: RECONEXÃO E EVENTOS
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
      startListInterval();
    });

    // Intercepta as respostas de texto do servidor (incluindo o /list)
    client.on('text', packet => {
      parseListResponse(packet);
    });

    client.on('kick', packet => console.error('🚫 Bot expulso:', safeStringify(packet)));
    client.on('disconnect', packet => console.error('🚫 Desconexão enviada pelo servidor:', safeStringify(packet)));

    client.on('error', error => {
      if (error?.partialReadError) {
        console.warn('⚠️ Pacote incompatível ignorado:', error.message);
        return;
      }
      console.error('⚠️ Erro Bedrock:', error);
    });

    client.on('close', reason => {
      console.error('🔌 Conexão Bedrock fechada:', safeStringify(reason));
      connecting = false;
      stopListInterval();
      if (mcClient === client) {
        mcClient = null;
        clearPlayers();
      }
      scheduleReconnect();
    });
  } catch (error) {
    connecting = false;
    mcClient = null;
    stopListInterval();
    console.error('❌ Falha ao criar cliente Bedrock:', error);
    scheduleReconnect();
  }
}

// ============================================================
// COMANDOS DISCORD
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
    await interaction.reply({ embeds: [onlineEmbed(jogadoresOnline.size)] });
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

discordClient.login(CONFIG.DISCORD_TOKEN).catch(error => {
  console.error('❌ Falha no login do Discord:', error);
});

process.on('uncaughtException', error => {
  console.error('❌ Erro não tratado:', error);
});

process.on('unhandledRejection', error => {
  console.error('❌ Promise rejeitada:', error);
});
