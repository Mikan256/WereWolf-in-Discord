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
import { GameMode, RoleType } from "../game/types";

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

const ONENIGHT_ROLE_OPTIONS: { key: string; role: RoleType; default: number }[] = [
  { key: "市民", role: RoleType.VILLAGER, default: 0 },
  { key: "人狼", role: RoleType.WEREWOLF, default: 1 },
  { key: "占い師", role: RoleType.FORTUNE_TELLER, default: 1 },
  { key: "怪盗", role: RoleType.ROBBER, default: 0 },
  { key: "トラブルメーカー", role: RoleType.TROUBLEMAKER, default: 0 },
  { key: "酔っ払い", role: RoleType.DRUNK, default: 0 },
  { key: "失眠症", role: RoleType.INSOMNIAC, default: 0 },
  { key: "狩人", role: RoleType.HUNTER_ONENIGHT, default: 0 },
  { key: "皮なめし職人", role: RoleType.TANNER, default: 0 },
];

function getRoleOptions(mode: GameMode): { key: string; role: RoleType; default: number }[] {
  if (mode === GameMode.ONENIGHT) return ONENIGHT_ROLE_OPTIONS;
  if (mode === GameMode.GISHINANKI) return [];
  return ROLE_OPTIONS;
}

type Page = "main" | "select_participants" | "select_role" | "adjust_role" | "select_time";

interface InteractiveState {
  participants: string[];
  roleCounts: Record<string, number>;
  meetingMinutes: number;
  page: Page;
  selectedRoleKey: string | null;
  anonymousVoting: boolean;
  gameMode: GameMode;
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
  );

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

  const modeStr = interaction.options.getString("ゲームモード") ?? "classic";
  const gameMode: GameMode = modeStr === "oneten" ? GameMode.ONENIGHT : modeStr === "gishinanki" ? GameMode.GISHINANKI : GameMode.CLASSIC;
  const minPlayers = gameMode === GameMode.CLASSIC ? 4 : gameMode === GameMode.ONENIGHT ? 3 : 2;

  if (participantIds.length < minPlayers) {
    await interaction.reply({ content: `最低${minPlayers}人以上の参加者が必要です。`, flags: EPHEMERAL });
    return;
  }

  await interaction.deferReply();

  const opt = (name: string): number => interaction.options.getInteger(name) ?? 0;
  const optOrDefault = (name: string, def: number): number => {
    const v = interaction.options.getInteger(name);
    return v !== null ? v : def;
  };

  const anonymousVoting = interaction.options.getBoolean("匿名投票") ?? true;
  const meetingTime = optOrDefault("会議時間", 3);

  let roleDistribution: Partial<Record<RoleType, number>> = {};
  if (gameMode === GameMode.CLASSIC) {
    roleDistribution = {
      [RoleType.WEREWOLF]: optOrDefault("人狼", 1),
      [RoleType.ACCOMPLICE]: opt("共犯者"),
      [RoleType.MADMAN]: opt("狂人"),
      [RoleType.FANATIC]: opt("狂信者"),
      [RoleType.FOX]: opt("妖狐"),
      [RoleType.FORTUNE_TELLER]: optOrDefault("占い師", 1),
      [RoleType.MEDIUM]: opt("霊媒師"),
      [RoleType.KNIGHT]: opt("騎士"),
      [RoleType.TERU_TERU]: opt("てるてる坊主"),
      [RoleType.NEKOMATA]: opt("猫又"),
      [RoleType.BLACK_CAT]: opt("黒猫"),
    };
    for (const [k, v] of Object.entries(roleDistribution)) {
      if (v === 0) delete roleDistribution[k as unknown as keyof typeof roleDistribution];
    }
  }

  await gameManager.setSetting(
    interaction.guildId!,
    interaction.user.id,
    participantIds,
    roleDistribution,
    meetingTime,
    anonymousVoting,
    gameMode,
  );

  const modeName = gameMode === GameMode.CLASSIC ? "通常人狼" : gameMode === GameMode.ONENIGHT ? "ワンナイト人狼" : "ギシンアンキ";

  let detail = "";
  if (gameMode === GameMode.GISHINANKI) {
    detail = `参加者: ${participantIds.length}人\n（ギシンアンキは2人固定、役職は自動配布されます）`;
  } else if (gameMode === GameMode.CLASSIC) {
    detail =
      `人狼: ${optOrDefault("人狼", 1)} / 共犯者: ${opt("共犯者")} / 狂人: ${opt("狂人")} / 狂信者: ${opt("狂信者")}\n` +
      `妖狐: ${opt("妖狐")} / 占い師: ${optOrDefault("占い師", 1)} / 霊媒師: ${opt("霊媒師")} / 騎士: ${opt("騎士")}\n` +
      `てるてる坊主: ${opt("てるてる坊主")} / 猫又: ${opt("猫又")} / 黒猫: ${opt("黒猫")}\n`;
  } else {
    detail = `参加者: ${participantIds.length}人\n`;
  }

  const s =
    `**設定完了**\nモード: ${modeName}\n${detail}` +
    (gameMode !== GameMode.GISHINANKI ? `会議時間: ${meetingTime}分\n` : "") +
    (gameMode !== GameMode.GISHINANKI ? `投票公開: ${anonymousVoting ? "匿名" : "公開"}` : "");

  await interaction.editReply(s);
}

