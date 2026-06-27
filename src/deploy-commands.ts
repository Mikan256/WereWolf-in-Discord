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
    .addStringOption((o) => o.setName("参加者").setDescription("参加者のメンション (省略で対話モード)").setRequired(false))
    .addIntegerOption((o) => o.setName("人狼").setDescription("人狼の数").setRequired(false).setMinValue(1).setMaxValue(5))
    .addIntegerOption((o) => o.setName("共犯者").setDescription("共犯者の数").setRequired(false).setMinValue(0).setMaxValue(3))
    .addIntegerOption((o) => o.setName("狂人").setDescription("狂人の数").setRequired(false).setMinValue(0).setMaxValue(3))
    .addIntegerOption((o) => o.setName("狂信者").setDescription("狂信者の数").setRequired(false).setMinValue(0).setMaxValue(3))
    .addIntegerOption((o) => o.setName("妖狐").setDescription("妖狐の数").setRequired(false).setMinValue(0).setMaxValue(2))
    .addIntegerOption((o) => o.setName("占い師").setDescription("占い師の数").setRequired(false).setMinValue(0).setMaxValue(2))
    .addIntegerOption((o) => o.setName("霊媒師").setDescription("霊媒師の数").setRequired(false).setMinValue(0).setMaxValue(2))
    .addIntegerOption((o) => o.setName("騎士").setDescription("騎士の数").setRequired(false).setMinValue(0).setMaxValue(2))
    .addIntegerOption((o) => o.setName("てるてる坊主").setDescription("てるてる坊主の数").setRequired(false).setMinValue(0).setMaxValue(1))
    .addIntegerOption((o) => o.setName("猫又").setDescription("猫又の数").setRequired(false).setMinValue(0).setMaxValue(2))
    .addIntegerOption((o) => o.setName("黒猫").setDescription("黒猫の数").setRequired(false).setMinValue(0).setMaxValue(2))
    .addIntegerOption((o) => o.setName("会議時間").setDescription("会議時間(分)").setRequired(false).setMinValue(1).setMaxValue(30))
    .addBooleanOption((o) => o.setName("匿名投票").setDescription("投票結果を匿名にする（デフォルト: true）").setRequired(false))
    .addStringOption((o) =>
      o.setName("ゲームモード")
        .setDescription("ゲームモードを選択（デフォルト: 通常人狼）")
        .setRequired(false)
        .addChoices(
          { name: "通常人狼", value: "classic" },
          { name: "ワンナイト人狼", value: "oneten" },
          { name: "ギシンアンキ(二人用人狼)", value: "gishinanki" },
        )
    ),
  new SlashCommandBuilder()
    .setName("setting-status")
    .setDescription("現在の設定を確認する"),
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
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("コマンド一覧と説明を見る。役職ごとの説明も読めます。")
    .addStringOption((o) =>
      o.setName("項目").setDescription("表示する項目 (省略可)")
        .addChoices(
          { name: "通常人狼 役職一覧", value: "classic_roles" },
          { name: "通常人狼 ルール説明", value: "classic_rules" },
          { name: "ワンナイト人狼 役職一覧", value: "oneten_roles" },
          { name: "ワンナイト人狼 ルール説明", value: "oneten_rules" },
          { name: "ギシンアンキ 役職一覧", value: "gishinanki_roles" },
          { name: "ギシンアンキ ルール説明", value: "gishinanki_rules" },
        )
    ),
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
