import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ComponentType,
  EmbedBuilder,
  GuildMember,
  MessageComponentInteraction,
} from "discord.js";
import { GameManager } from "../game/GameManager";
import { RoleType } from "../game/types";

const EPHEMERAL = 64;

const ROLE_OPTIONS: { key: string; role: RoleType; default: number }[] = [
  { key: "人狼", role: RoleType.WEREWOLF, default: 1 },
  { key: "共犯者", role: RoleType.ACCOMPLICE, default: 0 },
  { key: "狂人", role: RoleType.MADMAN, default: 0 },
  { key: "狂信者", role: RoleType.FANATIC, default: 0 },
  { key: "妖狐", role: RoleType.FOX, default: 0 },
  { key: "占い師", role: RoleType.FORTUNE_TELLER, default: 1 },
  { key: "霊媒師", role: RoleType.MEDIUM, default: 0 },
  { key: "騎士", role: RoleType.KNIGHT, default: 0 },
  { key: "てるてる坊主", role: RoleType.TERU_TERU, default: 0 },
  { key: "猫又", role: RoleType.NEKOMATA, default: 0 },
  { key: "黒猫", role: RoleType.BLACK_CAT, default: 0 },
];

type Page = "main" | "select_participants" | "select_role" | "adjust_role" | "select_time";

interface InteractiveState {
  participants: string[];
  roleCounts: Record<string, number>;
  meetingMinutes: number;
  page: Page;
  selectedRoleKey: string | null;
}

export const data = new SlashCommandBuilder()
  .setName("setting")
  .setDescription("対話形式で設定を決める(ホストのみ)")
  .addStringOption((o) =>
    o.setName("参加者").setDescription("参加者のメンション (例: @user1 @user2)").setRequired(false)
  )
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
  .addIntegerOption((o) => o.setName("会議時間").setDescription("会議時間(分)").setRequired(false).setMinValue(1).setMaxValue(30));

function parseMentions(raw: string): string[] {
  const ids: string[] = [];
  const re = /<@!?(\d+)>/g;
  let m;
  while ((m = re.exec(raw)) !== null) ids.push(m[1]);
  return ids;
}

export async function execute(interaction: ChatInputCommandInteraction, gameManager: GameManager) {
  const participantsRaw = interaction.options.getString("参加者");
  if (participantsRaw) {
    await executeWithArgs(interaction, gameManager, participantsRaw);
  } else {
    if (!interaction.guild) return;
    await executeInteractive(interaction, gameManager);
  }
}

async function executeWithArgs(
  interaction: ChatInputCommandInteraction,
  gameManager: GameManager,
  participantsRaw: string,
) {
  const participantIds = parseMentions(participantsRaw);
  if (participantIds.length < 4) {
    await interaction.reply({ content: "最低4人以上の参加者が必要です。", flags: EPHEMERAL });
    return;
  }

  await interaction.deferReply();

  const opt = (name: string): number => interaction.options.getInteger(name) ?? 0;
  const optOrDefault = (name: string, def: number): number => {
    const v = interaction.options.getInteger(name);
    return v !== null ? v : def;
  };

  await gameManager.setSetting(
    interaction.guildId!,
    interaction.user.id,
    participantIds,
    optOrDefault("人狼", 1),
    opt("共犯者"), opt("狂人"), opt("狂信者"),
    opt("妖狐"), optOrDefault("占い師", 1), opt("霊媒師"), opt("騎士"),
    opt("てるてる坊主"), opt("猫又"), opt("黒猫"),
    optOrDefault("会議時間", 3),
  );

  const s =
    `**設定完了**\n参加者: ${participantIds.length}人\n` +
    `人狼: ${optOrDefault("人狼", 1)} / 共犯者: ${opt("共犯者")} / 狂人: ${opt("狂人")} / 狂信者: ${opt("狂信者")}\n` +
    `妖狐: ${opt("妖狐")} / 占い師: ${optOrDefault("占い師", 1)} / 霊媒師: ${opt("霊媒師")} / 騎士: ${opt("騎士")}\n` +
    `てるてる坊主: ${opt("てるてる坊主")} / 猫又: ${opt("猫又")} / 黒猫: ${opt("黒猫")}\n` +
    `会議時間: ${optOrDefault("会議時間", 3)}分`;

  await interaction.editReply(s);
}

