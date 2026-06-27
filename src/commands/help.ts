import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";

const EPHEMERAL = 64;
import { GameManager } from "../game/GameManager";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("コマンド一覧と説明を見る。役職ごとの説明も読めます。")
  .addStringOption((o) =>
    o.setName("項目")
      .setDescription("表示する項目 (省略可)")
      .addChoices(
        { name: "通常人狼 役職一覧", value: "classic_roles" },
        { name: "通常人狼 ルール説明", value: "classic_rules" },
        { name: "ワンナイト人狼 役職一覧", value: "oneten_roles" },
        { name: "ワンナイト人狼 ルール説明", value: "oneten_rules" },
        { name: "ギシンアンキ 役職一覧", value: "gishinanki_roles" },
        { name: "ギシンアンキ ルール説明", value: "gishinanki_rules" },
      )
  );

export async function execute(interaction: ChatInputCommandInteraction, gameManager: GameManager) {
  const item = interaction.options.getString("項目");
  const result = await gameManager.getHelp(interaction.guildId, item ?? undefined);
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
