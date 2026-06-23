import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";

const EPHEMERAL = 64;
import { GameManager } from "../game/GameManager";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("コマンド一覧と説明を見る。役職ごとの説明も読めます。")
  .addStringOption((o) =>
    o.setName("項目")
      .setDescription("表示する項目 (省略可)")
      .addChoices({ name: "役職一覧", value: "roles" })
  );

export async function execute(interaction: ChatInputCommandInteraction, gameManager: GameManager) {
  const item = interaction.options.getString("項目");
  const result = await gameManager.getHelp(item ?? undefined);
  if (result.length > 2000) {
    const chunks = [];
    for (let i = 0; i < result.length; i += 1900) {
      chunks.push(result.substring(i, i + 1900));
    }
    await interaction.reply({ content: chunks[0], flags: EPHEMERAL });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], flags: EPHEMERAL });
    }
  } else {
    await interaction.reply(result);
  }
}