async function executeInteractive(interaction: ChatInputCommandInteraction, gameManager: GameManager) {
  const state: InteractiveState = {
    participants: [],
    roleCounts: Object.fromEntries(ROLE_OPTIONS.map((r) => [r.key, r.default])),
    meetingMinutes: 3,
    page: "main",
    selectedRoleKey: null,
  };

  const userId = interaction.user.id;
  await interaction.reply({ content: "設定を始めます。" });

  let running = true;
  while (running) {
    await render(interaction, state);
    const ci = await waitForAction(interaction, state, userId);
    if (!ci) { running = false; break; }

    switch (state.page) {
      case "main":
        running = await handleMainAction(ci, interaction, gameManager, state, userId);
        break;
      case "select_participants":
        await handleParticipantPick(ci, state, userId);
        break;
      case "select_role":
        await handleRolePick(ci, state, userId);
        break;
      case "adjust_role":
        await handleRoleAdjust(ci, state, userId);
        break;
      case "select_time":
        await handleTimePick(ci, state, userId);
        break;
    }
  }
}

function buildEmbed(state: InteractiveState): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("人狼 設定パネル")
    .setColor(0x00ff00)
    .addFields(
      { name: "参加者", value: state.participants.length > 0 ? `${state.participants.length}人` : "未設定", inline: true },
      { name: "会議時間", value: `${state.meetingMinutes}分`, inline: true },
      { name: "役職内訳", value: ROLE_OPTIONS.map((r) => `${r.key}: ${state.roleCounts[r.key]}人`).join("\n"), inline: false },
    );
}

async function render(interaction: ChatInputCommandInteraction, state: InteractiveState) {
  if (state.page === "main") {
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("set_participants").setLabel("参加者を設定").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("set_roles").setLabel("役職を設定").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("set_time").setLabel("会議時間").setStyle(ButtonStyle.Primary),
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("save").setLabel("保存").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("cancel").setLabel("キャンセル").setStyle(ButtonStyle.Danger),
    );
    await interaction.editReply({ embeds: [buildEmbed(state)], components: [row1, row2] });
  } else if (state.page === "select_participants") {
    const guild = interaction.guild!;
    const members = [...guild.members.cache.values()].filter((m) => !m.user.bot).slice(0, 25);
    const select = new StringSelectMenuBuilder()
      .setCustomId("pick")
      .setPlaceholder("参加者を選んでください（最低4人）")
      .setMinValues(4)
      .setMaxValues(members.length)
      .addOptions(
        members.map((m) =>
          new StringSelectMenuOptionBuilder().setLabel(m.displayName).setValue(m.id).setDescription(`@${m.user.username}`)
        )
      );
    const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("back").setLabel("戻る").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ content: "参加者を選んでください（最低4人）", embeds: [], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), back] });
  } else if (state.page === "select_role") {
    const select = new StringSelectMenuBuilder()
      .setCustomId("pick")
      .setPlaceholder("設定する役職を選ぶ")
      .addOptions(
        ROLE_OPTIONS.map((r) =>
          new StringSelectMenuOptionBuilder().setLabel(`${r.key} (現在: ${state.roleCounts[r.key]})`).setValue(r.key)
        )
      );
    const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("back").setLabel("戻る").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ content: "変更する役職を選んでください。", embeds: [], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), back] });
  } else if (state.page === "adjust_role") {
    const key = state.selectedRoleKey!;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("dec").setLabel("ー1").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("inc").setLabel("＋1").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("back").setLabel("戻る").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ content: `**${key}**: 現在 ${state.roleCounts[key]}人`, embeds: [], components: [row] });
  } else if (state.page === "select_time") {
    const select = new StringSelectMenuBuilder()
      .setCustomId("pick")
      .setPlaceholder("会議時間を選んでください")
      .addOptions(
        [1, 2, 3, 5, 10, 15, 20, 30].map((m) =>
          new StringSelectMenuOptionBuilder().setLabel(`${m}分`).setValue(String(m))
        )
      );
    const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("back").setLabel("戻る").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ content: "会議時間を選んでください。", embeds: [], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), back] });
  }
}

