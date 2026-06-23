import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { GameManager } from "../game/GameManager";

export const data = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("ゲームを強制終了し初期化する(ホストのみ/試合中のみ)");

export async function execute(
  interaction: ChatInputCommandInteraction,
  gameManager: GameManager
) {
  await interaction.deferReply();
  const result = await gameManager.stopGame(
    interaction.guildId!,
    interaction.user.id
  );
  await interaction.editReply(result);
}
