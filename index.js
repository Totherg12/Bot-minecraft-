process.env.DEBUG = '';

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  Events
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

  // false é necessário no seu servidor.
  MC_OFFLINE: false
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
// ESTADO DO BOT
// ============================================================

// A chave é o UUID/XUID e o valor é o nick.
const jogadoresOnline = new Map();

let mcClient = null;
let reconnectTimer = null;
let tentandoConectar = false;

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

function limparJogadores() {
  jogadoresOnline.clear();
}

function obterNomesJogadores() {
  return [...new Set([...jogadoresOnline.values()])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// ============================================================
// LEITURA DO PACOTE PLAYER_LIST
// ============================================================

function processarListaDeJogadores(packet) {
  if (!packet) {
    return;
  }

  /*
   * Formato normal:
   *
   * packet.records.type
   * packet.records.records
   */

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

  // Dependendo da versão, remove pode vir como "remove" ou número 1.
  const removendo =
    tipo === 'remove' ||
    tipo === 1 ||
    tipo === 'REMOVE';

  for (const jogador of registros) {
    const id = obterIdJogador(jogador);
    const nome = obterNomeJogador(jogador);

    if (!id) {
      continue;
    }

    const chave = String(id);

    if (removendo) {
      jogadoresOnline.delete(chave);
      continue;
    }

    if (nome) {
      jogadoresOnline.set(chave, nome);
    }
  }

  console.log(
    `👥 Jogadores detectados (${jogadoresOnline.size}):`,
    obterNomesJogadores().join(', ') || 'nenhum'
  );
}

// ============================================================
// CONEXÃO COM O SERVIDOR BEDROCK
// ============================================================

function agendarReconexao() {
  if (reconnectTimer) {
    return;
  }

  console.log('🔌 Conexão fechada. Tentando reconectar em 10 segundos...');

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
       * Esta opção depende da alteração experimental no seu fork:
       *
       * versão recebida: 1.26.51
       * dados usados internamente: 1.26.45
       * protocolo enviado: 2193
       */
      version: CONFIG.MC_VERSION,

      // No seu caso precisa ser false.
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
      console.error(JSON.stringify(packet, null, 2));
    });

    mcClient.on('disconnect', (packet) => {
      console.error('🚫 O servidor enviou desconexão:');
      console.error(JSON.stringify(packet, null, 2));
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

    /*
     * Este evento não mostra todos os pacotes.
     * Ele serve apenas para confirmar o formato do player_list.
     */
    mcClient.on('packet', (data) => {
  if (data?.data?.name === 'player_list') {
    console.log('📦 Pacote player_list recebido');

    processarListaDeJogadores(data.data.params);
  }
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
    .setDescription('Mostra os jogadores online no Minecraft')
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

    console.log('✅ Comando /online registrado!');
  } catch (error) {
    console.error('❌ Erro ao registrar o comando /online:');
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
});

discordClient.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName !== 'online') {
    return;
  }

  const nomes = obterNomesJogadores();

  const lista = nomes.length > 0
    ? nomes.map(nome => `• ${nome}`).join('\n')
    : 'Nenhum jogador foi detectado ainda.';

  const listaLimitada = lista.length > 1024
    ? `${lista.substring(0, 1000)}\n...`
    : lista;

  const embed = new EmbedBuilder()
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
        name: '📜 Nicks',
        value: listaLimitada
      }
    )
    .setFooter({
      text: 'Lista obtida pelo cliente Bedrock'
    })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed]
  });
});

discordClient.on(Events.Error, (error) => {
  console.error('❌ Erro no cliente do Discord:');
  console.error(error);
});

// ============================================================
// LOGIN DO DISCORD
// ============================================================

discordClient.login(CONFIG.DISCORD_TOKEN)
  .then(() => {
    console.log('🔄 Login do Discord iniciado...');
  })
  .catch((error) => {
    console.error('❌ Não foi possível conectar ao Discord:');
    console.error(error);
  });
