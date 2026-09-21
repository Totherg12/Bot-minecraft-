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
// SERVIDOR HTTP DO RENDER
// ============================================================

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.get('/', (req, res) => {
  res.status(200).send('Bot do Minecraft Bedrock online!');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,

  MC_HOST: process.env.MC_HOST || 'ultra-04.bedhosting.com.br',
  MC_PORT: Number(process.env.MC_PORT || 37116),
  MC_USERNAME: process.env.MC_USERNAME || 'BotStatus',

  // Seu fork experimental precisa aceitar esta versão.
  MC_VERSION: '1.26.51',

  // No seu servidor, false foi necessário.
  MC_OFFLINE: false,

  // Canal da mensagem única atualizada a cada 30 segundos.
  ONLINE_CHANNEL_ID: process.env.ONLINE_CHANNEL_ID || null,

  // Canal dos registros acumulativos a cada 45 segundos.
  REGISTRATION_CHANNEL_ID:
    process.env.REGISTRATION_CHANNEL_ID || null
};

if (!CONFIG.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN não foi configurado.');
  process.exit(1);
}

if (!CONFIG.CLIENT_ID) {
  console.error('❌ CLIENT_ID não foi configurado.');
  process.exit(1);
}

// ============================================================
// CLIENTE DO DISCORD
// ============================================================

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ============================================================
// ESTADO DO BOT
// ============================================================

const jogadoresOnline = new Map();

let mcClient = null;
let reconnectTimer = null;
let tentandoConectar = false;

// Mensagem única do status /configurar-online.
let canalAtualizacaoId = CONFIG.ONLINE_CHANNEL_ID;
let mensagemAtualizacaoId = null;
let intervaloAtualizacao = null;
let atualizandoMensagem = false;

// Registros acumulativos /configurar-registro.
let canalRegistroId = CONFIG.REGISTRATION_CHANNEL_ID;
let intervaloRegistro = null;
let registrandoJogadores = false;

// ============================================================
// FUNÇÕES DOS JOGADORES
// ============================================================

function obterIdJogador(jogador) {
  return (
    jogador.uuid ||
    jogador.xuid ||
    jogador.entity_unique_id ||
    jogador.entity_runtime_id ||
    jogador.username ||
    jogador.name
  );
}

function obterNomeJogador(jogador) {
  return (
    jogador.username ||
    jogador.name ||
    jogador.gamertag ||
    jogador.display_name ||
    null
  );
}

function obterNomesJogadores() {
  return [...new Set([...jogadoresOnline.values()])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function limparJogadores() {
  jogadoresOnline.clear();
}

function processarListaDeJogadores(packet) {
  if (!packet) {
    return;
  }

  const recordsContainer = packet.records || {};

  const registros = Array.isArray(recordsContainer.records)
    ? recordsContainer.records
    : Array.isArray(packet.records)
      ? packet.records
      : [];

  if (registros.length === 0) {
    return;
  }

  const tipo = recordsContainer.type ?? packet.type ?? 'add';

  const removendo =
    tipo === 'remove' ||
    tipo === 'REMOVE' ||
    tipo === 1;

  for (const jogador of registros) {
    const id = obterIdJogador(jogador);
    const nome = obterNomeJogador(jogador);

    if (!id) {
      continue;
    }

    const chave = String(id);

    if (removendo) {
      jogadoresOnline.delete(chave);
    } else if (nome) {
      jogadoresOnline.set(chave, nome);
    }
  }

  console.log(
    `👥 Jogadores detectados (${jogadoresOnline.size}):`,
    obterNomesJogadores().join(', ') || 'nenhum'
  );
}

// ============================================================
// EMBED DA MENSAGEM ONLINE
// ============================================================

function criarEmbedOnline() {
  const nomes = obterNomesJogadores();

  const lista = nomes.length > 0
    ? nomes.map(nome => `• ${nome}`).join('\n')
    : 'Nenhum jogador foi detectado ainda.';

  const listaLimitada = lista.length > 1024
    ? `${lista.substring(0, 1000)}\n...`
    : lista;

  return new EmbedBuilder()
    .setColor('#00FF00')
    .setTitle('🟢 Jogadores online')
    .addFields(
      {
        name: '👥 Total',
        value: String(nomes.length),
        inline: true
      },
      {
        name: '🌐 Servidor',
        value: `\`${CONFIG.MC_HOST}:${CONFIG.MC_PORT}\``,
        inline: true
      },
      {
        name: '🎮 Versão',
        value: `\`${CONFIG.MC_VERSION}\``,
        inline: true
      },
      {
        name: '📜 Nicks',
        value: listaLimitada
      }
    )
    .setFooter({
      text: 'Mensagem atualizada automaticamente a cada 30 segundos'
    })
    .setTimestamp();
}

// ============================================================
// EMBED DOS REGISTROS ACUMULATIVOS
// ============================================================

function criarEmbedRegistro() {
  const nomes = obterNomesJogadores();

  const lista = nomes.length > 0
    ? nomes.map(nome => `• ${nome}`).join('\n')
    : 'Nenhum jogador online.';

  const listaLimitada = lista.length > 1024
    ? `${lista.substring(0, 1000)}\n...`
    : lista;

  const horario = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(new Date());

  return new EmbedBuilder()
    .setColor('#3498DB')
    .setTitle('📋 Registro de jogadores online')
    .addFields(
      {
        name: '👥 Total online',
        value: String(nomes.length),
        inline: true
      },
      {
        name: '🕒 Horário',
        value: horario,
        inline: true
      },
      {
        name: '🌐 Servidor',
        value: `\`${CONFIG.MC_HOST}:${CONFIG.MC_PORT}\``,
        inline: true
      },
      {
        name: '📜 Jogadores',
        value: listaLimitada
      }
    )
    .setFooter({
      text: 'Registro acumulativo automático a cada 45 segundos'
    })
    .setTimestamp();
}

// ============================================================
// MENSAGEM ÚNICA ATUALIZADA A CADA 30 SEGUNDOS
// ============================================================

async function atualizarMensagemOnline() {
  if (!canalAtualizacaoId || atualizandoMensagem) {
    return;
  }

  atualizandoMensagem = true;

  try {
    const canal = await discordClient.channels.fetch(canalAtualizacaoId);

    if (!canal || canal.type !== ChannelType.GuildText) {
      console.error('❌ O canal de atualização não é válido.');
      return;
    }

    const embed = criarEmbedOnline();
    let mensagem = null;

    if (mensagemAtualizacaoId) {
      try {
        mensagem = await canal.messages.fetch(mensagemAtualizacaoId);
      } catch {
        mensagem = null;
      }
    }

    if (mensagem) {
      await mensagem.edit({
        embeds: [embed]
      });

      console.log('🔄 Mensagem online atualizada.');
    } else {
      mensagem = await canal.send({
        embeds: [embed]
      });

      mensagemAtualizacaoId = mensagem.id;

      console.log('✅ Mensagem online criada.');
    }
  } catch (error) {
    console.error('❌ Erro ao atualizar a mensagem online:');
    console.error(error.message);
  } finally {
    atualizandoMensagem = false;
  }
}

function iniciarAtualizacaoAutomatica() {
  if (intervaloAtualizacao) {
    clearInterval(intervaloAtualizacao);
    intervaloAtualizacao = null;
  }

  if (!canalAtualizacaoId) {
    console.log('ℹ️ Canal de atualização não configurado.');
    return;
  }

  atualizarMensagemOnline();

  intervaloAtualizacao = setInterval(() => {
    atualizarMensagemOnline();
  }, 30000);

  console.log('🔄 Status automático iniciado a cada 30 segundos.');
}

function pararAtualizacaoAutomatica() {
  if (intervaloAtualizacao) {
    clearInterval(intervaloAtualizacao);
    intervaloAtualizacao = null;
  }

  canalAtualizacaoId = null;
  mensagemAtualizacaoId = null;

  console.log('⏹️ Status automático parado.');
}

// ============================================================
// REGISTROS ACUMULATIVOS A CADA 45 SEGUNDOS
// ============================================================

async function registrarJogadoresOnline() {
  if (!canalRegistroId || registrandoJogadores) {
    return;
  }

  registrandoJogadores = true;

  try {
    const canal = await discordClient.channels.fetch(canalRegistroId);

    if (!canal || canal.type !== ChannelType.GuildText) {
      console.error('❌ O canal de registro não é válido.');
      return;
    }

    /*
     * IMPORTANTE:
     * canal.send() cria uma mensagem nova.
     * Não usamos message.edit() aqui.
     * Portanto, os registros ficam acumulados.
     */
    await canal.send({
      embeds: [criarEmbedRegistro()]
    });

    console.log('📝 Novo registro acumulativo enviado.');
  } catch (error) {
    console.error('❌ Erro ao enviar registro acumulativo:');
    console.error(error.message);
  } finally {
    registrandoJogadores = false;
  }
}

function iniciarRegistroAutomatico() {
  if (intervaloRegistro) {
    clearInterval(intervaloRegistro);
    intervaloRegistro = null;
  }

  if (!canalRegistroId) {
    console.log('ℹ️ Canal de registro não configurado.');
    return;
  }

  // Envia um registro imediatamente.
  registrarJogadoresOnline();

  // Depois envia uma nova mensagem a cada 45 segundos.
  intervaloRegistro = setInterval(() => {
    registrarJogadoresOnline();
  }, 45000);

  console.log('📝 Registro acumulativo iniciado a cada 45 segundos.');
}

function pararRegistroAutomatico() {
  if (intervaloRegistro) {
    clearInterval(intervaloRegistro);
    intervaloRegistro = null;
  }

  canalRegistroId = null;

  console.log('⏹️ Registro acumulativo parado.');
}

// ============================================================
// CONEXÃO COM O SERVIDOR BEDROCK
// ============================================================

function agendarReconexao() {
  if (reconnectTimer) {
    return;
  }

  console.log('🔌 Conexão Bedrock fechada.');
  console.log('🔄 Tentando reconectar em 10 segundos...');

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    conectarBedrock();
  }, 10000);
}

function conectarBedrock() {
  if (tentandoConectar) {
    return;
  }

  tentandoConectar = true;

  console.log('🔄 Conectando ao servidor Bedrock...');
  console.log(`🌐 Servidor: ${CONFIG.MC_HOST}:${CONFIG.MC_PORT}`);
  console.log(`🎮 Versão: ${CONFIG.MC_VERSION}`);
  console.log(`🔐 Autenticação online: ${!CONFIG.MC_OFFLINE}`);

  try {
    mcClient = bedrock.createClient({
      host: CONFIG.MC_HOST,
      port: CONFIG.MC_PORT,
      username: CONFIG.MC_USERNAME,

      /*
       * Seu fork experimental utiliza:
       * - nome da versão: 1.26.51;
       * - dados internos: 1.26.45;
       * - protocolo enviado: 2193.
       */
      version: CONFIG.MC_VERSION,

      // Seu servidor precisa de autenticação Microsoft.
      offline: CONFIG.MC_OFFLINE,

      connectTimeout: 15000,
      conLog: console.log,

      onMsaCode: (data) => {
        console.log('🔐 Autenticação Microsoft necessária.');
        console.log(`🌐 Acesse: ${data.verification_uri}`);
        console.log(`🔑 Código: ${data.user_code}`);
      }
    });

    mcClient.on('connect_allowed', () => {
      console.log('✅ Conexão RakNet permitida.');
    });

    mcClient.on('join', () => {
      tentandoConectar = false;
      console.log('✅ Bot entrou no servidor Bedrock!');
    });

    mcClient.on('spawn', () => {
      tentandoConectar = false;
      console.log('✅ Bot apareceu no mundo!');
    });

    // Atualiza a lista de jogadores.
    mcClient.on('player_list', (packet) => {
      processarListaDeJogadores(packet);
    });

    mcClient.on('kick', (packet) => {
      console.error('🚫 O servidor expulsou o bot:');
      console.error(packet);
    });

    mcClient.on('disconnect', (packet) => {
      console.error('🚫 O servidor enviou uma desconexão:');
      console.error(packet);
    });

    mcClient.on('error', (error) => {
      tentandoConectar = false;

      console.error('⚠️ Erro no protocolo Bedrock:');
      console.error(error);
    });

    mcClient.on('close', () => {
      tentandoConectar = false;
      mcClient = null;

      limparJogadores();
      agendarReconexao();
    });
  } catch (error) {
    tentandoConectar = false;

    console.error('❌ Erro ao criar o cliente Bedrock:');
    console.error(error);

    agendarReconexao();
  }
}

// ============================================================
// COMANDOS DO DISCORD
// ============================================================

const commands = [
  new SlashCommandBuilder()
    .setName('online')
    .setDescription('Mostra os jogadores online no Minecraft'),

  new SlashCommandBuilder()
    .setName('configurar-online')
    .setDescription('Escolhe o canal do status atualizado a cada 30 segundos')
    .addChannelOption(option =>
      option
        .setName('canal')
        .setDescription('Canal onde o status será atualizado')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator.toString()
    ),

  new SlashCommandBuilder()
    .setName('parar-online')
    .setDescription('Para o status automático')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator.toString()
    ),

  new SlashCommandBuilder()
    .setName('configurar-registro')
    .setDescription('Escolhe o canal dos registros acumulativos')
    .addChannelOption(option =>
      option
        .setName('canal')
        .setDescription('Canal onde os registros serão enviados')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator.toString()
    ),

  new SlashCommandBuilder()
    .setName('parar-registro')
    .setDescription('Para os registros acumulativos')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator.toString()
    )
].map(command => command.toJSON());

