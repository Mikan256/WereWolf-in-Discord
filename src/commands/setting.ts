import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import { GameManager } from "../game/GameManager";

export const data = new SlashCommandBuilder()
  .setName("setting")
  .setDescription("対話形式で設定を決める(ホストのみ)")
  .addStringOption((option) =>
    option
      .setName("参加者")
      .setDescription("参加者のメンションをスペース区切りで (例: @user1 @user2)")
      .setRequired(true)
  )
  .addIntegerOption((option) =>
    option
      .setName("人狼")
      .setDescription("人狼の数")
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(5)
  )
  .addIntegerOption((option) =>
    option
      .setName("共犯者")
      .setDescription("共犯者の数")
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(3)
  )
  .addIntegerOption((option) =>
    option
      .setName("妖狐")
      .setDescription("妖狐の数")
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(2)
  )
  .addIntegerOption((option) =>
    option
      .setName("占い師")
      .setDescription("占い師の数")
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(2)
  )
  .addIntegerOption((option) =>
    option
      .setName("霊媒師")
      .setDescription("霊媒師の数")
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(2)
  )
  .addIntegerOption((option) =>
    option
      .setName("騎士")
      .setDescription("騎士の数")
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(2)
  )
  .addIntegerOption((option) =>
    option
      .setName("会議時間")
      .setDescription("会議時間(分)")
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(30)
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  gameManager: GameManager
) {
  const raw = interaction.options.getString("参加者", true);
  const mentionRegex = /<@!?(\d+)>/g;
  const participantIds: string[] = [];
  let match;
  while ((match = mentionRegex.exec(raw)) !== null) {
    participantIds.push(match[1]);
  }

  if (participantIds.length < 4) {
    await interaction.reply({
      content: "最低4人以上の参加者が必要です。",
      ephemeral: true,
    });
    return;
  }

  const werewolfCount = interaction.options.getInteger("人狼", true);
  const accompliceCount = interaction.options.getInteger("共犯者", true);
  const foxCount = interaction.options.getInteger("妖狐", true);
  const fortuneTellerCount = interaction.options.getInteger("占い師", true);
  const mediumCount = interaction.options.getInteger("霊媒師", true);
  const knightCount = interaction.options.getInteger("騎士", true);
  const meetingTimeMinutes = interaction.options.getInteger("会議時間", true);

  const result = await gameManager.setSetting(
    interaction.guildId!,
    interaction.user.id,
    participantIds,
    werewolfCount,
    accompliceCount,
    foxCount,
    fortuneTellerCount,
    mediumCount,
    knightCount,
    meetingTimeMinutes
  );

  const summary =
    `**設定完了**\n` +
    `参加者: ${participantIds.length}人\n` +
    `人狼: ${werewolfCount}人 / 共犯者: ${accompliceCount}人 / 妖狐: ${foxCount}人\n` +
    `占い師: ${fortuneTellerCount}人 / 霊媒師: ${mediumCount}人 / 騎士: ${knightCount}人\n` +
    `会議時間: ${meetingTimeMinutes}分`;

  await interaction.reply(summary);
}
