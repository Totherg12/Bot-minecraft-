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

  // Seu servidor exigiu autenticação Microsoft.
  MC_OFFLINE: false,

  ONLINE_CHANNEL_ID: process.env.ONLINE_CHANNEL_ID || null,

  REGISTRATION_CHANNEL_ID:
    process.env.REGISTRATION_CHANNEL_ID || null
};

if (!CONFIG.DISCORD_TOKEN) {
  console.error('❌ A variável DISCORD_TOKEN não foi configurada.');
  process.exit(1);
}

if (!CONFIG.CLIENT_ID) {
  console.error('❌ A variável CLIENT_ID não foi configurada.');
  process.exit(1);
}

// ============================================================
// CLIENTE DISCORD
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

// Status: uma mensagem editada a cada 30 segundos.
let canalAtualizacaoId = CONFIG.ONLINE_CHANNEL_ID;
let mensagemAtualizacaoId = null;
let intervaloAtualizacao = null;
let atualizandoMensagem = false;

// Registro: novas mensagens a cada 45 segundos.
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
  // 64 = MessageFlags.Ephemeral
  return { flags: 64 };
}

// ============================================================
// JOGADORES
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

  if (id === undefined || id === null) {
    return null;
  }

  return String(id);
}

function obterNomeJogador(jogador) {
  const nome =
    jogador.username ??
    jogador.name ??
    jogador.gamertag ??
    jogador.display_name ??
    jogador.skin_data?.display_name ??
    jogador.player_name;

  if (!nome) {
    return null;
  }

  return String(nome);
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

function obterTipoPlayerList(packet) {
  return (
    packet?.records?.type ??
    packet?.type ??
    packet?.action ??
    'add'
  );
}

function playerListEstaRemovendo(packet) {
  const tipo = obterTipoPlayerList(packet);

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

    /*
     * Em pacotes de remoção, normalmente o UUID/XUID existe,
     * mas o username pode não existir.
     */
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
    `✅ Lista processada: ${nomes.length} jogador(es)`,
    nomes.length > 0 ? nomes.join(', ') : 'nenhum'
  );

  /*
   * Atualiza imediatamente quando o servidor informa alteração.
   * O intervalo de 30 segundos também continuará funcionando.
   */
  atualizarMensagemOnline();
}

// ============================================================
// EMBED DO STATUS ONLINE
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

// ============================================================
// EMBED DO REGISTRO
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
      text: 'Registro acumulativo a cada 45 segundos'
    })
    .setTimestamp();
}

// ============================================================
// STATUS AUTOMÁTICO A CADA 30 SEGUNDOS
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

  // Envia imediatamente.
  atualizarMensagemOnline();

  // Depois atualiza a cada 30 segundos.
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
    const canal = await discordClient.channels.fetch(
      canalRegistroId
    );

    if (!canal || canal.type !== ChannelType.GuildText) {
      console.error('❌ Canal de registro inválido.');
      return;
    }

    /*
     * Sempre envia uma NOVA mensagem.
     * Nenhum registro anterior é editado ou apagado.
     */
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

  // Primeiro registro imediatamente.
  registrarJogadoresOnline();

  // Novo registro a cada 45 segundos.
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
// CONEXÃO BEDROCK
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

    /*
     * Este é o único listener que processa player_list.
     */
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
      tentandoConectar = false;

      if (error?.partialReadError) {
        console.warn(
          '⚠️ Pacote Bedrock incompatível ignorado:',
          error.message
        );

        return;
      }

      console.error('⚠️ Erro no protocolo Bedrock:');
      console.error(error);
    });

    mcClient.on('close', () => {
      tentandoConectar = false;
      mcClient = null;

      /*
       * Só limpa a lista quando a conexão realmente fecha.
       * Não limpe no evento "disconnect".
       */
      limparJogadores();

      agendarReconexao();
    });
  } catch (error) {
    tentandoConectar = false;

    console.error('❌ Erro ao criar cliente Bedrock:');
    console.error(error);

    agendarReconexao();
  }
}

// ============================================================
// COMANDOS
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

    console.log('✅ Comandos registrados no Discord.');
  } catch (error) {
    console.error('❌ Erro ao registrar comandos:');
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

  // Todos os comandos são somente para administradores.
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

    // Cria a mensagem imediatamente no canal escolhido.
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
