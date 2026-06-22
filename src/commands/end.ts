import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { GameManager } from "../game/GameManager";

export const data = new SlashCommandBuilder()
  .setName("end")
  .setDescription("試合終了後に初期化を行う(試合終了後のみ)");

export async function execute(
  interaction: ChatInputCommandInteraction,
  gameManager: GameManager
) {
  const result = await gameManager.endGame(
    interaction.guildId!,
    interaction.user.id
  );
  await interaction.reply(result);
}
