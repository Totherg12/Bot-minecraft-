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

  MC_VERSION: '1.26.51',
  MC_OFFLINE: false,

  ONLINE_CHANNEL_ID: process.env.ONLINE_CHANNEL_ID || null,
  REGISTRATION_CHANNEL_ID:
    process.env.REGISTRATION_CHANNEL_ID || null
};

const TEMPO_RECONEXAO = 10000;

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
let tentandoConectar = false;
let reconnectTimer = null;

// Status atualizado a cada 30 segundos.
let canalAtualizacaoId = CONFIG.ONLINE_CHANNEL_ID;
let mensagemAtualizacaoId = null;
let intervaloAtualizacao = null;
let atualizandoMensagem = false;

// Registros acumulativos a cada 45 segundos.
let canalRegistroId = CONFIG.REGISTRATION_CHANNEL_ID;
let intervaloRegistro = null;
let registrandoJogadores = false;

// ============================================================
// PERMISSÕES
// ============================================================

function eAdministrador(interaction) {
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  );
}

function respostaPrivada() {
  return { flags: 64 };
}

// ============================================================
// JOGADORES ONLINE
// ============================================================

function obterIdJogador(jogador) {
  const id =
    jogador.uuid ??
    jogador.xuid ??
    jogador.entity_unique_id ??
    jogador.entity_runtime_id ??
    jogador.username ??
    jogador.name ??
    jogador.gamertag;

  return id === undefined || id === null
    ? null
    : String(id);
}

function obterNomeJogador(jogador) {
  const nome =
    jogador.username ??
    jogador.name ??
    jogador.gamertag ??
    jogador.display_name ??
    jogador.skin_data?.display_name ??
    jogador.player_name;

  return nome ? String(nome) : null;
}

function obterNomesJogadores() {
  return [...new Set([...jogadoresOnline.values()])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function limparJogadores() {
  jogadoresOnline.clear();
}

function extrairRegistrosPlayerList(packet) {
  if (!packet) {
    return [];
  }

  if (Array.isArray(packet.records?.records)) {
    return packet.records.records;
  }

  if (Array.isArray(packet.records)) {
    return packet.records;
  }

  if (Array.isArray(packet.entries)) {
    return packet.entries;
  }

  return [];
}

function playerListEstaRemovendo(packet) {
  const tipo =
    packet?.records?.type ??
    packet?.type ??
    packet?.action ??
    'add';

  return (
    tipo === 1 ||
    tipo === 'remove' ||
    tipo === 'REMOVE' ||
    tipo === 'Remove'
  );
}

function processarListaDeJogadores(packet) {
  const registros = extrairRegistrosPlayerList(packet);

  if (registros.length === 0) {
    console.log('📦 player_list recebido sem registros.');
    return;
  }

  const removendo = playerListEstaRemovendo(packet);

  for (const jogador of registros) {
    const id = obterIdJogador(jogador);
    const nome = obterNomeJogador(jogador);

    if (removendo) {
      if (id) {
        jogadoresOnline.delete(id);
      }

      continue;
    }

    if (id && nome) {
      jogadoresOnline.set(id, nome);
    }
  }

  const nomes = obterNomesJogadores();

  console.log(
    `✅ Lista processada: ${nomes.length} jogador(es):`,
    nomes.join(', ') || 'nenhum'
  );

  // Atualiza imediatamente quando alguém entra ou sai.
  atualizarMensagemOnline();
}

// ============================================================
// EMBEDS
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
      text: 'Atualizado automaticamente a cada 30 segundos'
    })
    .setTimestamp();
}

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
      text: 'Registro acumulativo a cada 45 segundos'
    })
    .setTimestamp();
}

// ============================================================
// STATUS AUTOMÁTICO — 30 SEGUNDOS
// ============================================================

