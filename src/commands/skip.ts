import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { GameManager } from "../game/GameManager";

export const data = new SlashCommandBuilder()
  .setName("skip")
  .setDescription("会議時間をスキップし投票に移る(ホストのみ/会議時間中のみ)");

export async function execute(
  interaction: ChatInputCommandInteraction,
  gameManager: GameManager
) {
  const result = await gameManager.skipVote(
    interaction.guildId!,
    interaction.user.id
  );
  await interaction.reply(result);
}
