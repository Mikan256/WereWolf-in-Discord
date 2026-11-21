import {
  Client,
  GatewayIntentBits,
  Events,
  Collection,
} from "discord.js";

const EPHEMERAL = 64;
import { config } from "dotenv";
config();

import { TOKEN } from "./utils/env";
import { GameManager } from "./game/GameManager";
import { PersistenceManager } from "./utils/persistence";

import * as settingCommand from "./commands/setting";
import * as settingStatusCommand from "./commands/settingStatus";
import * as startCommand from "./commands/start";
import * as stopCommand from "./commands/stop";
import * as skipCommand from "./commands/skip";
import * as endCommand from "./commands/end";
import * as helpCommand from "./commands/help";

async function main() {
  const persistence = new PersistenceManager();
  await persistence.init();
  console.log("[Bot] Persistence initialized");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
    ],
  });

  const gameManager = new GameManager(client, persistence);

  const commands = new Collection<string, any>();
  commands.set(settingCommand.data.name, settingCommand);
  commands.set(settingStatusCommand.data.name, settingStatusCommand);
  commands.set(startCommand.data.name, startCommand);
  commands.set(stopCommand.data.name, stopCommand);
  commands.set(skipCommand.data.name, skipCommand);
  commands.set(endCommand.data.name, endCommand);
  commands.set(helpCommand.data.name, helpCommand);

  client.once(Events.ClientReady, (c) => {
    console.log(`${c.user.tag} としてログインしました！`);
    c.user.setActivity("/setting で人狼を始めよう！", { type: 3 });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", flags: EPHEMERAL });
      return;
    }

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, gameManager);
    } catch (error) {
      console.error(error);
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: "コマンド実行中にエラーが発生しました。", components: [] }).catch(() => {});
      } else if (!interaction.replied) {
        await interaction.reply({ content: "コマンド実行中にエラーが発生しました。", flags: EPHEMERAL }).catch(() => {});
      }
    }
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (!newState.channelId || !newState.guild) return;
    if (oldState.channelId === newState.channelId) return;
    gameManager.muteSpectator(newState.id, newState.channelId, newState.guild);
  });

  await client.login(TOKEN);
}

main().catch(console.error);

// タイマーや非同期処理内の予期せぬエラーでプロセスごと落ちないようにする
process.on("unhandledRejection", (reason) => {
  console.error("[Bot] Unhandled rejection:", reason);
});
