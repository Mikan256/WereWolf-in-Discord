import { REST, Routes } from "discord.js";
import { config } from "dotenv";
config();

import * as settingCommand from "./commands/setting";
import * as settingStatusCommand from "./commands/settingStatus";
import * as startCommand from "./commands/start";
import * as stopCommand from "./commands/stop";
import * as skipCommand from "./commands/skip";
import * as endCommand from "./commands/end";
import * as helpCommand from "./commands/help";

const TOKEN = process.env.DISCORD_TOKEN || "";
const CLIENT_ID = process.env.CLIENT_ID || "";
const GUILD_ID = process.env.GUILD_ID || "";

// ボット本体と同じ定義を使い、コマンド定義の二重管理によるズレを防ぐ
const commands = [
  settingCommand.data,
  settingStatusCommand.data,
  startCommand.data,
  stopCommand.data,
  skipCommand.data,
  endCommand.data,
  helpCommand.data,
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("スラッシュコマンドを登録中...");
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`ギルドコマンドを登録しました (${GUILD_ID})`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("グローバルコマンドを登録しました");
    }
  } catch (error) {
    console.error(error);
  }
})();