async function waitForAction(
  interaction: ChatInputCommandInteraction,
  state: InteractiveState,
  userId: string,
): Promise<MessageComponentInteraction | null> {
  try {
    const ci = await interaction.channel?.awaitMessageComponent({
      filter: (i: any) => i.user.id === userId,
      time: 120000,
    });
    return ci ?? null;
  } catch {
    return null;
  }
}

async function handleMainAction(
  ci: MessageComponentInteraction,
  interaction: ChatInputCommandInteraction,
  gameManager: GameManager,
  state: InteractiveState,
  userId: string,
): Promise<boolean> {
  if (ci.customId === "cancel") {
    await ci.update({ content: "設定をキャンセルしました。", embeds: [], components: [] });
    return false;
  }

  if (ci.customId === "save") {
    if (state.participants.length < 4) {
      await ci.reply({ content: "参加者が4人未満です。", flags: EPHEMERAL });
      return true;
    }
    await ci.deferUpdate();
    const get = (k: string) => state.roleCounts[k] ?? 0;
    const result = await gameManager.setSetting(
      interaction.guildId!, userId, state.participants,
      get("人狼"), get("共犯者"), get("狂人"), get("狂信者"),
      get("妖狐"), get("占い師"), get("霊媒師"), get("騎士"),
      get("てるてる坊主"), get("猫又"), get("黒猫"),
      state.meetingMinutes,
    );
    await interaction.editReply({ content: result, embeds: [], components: [] });
    return false;
  }

  await ci.deferUpdate();
  if (ci.customId === "set_participants") state.page = "select_participants";
  else if (ci.customId === "set_roles") state.page = "select_role";
  else if (ci.customId === "set_time") state.page = "select_time";
  return true;
}

async function handleParticipantPick(ci: MessageComponentInteraction, state: InteractiveState, userId: string) {
  if (ci.customId === "back") {
    await ci.deferUpdate();
    state.page = "main";
    return;
  }
  if (!ci.isStringSelectMenu()) return;
  state.participants = ci.values;
  await ci.update({ content: `${ci.values.length}人を選択しました。`, components: [] });
  state.page = "main";
}

async function handleRolePick(ci: MessageComponentInteraction, state: InteractiveState, userId: string) {
  if (ci.customId === "back") {
    await ci.deferUpdate();
    state.page = "main";
    return;
  }
  if (!ci.isStringSelectMenu()) return;
  state.selectedRoleKey = ci.values[0];
  await ci.deferUpdate();
  state.page = "adjust_role";
}

async function handleRoleAdjust(ci: MessageComponentInteraction, state: InteractiveState, userId: string) {
  const key = state.selectedRoleKey!;
  const current = state.roleCounts[key];

  if (ci.customId === "back") {
    state.page = "select_role";
    await ci.deferUpdate();
    return;
  }

  if (ci.customId === "inc") {
    const max = ROLE_OPTIONS.find((r) => r.key === key)?.role === RoleType.WEREWOLF ? 5 : 3;
    if (current >= max) {
      await ci.reply({ content: `最大${max}人までです。`, flags: EPHEMERAL });
      return;
    }
    state.roleCounts[key] = current + 1;
  } else if (ci.customId === "dec") {
    if (current <= 0) {
      await ci.reply({ content: "0人以下にはできません。", flags: EPHEMERAL });
      return;
    }
    state.roleCounts[key] = current - 1;
  }

  await ci.deferUpdate();
}

async function handleTimePick(ci: MessageComponentInteraction, state: InteractiveState, userId: string) {
  if (ci.customId === "back") {
    await ci.deferUpdate();
    state.page = "main";
    return;
  }
  if (!ci.isStringSelectMenu()) return;
  state.meetingMinutes = parseInt(ci.values[0]);
  await ci.update({ content: `会議時間: ${state.meetingMinutes}分`, components: [] });
  state.page = "main";
}