async function executeInteractive(interaction: ChatInputCommandInteraction, gameManager: GameManager) {
  const loaded = gameManager.loadSettings(interaction.guildId!);
  const mode = loaded?.settings.gameMode ?? GameMode.CLASSIC;
  const options = getRoleOptions(mode);
  const defaultRoleCounts = Object.fromEntries(options.map((r) => [r.key, r.default]));
  if (loaded) {
    for (const [role, count] of Object.entries(loaded.settings.roleDistribution)) {
      const key = options.find((r) => r.role === role)?.key;
      if (key) defaultRoleCounts[key] = count as number;
    }
  }

  const state: InteractiveState = {
    participants: loaded?.participants ?? [],
    roleCounts: defaultRoleCounts,
    meetingMinutes: loaded?.settings.meetingTimeMinutes ?? 3,
    page: "main",
    selectedRoleKey: null,
    anonymousVoting: loaded?.settings.anonymousVoting ?? true,
    gameMode: mode,
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

function getModeName(mode: GameMode): string {
  return mode === GameMode.CLASSIC ? "通常人狼" : mode === GameMode.ONENIGHT ? "ワンナイト人狼" : "ギシンアンキ";
}

function getModeColor(mode: GameMode): number {
  return mode === GameMode.CLASSIC ? 0x00ff00 : mode === GameMode.ONENIGHT ? 0xff9900 : 0xaa00ff;
}

function buildEmbed(state: InteractiveState): EmbedBuilder {
  const isGishin = state.gameMode === GameMode.GISHINANKI;
  const embed = new EmbedBuilder()
    .setTitle("人狼 設定パネル")
    .setColor(getModeColor(state.gameMode))
    .addFields(
      { name: "ゲームモード", value: getModeName(state.gameMode), inline: true },
      { name: "参加者", value: state.participants.length > 0 ? `${state.participants.length}人` : "未設定", inline: true },
    );

  if (!isGishin) {
    embed.addFields(
      { name: "会議時間", value: `${state.meetingMinutes}分`, inline: true },
      { name: "投票表示", value: state.anonymousVoting ? "匿名" : "公開", inline: true },
    );
  }

  if (isGishin) {
    embed.addFields({ name: "役職", value: "自動配布（生存者×3/人間不信×2/人狼×2）", inline: false });
  } else {
    const options = getRoleOptions(state.gameMode);
    embed.addFields({ name: "役職内訳", value: options.map((r) => `${r.key}: ${state.roleCounts[r.key]}人`).join("\n"), inline: false });
  }

  return embed;
}

async function render(interaction: ChatInputCommandInteraction, state: InteractiveState) {
  if (state.page === "main") {
    const isGishin = state.gameMode === GameMode.GISHINANKI;
    const modeLabel = `モード: ${getModeName(state.gameMode)}`;
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("set_participants").setLabel("参加者を設定").setStyle(ButtonStyle.Primary),
    );
    if (!isGishin) {
      row1.addComponents(
        new ButtonBuilder().setCustomId("set_roles").setLabel("役職を設定").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("set_time").setLabel("会議時間").setStyle(ButtonStyle.Primary),
      );
    }
    const modeStyle = state.gameMode === GameMode.GISHINANKI ? ButtonStyle.Danger : state.gameMode === GameMode.ONENIGHT ? ButtonStyle.Success : ButtonStyle.Secondary;
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("toggle_mode").setLabel(modeLabel).setStyle(modeStyle),
    );
    if (!isGishin) {
      row2.addComponents(
        new ButtonBuilder().setCustomId("toggle_anonymous")
          .setLabel(state.anonymousVoting ? "投票公開: 匿名" : "投票公開: 公開")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("save").setLabel("保存").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("cancel").setLabel("キャンセル").setStyle(ButtonStyle.Danger),
    );
    await interaction.editReply({ embeds: [buildEmbed(state)], components: [row1, row2, row3] });
  } else if (state.page === "select_participants") {
    const guild = interaction.guild!;
    const members = [...guild.members.cache.values()].filter((m) => !m.user.bot).slice(0, 25);
    const minPlayers = state.gameMode === GameMode.CLASSIC ? 4 : state.gameMode === GameMode.ONENIGHT ? 3 : 2;
    const select = new StringSelectMenuBuilder()
      .setCustomId("pick")
      .setPlaceholder(`参加者を選んでください（最低${minPlayers}人）`)
      .setMinValues(minPlayers)
      .setMaxValues(members.length)
      .addOptions(
        members.map((m) =>
          new StringSelectMenuOptionBuilder().setLabel(m.displayName).setValue(m.id).setDescription(`@${m.user.username}`)
        )
      );
    const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("back").setLabel("戻る").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ content: `参加者を選んでください（最低${minPlayers}人）`, embeds: [], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), back] });
  } else if (state.page === "select_role") {
    const options = getRoleOptions(state.gameMode);
    const select = new StringSelectMenuBuilder()
      .setCustomId("pick")
      .setPlaceholder("設定する役職を選ぶ")
      .addOptions(
        options.map((r) =>
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
    const minPlayers = state.gameMode === GameMode.CLASSIC ? 4 : state.gameMode === GameMode.ONENIGHT ? 3 : 2;
    if (state.participants.length < minPlayers) {
      await ci.reply({ content: `参加者が${minPlayers}人未満です。`, flags: EPHEMERAL });
      return true;
    }
    if (state.gameMode === GameMode.GISHINANKI && state.participants.length !== 2) {
      await ci.reply({ content: "ギシンアンキは2人専用です。", flags: EPHEMERAL });
      return true;
    }
    await ci.deferUpdate();
    try {
      const options = getRoleOptions(state.gameMode);
      const roleDistribution: Partial<Record<RoleType, number>> = {};
      for (const opt of options) {
        const count = state.roleCounts[opt.key] ?? 0;
        if (count > 0) roleDistribution[opt.role] = count;
      }
      const result = await gameManager.setSetting(
        interaction.guildId!, userId, state.participants,
        roleDistribution, state.meetingMinutes, state.anonymousVoting, state.gameMode,
      );
      const modeName = getModeName(state.gameMode);
      await ci.editReply({ content: `**設定完了**\nモード: ${modeName}\n${result}`, embeds: [], components: [] });
    } catch (e) {
      console.error("Save error:", e);
      await ci.editReply({ content: "設定の保存中にエラーが発生しました。", embeds: [], components: [] }).catch(() => {});
    }
    return false;
  }

  if (ci.customId === "toggle_anonymous") {
    state.anonymousVoting = !state.anonymousVoting;
    await ci.deferUpdate();
    return true;
  }

  if (ci.customId === "toggle_mode") {
    const modes = [GameMode.CLASSIC, GameMode.ONENIGHT, GameMode.GISHINANKI];
    const idx = modes.indexOf(state.gameMode);
    const newMode = modes[(idx + 1) % modes.length];
    state.gameMode = newMode;
    const newOptions = getRoleOptions(newMode);
    state.roleCounts = Object.fromEntries(newOptions.map((r) => [r.key, r.default]));
    await ci.deferUpdate();
    return true;
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
    const options = getRoleOptions(state.gameMode);
    const max = options.find((r) => r.key === key)?.role === RoleType.WEREWOLF ? 5 : 3;
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