async function atualizarMensagemOnline() {
  if (!canalAtualizacaoId || atualizandoMensagem) {
    return;
  }

  atualizandoMensagem = true;

  try {
    const canal = await discordClient.channels.fetch(
      canalAtualizacaoId
    );

    if (!canal || canal.type !== ChannelType.GuildText) {
      console.error('❌ Canal de status inválido.');
      return;
    }

    const embed = criarEmbedOnline();
    let mensagem = null;

    if (mensagemAtualizacaoId) {
      try {
        mensagem = await canal.messages.fetch(
          mensagemAtualizacaoId
        );
      } catch {
        mensagem = null;
      }
    }

    if (mensagem) {
      await mensagem.edit({
        embeds: [embed]
      });

      console.log(
        `🔄 Status atualizado com ${obterNomesJogadores().length} jogador(es).`
      );
    } else {
      mensagem = await canal.send({
        embeds: [embed]
      });

      mensagemAtualizacaoId = mensagem.id;

      console.log('✅ Mensagem de status criada.');
    }
  } catch (error) {
    console.error('❌ Erro ao atualizar status online:');
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
    console.log('ℹ️ Canal de status não configurado.');
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
// REGISTROS ACUMULATIVOS — 45 SEGUNDOS
// ============================================================

async function registrarJogadoresOnline() {
  if (!canalRegistroId || registrandoJogadores) {
    return;
  }

  registrandoJogadores = true;

  try {
    const canal = await discordClient.channels.fetch(
      canalRegistroId
    );

    if (!canal || canal.type !== ChannelType.GuildText) {
      console.error('❌ Canal de registro inválido.');
      return;
    }

    // Sempre cria uma nova mensagem.
    await canal.send({
      embeds: [criarEmbedRegistro()]
    });

    console.log('📝 Novo registro acumulativo enviado.');
  } catch (error) {
    console.error('❌ Erro ao enviar registro:');
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

  registrarJogadoresOnline();

  intervaloRegistro = setInterval(() => {
    registrarJogadoresOnline();
  }, 45000);

  console.log('📝 Registro automático iniciado a cada 45 segundos.');
}

function pararRegistroAutomatico() {
  if (intervaloRegistro) {
    clearInterval(intervaloRegistro);
    intervaloRegistro = null;
  }

  canalRegistroId = null;

  console.log('⏹️ Registro automático parado.');
}

// ============================================================
// RECONEXÃO BEDROCK
// ============================================================

function agendarReconexao() {
  // Impede várias tentativas simultâneas.
  if (reconnectTimer || tentandoConectar) {
    return;
  }

  console.log(
    `🔄 Tentando reconectar em ${TEMPO_RECONEXAO / 1000} segundos...`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    conectarBedrock();
  }, TEMPO_RECONEXAO);
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
      version: CONFIG.MC_VERSION,
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

    mcClient.on('player_list', (packet) => {
      console.log('📋 Pacote player_list recebido.');
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
      /*
       * Esse erro já ocorreu por causa do pacote camera_presets
       * na compatibilidade experimental. Ele não deve derrubar
       * o processo do bot.
       */
      if (error?.partialReadError) {
        console.warn(
          '⚠️ Pacote Bedrock incompatível ignorado:',
          error.message
        );

        return;
      }

      tentandoConectar = false;

      console.error('⚠️ Erro no protocolo Bedrock:');
      console.error(error);

      /*
       * Não agendamos outra tentativa aqui.
       * Se a conexão for fechada, o evento "close" fará isso.
       */
      try {
        mcClient?.close();
      } catch (closeError) {
        console.error('Erro ao fechar conexão:', closeError);
      }
    });

    /*
     * Este é o ponto principal da reconexão.
     * Qualquer fechamento real da conexão passa por aqui.
     */
    mcClient.on('close', () => {
      console.log('🔌 Bot desconectado do servidor Bedrock.');

      tentandoConectar = false;
      mcClient = null;

      limparJogadores();

      // A lista do Discord ficará vazia até a reconexão.
      agendarReconexao();
    });
  } catch (error) {
    tentandoConectar = false;
    mcClient = null;

    console.error('❌ Erro ao criar cliente Bedrock:');
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
    .setDescription('Mostra os jogadores online')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator.toString()
    ),

  new SlashCommandBuilder()
    .setName('configurar-online')
    .setDescription('Escolhe o canal do status automático')
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
    .setDescription('Escolhe o canal dos registros')
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
    .setDescription('Para os registros automáticos')
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

    console.log('✅ Comandos registrados no Discord.');
  } catch (error) {
    console.error('❌ Erro ao registrar comandos:');
    console.error(error);
  }
}

// ============================================================
// INTERAÇÕES DO DISCORD
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

  if (!eAdministrador(interaction)) {
    await interaction.reply({
      content: '❌ Apenas administradores podem usar os comandos deste bot.',
      ...respostaPrivada()
    });

    return;
  }

  if (interaction.commandName === 'online') {
    await interaction.reply({
      embeds: [criarEmbedOnline()]
    });

    return;
  }

  if (interaction.commandName === 'configurar-online') {
    const canal = interaction.options.getChannel('canal');

    if (!canal || canal.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: '❌ Escolha um canal de texto válido.',
        ...respostaPrivada()
      });

      return;
    }

    canalAtualizacaoId = canal.id;
    mensagemAtualizacaoId = null;

    iniciarAtualizacaoAutomatica();

    await interaction.reply({
      content:
        `✅ Canal de status definido como ${canal}.\n` +
        'A mensagem foi enviada e será atualizada a cada 30 segundos.',
      ...respostaPrivada()
    });

    return;
  }

  if (interaction.commandName === 'parar-online') {
    pararAtualizacaoAutomatica();

    await interaction.reply({
      content: '✅ O status automático foi parado.',
      ...respostaPrivada()
    });

    return;
  }

  if (interaction.commandName === 'configurar-registro') {
    const canal = interaction.options.getChannel('canal');

    if (!canal || canal.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: '❌ Escolha um canal de texto válido.',
        ...respostaPrivada()
      });

      return;
    }

    canalRegistroId = canal.id;

    iniciarRegistroAutomatico();

    await interaction.reply({
      content:
        `✅ Canal de registro definido como ${canal}.\n` +
        'Uma nova mensagem será enviada a cada 45 segundos.',
      ...respostaPrivada()
    });

    return;
  }

  if (interaction.commandName === 'parar-registro') {
    pararRegistroAutomatico();

    await interaction.reply({
      content: '✅ Os registros automáticos foram parados.',
      ...respostaPrivada()
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
