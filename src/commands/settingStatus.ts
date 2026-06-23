import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { GameManager } from "../game/GameManager";

export const data = new SlashCommandBuilder()
  .setName("setting-status")
  .setDescription("現在の設定を確認する");

export async function execute(interaction: ChatInputCommandInteraction, gameManager: GameManager) {
  const result = await gameManager.getSettingStatus(interaction.guildId!, interaction.user.id);
  await interaction.reply(result);
}
