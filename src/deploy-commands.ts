import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "dotenv";
config();

const TOKEN = process.env.DISCORD_TOKEN || "";
const CLIENT_ID = process.env.CLIENT_ID || "";
const GUILD_ID = process.env.GUILD_ID || "";

const commands = [
  new SlashCommandBuilder()
    .setName("setting")
    .setDescription("対話形式で設定を決める(ホストのみ)")
    .addStringOption((option) =>
      option
        .setName("参加者")
        .setDescription("参加者のメンション (例: @user1 @user2)")
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName("人狼").setDescription("人狼の数").setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName("共犯者").setDescription("共犯者の数").setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName("妖狐").setDescription("妖狐の数").setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName("占い師").setDescription("占い師の数").setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName("霊媒師").setDescription("霊媒師の数").setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName("騎士").setDescription("騎士の数").setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("会議時間")
        .setDescription("会議時間(分)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("ゲームを開始する(ホストのみ)"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("ゲームを強制終了し初期化する(ホストのみ)"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("会議時間をスキップし投票に移る(ホストのみ)"),
  new SlashCommandBuilder()
    .setName("end")
    .setDescription("試合終了後に初期化を行う"),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("スラッシュコマンドを登録中...");

    if (GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
      );
      console.log(`ギルドコマンドを登録しました (${GUILD_ID})`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), {
        body: commands,
      });
      console.log("グローバルコマンドを登録しました");
    }
  } catch (error) {
    console.error(error);
  }
})();
