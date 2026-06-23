import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { GameManager } from "../game/GameManager";

export const data = new SlashCommandBuilder()
  .setName("start")
  .setDescription("ゲームを開始する(ホストのみ)");

export async function execute(
  interaction: ChatInputCommandInteraction,
  gameManager: GameManager
) {
  await interaction.deferReply();
  const result = await gameManager.startGame(
    interaction.guildId!,
    interaction.user.id
  );
  await interaction.editReply(result);
}