async function registrarComandos() {
  const rest = new REST({ version: '10' })
    .setToken(CONFIG.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(CONFIG.CLIENT_ID),
      {
        body: commands
      }
    );

    console.log('✅ Comandos do Discord registrados.');
  } catch (error) {
    console.error('❌ Erro ao registrar os comandos:');
    console.error(error);
  }
}

// ============================================================
// EVENTOS DO DISCORD
// ============================================================

discordClient.once(Events.ClientReady, async (client) => {
  console.log(`🤖 Discord conectado como ${client.user.tag}`);

  await registrarComandos();

  conectarBedrock();

  if (canalAtualizacaoId) {
    iniciarAtualizacaoAutomatica();
  }

  if (canalRegistroId) {
    iniciarRegistroAutomatico();
  }
});

discordClient.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  // ==========================================================
  // /online
  // ==========================================================

  if (interaction.commandName === 'online') {
    await interaction.reply({
      embeds: [criarEmbedOnline()]
    });

    return;
  }

  // ==========================================================
  // /configurar-online
  // ==========================================================

  if (interaction.commandName === 'configurar-online') {
    const podeConfigurar =
      interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator
      );

    if (!podeConfigurar) {
      await interaction.reply({
        content: '❌ Apenas administradores podem escolher esse canal.',
        ephemeral: true
      });

      return;
    }

    const canal = interaction.options.getChannel('canal');

    if (!canal || canal.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: '❌ Escolha um canal de texto válido.',
        ephemeral: true
      });

      return;
    }

    canalAtualizacaoId = canal.id;
    mensagemAtualizacaoId = null;

    iniciarAtualizacaoAutomatica();

    await interaction.reply({
      content:
        `✅ O status será atualizado a cada 30 segundos em ${canal}.`,
      ephemeral: true
    });

    return;
  }

  // ==========================================================
  // /parar-online
  // ==========================================================

  if (interaction.commandName === 'parar-online') {
    const podeConfigurar =
      interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator
      );

    if (!podeConfigurar) {
      await interaction.reply({
        content: '❌ Apenas administradores podem parar esse status.',
        ephemeral: true
      });

      return;
    }

    pararAtualizacaoAutomatica();

    await interaction.reply({
      content: '✅ O status automático foi parado.',
      ephemeral: true
    });

    return;
  }

  // ==========================================================
  // /configurar-registro
  // ==========================================================

  if (interaction.commandName === 'configurar-registro') {
    const eAdministrador =
      interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator
      );

    if (!eAdministrador) {
      await interaction.reply({
        content:
          '❌ Apenas administradores podem escolher o canal de registro.',
        ephemeral: true
      });

      return;
    }

    const canal = interaction.options.getChannel('canal');

    if (!canal || canal.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: '❌ Escolha um canal de texto válido.',
        ephemeral: true
      });

      return;
    }

    canalRegistroId = canal.id;

    iniciarRegistroAutomatico();

    await interaction.reply({
      content:
        `✅ Canal de registro definido como ${canal}.\n` +
        'Um novo registro será enviado a cada 45 segundos.',
      ephemeral: true
    });

    return;
  }

  // ==========================================================
  // /parar-registro
  // ==========================================================

  if (interaction.commandName === 'parar-registro') {
    const eAdministrador =
      interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator
      );

    if (!eAdministrador) {
      await interaction.reply({
        content:
          '❌ Apenas administradores podem parar os registros.',
        ephemeral: true
      });

      return;
    }

    pararRegistroAutomatico();

    await interaction.reply({
      content: '✅ Os registros acumulativos foram parados.',
      ephemeral: true
    });
  }
});

discordClient.on(Events.Error, (error) => {
  console.error('❌ Erro no cliente do Discord:');
  console.error(error);
});

// ============================================================
// LOGIN DO DISCORD
// ============================================================

discordClient
  .login(CONFIG.DISCORD_TOKEN)
  .then(() => {
    console.log('🔄 Login do Discord iniciado...');
  })
  .catch((error) => {
    console.error('❌ Não foi possível conectar ao Discord:');
    console.error(error);
  });
