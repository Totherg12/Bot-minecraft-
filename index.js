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

  // Seu fork experimental do bedrock-protocol.
  MC_VERSION: '1.26.51',

  // O servidor exige autenticação Microsoft.
  MC_OFFLINE: false,

  // Opcional: IDs salvos no Render.
  ONLINE_CHANNEL_ID: process.env.ONLINE_CHANNEL_ID || null,
  REGISTRATION_CHANNEL_ID:
    process.env.REGISTRATION_CHANNEL_ID || null
};

// Tempo entre tentativas de reconexão.
const TEMPO_RECONEXAO = 10000;

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

// Registros: novas mensagens a cada 45 segundos.
let canalRegistroId = CONFIG.REGISTRATION_CHANNEL_ID;
let intervaloRegistro = null;
let registrandoJogadores = false;

// ============================================================
// FUNÇÕES GERAIS
// ============================================================

function eAdministrador(interaction) {
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  );
}

function respostaPrivada() {
  // MessageFlags.Ephemeral
  return { flags: 64 };
}

// ============================================================
// JOGADORES ONLINE
// ============================================================

function obterIdJogador(jogador) {
  const id =
    jogador?.uuid ??
    jogador?.xuid ??
    jogador?.entity_unique_id ??
    jogador?.entity_runtime_id ??
    jogador?.username ??
    jogador?.name ??
    jogador?.gamertag;

  if (id === undefined || id === null) {
    return null;
  }

  return String(id);
}

function obterNomeJogador(jogador) {
  const nome =
    jogador?.username ??
    jogador?.name ??
    jogador?.gamertag ??
    jogador?.display_name ??
    jogador?.skin_data?.display_name ??
    jogador?.player_name;

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
      /*
       * Em alguns pacotes de remoção existe apenas o UUID/XUID.
       */
      if (id) {
        jogadoresOnline.delete(id);
      }

      /*
       * Fallback caso a remoção venha com nome, mas sem o mesmo ID.
       */
      if (nome) {
        for (const [chave, nomeSalvo] of jogadoresOnline.entries()) {
          if (nomeSalvo === nome) {
            jogadoresOnline.delete(chave);
          }
        }
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

  /*
   * Atualiza o status imediatamente quando alguém entra ou sai.
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
// EMBED DOS REGISTROS
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
// STATUS AUTOMÁTICO — A CADA 30 SEGUNDOS
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
      console.error('❌ O canal de status não é válido.');
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

  // Continua atualizando mesmo se o Minecraft estiver desconectado.
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
// REGISTROS ACUMULATIVOS — A CADA 45 SEGUNDOS
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
      console.error('❌ O canal de registro não é válido.');
      return;
    }

    /*
     * Sempre envia uma nova mensagem.
     * Os registros anteriores não são editados ou apagados.
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
// RECONEXÃO DO MINECRAFT
// ============================================================

function agendarReconexao() {
  /*
   * Impede várias reconexões simultâneas.
   */
  if (reconnectTimer) {
    console.log('ℹ️ Uma reconexão já está agendada.');
    return;
  }

  console.log(
    `🔄 Nova tentativa em ${TEMPO_RECONEXAO / 1000} segundos...`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    console.log('🔁 Iniciando nova conexão Bedrock...');
    conectarBedrock();
  }, TEMPO_RECONEXAO);
}

function conectarBedrock() {
  if (tentandoConectar) {
    console.log('ℹ️ Já existe uma tentativa de conexão em andamento.');
    return;
  }

  tentandoConectar = true;

  console.log('🔄 Conectando ao servidor Bedrock...');
  console.log(`🌐 Servidor: ${CONFIG.MC_HOST}:${CONFIG.MC_PORT}`);
  console.log(`🎮 Versão: ${CONFIG.MC_VERSION}`);
  console.log(`🔐 Autenticação online: ${!CONFIG.MC_OFFLINE}`);

  let clienteAtual;

  try {
    clienteAtual = bedrock.createClient({
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

    mcClient = clienteAtual;

    clienteAtual.on('connect_allowed', () => {
      console.log('✅ Conexão RakNet permitida.');
    });

    clienteAtual.on('join', () => {
      tentandoConectar = false;
      console.log('✅ Bot entrou no servidor Bedrock!');
    });

    clienteAtual.on('spawn', () => {
      tentandoConectar = false;
      console.log('✅ Bot apareceu no mundo!');
    });

    clienteAtual.on('player_list', (packet) => {
      console.log('📋 Pacote player_list recebido.');
      processarListaDeJogadores(packet);
    });

    clienteAtual.on('kick', (packet) => {
      console.error('🚫 O servidor expulsou o bot:');
      console.error(packet);

      /*
       * Normalmente o evento close virá depois.
       * A reconexão fica centralizada no close.
       */
    });

    clienteAtual.on('disconnect', (packet) => {
      console.error('🚫 O servidor enviou uma desconexão:');
      console.error(packet);

      /*
       * Não limpamos os jogadores aqui.
       * Só limpamos quando a conexão realmente fecha.
       */
    });

    clienteAtual.on('error', (error) => {
      /*
       * Esse erro apareceu anteriormente por causa de pacotes
       * da 1.26.51 sendo interpretados com dados da 1.26.45.
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
       * Fecha somente esta conexão.
       * O evento close cuidará da reconexão.
       */
      try {
        clienteAtual.close();
      } catch (closeError) {
        console.error('❌ Erro ao fechar conexão com problema:');
        console.error(closeError);
      }
    });

    /*
     * Toda reconexão é controlada por este evento.
     */
    clienteAtual.on('close', () => {
      console.log('🔌 Bot desconectado do servidor Bedrock.');

      tentandoConectar = false;

      /*
       * Só alteramos mcClient se ele ainda for esta conexão.
       * Isso evita que uma conexão antiga apague uma nova.
       */
      if (mcClient === clienteAtual) {
        mcClient = null;
        limparJogadores();
      }

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

  /*
   * Todos os comandos são somente para administradores.
   */
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

    /*
     * Envia imediatamente no novo canal.
     */
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
// ERROS GERAIS DO PROCESSO
// ============================================================

process.on('uncaughtException', (error) => {
  console.error('❌ Erro não tratado no processo:');
  console.error(error);

  /*
   * Não encerramos o processo automaticamente.
   * Isso mantém o servidor HTTP e o Discord ativos.
   */
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Promise rejeitada sem tratamento:');
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
