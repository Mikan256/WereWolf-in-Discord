import {
  Client,
  GatewayIntentBits,
  Events,
  Collection,
  ChatInputCommandInteraction,
} from "discord.js";
import { config } from "dotenv";
config();

import { TOKEN } from "./utils/env";
import { GameManager } from "./game/GameManager";

import * as settingCommand from "./commands/setting";
import * as startCommand from "./commands/start";
import * as stopCommand from "./commands/stop";
import * as skipCommand from "./commands/skip";
import * as endCommand from "./commands/end";

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

const gameManager = new GameManager(client);

const commands = new Collection<string, any>();
commands.set(settingCommand.data.name, settingCommand);
commands.set(startCommand.data.name, startCommand);
commands.set(stopCommand.data.name, stopCommand);
commands.set(skipCommand.data.name, skipCommand);
commands.set(endCommand.data.name, endCommand);

client.once(Events.ClientReady, (c) => {
  console.log(`${c.user.tag} としてログインしました！`);
  c.user.setActivity("/setting で人狼を始めよう！", { type: 3 });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guildId) {
    await interaction.reply({
      content: "このコマンドはサーバー内でのみ使用できます。",
      ephemeral: true,
    });
    return;
  }

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, gameManager);
  } catch (error) {
    console.error(error);
    const reply = {
      content: "コマンド実行中にエラーが発生しました。",
      ephemeral: true,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

client.login(TOKEN);
