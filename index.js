// Deixe vazio para não gerar milhares de linhas de debug no Render.
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

  // Canal opcional. Pode ser configurado também pelo comando.
  ONLINE_CHANNEL_ID: process.env.ONLINE_CHANNEL_ID || null
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
// CLIENTE DO DISCORD
// ============================================================

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ============================================================
// VARIÁVEIS DO BOT
// ============================================================

const jogadoresOnline = new Map();

let mcClient = null;
let reconnectTimer = null;
let tentandoConectar = false;

let canalAtualizacaoId = CONFIG.ONLINE_CHANNEL_ID;
let mensagemAtualizacaoId = null;
let intervaloAtualizacao = null;
let atualizandoMensagem = false;

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
// EMBED DA LISTA ONLINE
// ============================================================

function criarEmbedOnline() {
  const nomes = obterNomesJogadores();

  const lista = nomes.length > 0
    ? nomes.map(nome => `• ${nome}`).join('\n')
    : 'Nenhum jogador foi detectado ainda.';

  // O Discord permite no máximo 1024 caracteres por campo.
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
// ATUALIZAÇÃO AUTOMÁTICA NO CANAL
// ============================================================

async function atualizarMensagemOnline() {
  if (!canalAtualizacaoId || atualizandoMensagem) {
    return;
  }

  atualizandoMensagem = true;

  try {
    const canal = await discordClient.channels.fetch(canalAtualizacaoId);

    if (!canal || !canal.isTextBased()) {
      console.error('❌ O canal configurado não é um canal de texto.');
      return;
    }

    const embed = criarEmbedOnline();
    let mensagem = null;

    // Tenta editar a mensagem anterior.
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
    console.log('ℹ️ Nenhum canal automático foi configurado.');
    return;
  }

  // Atualiza imediatamente ao iniciar.
  atualizarMensagemOnline();

  // Depois atualiza a cada 30 segundos.
  intervaloAtualizacao = setInterval(() => {
    atualizarMensagemOnline();
  }, 30000);

  console.log('🔄 Atualização automática iniciada a cada 30 segundos.');
}

function pararAtualizacaoAutomatica() {
  if (intervaloAtualizacao) {
    clearInterval(intervaloAtualizacao);
    intervaloAtualizacao = null;
  }

  canalAtualizacaoId = null;
  mensagemAtualizacaoId = null;

  console.log('⏹️ Atualização automática parada.');
}

// ============================================================
// CONEXÃO COM O SERVIDOR BEDROCK
// ============================================================

function agendarReconexao() {
  if (reconnectTimer) {
    return;
  }

  console.log('🔌 Conexão fechada. Tentando novamente em 10 segundos...');

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
       * Usa o patch experimental no seu fork:
       * versão informada: 1.26.51
       * dados internos: 1.26.45
       * protocolo enviado: 2193
       */
      version: CONFIG.MC_VERSION,

      // No seu servidor precisa ser false.
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
    .setDescription('Escolhe o canal da mensagem automática')
    .addChannelOption(option =>
      option
        .setName('canal')
        .setDescription('Canal onde a lista será atualizada')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild.toString()
    ),

  new SlashCommandBuilder()
    .setName('parar-online')
    .setDescription('Para a atualização automática da lista')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild.toString()
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

    console.log('✅ Comandos registrados com sucesso!');
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

  // Se ONLINE_CHANNEL_ID estiver configurado no Render,
  // a atualização começa automaticamente.
  if (canalAtualizacaoId) {
    iniciarAtualizacaoAutomatica();
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
  // /configurar-online canal:#canal
  // ==========================================================

  if (interaction.commandName === 'configurar-online') {
    const canal = interaction.options.getChannel('canal');

    if (!canal || canal.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: '❌ Escolha um canal de texto válido.',
        ephemeral: true
      });

      return;
    }

    canalAtualizacaoId = canal.id;

    // Faz o bot criar uma nova mensagem nesse canal.
    mensagemAtualizacaoId = null;

    iniciarAtualizacaoAutomatica();

    await interaction.reply({
      content:
        `✅ A lista será atualizada automaticamente a cada 30 segundos em ${canal}.`,
      ephemeral: true
    });

    return;
  }

  // ==========================================================
  // /parar-online
  // ==========================================================

  if (interaction.commandName === 'parar-online') {
    pararAtualizacaoAutomatica();

    await interaction.reply({
      content: '✅ A atualização automática foi parada.',
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
 
