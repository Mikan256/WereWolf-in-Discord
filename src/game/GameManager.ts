import {
  Client,
  Guild,
  TextChannel,
  VoiceChannel,
  OverwriteType,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
} from "discord.js";
import {
  GameMode,
  GamePhase,
  GameSettings,
  GameState,
  RoleType,
  Team,
  ROLE_DEFINITIONS,
  ONENIGHT_ROLE_DEFINITIONS,
  GISHINANKI_ROLE_DEFINITIONS,
} from "./types";
import {
  distributeRoles,
  getRoleName,
  getRoleDescription,
  getFortuneResult,
  getTeam,
  isTrueWerewolf,
  isCountedAsVillager,
  shuffle,
} from "./roles";
import { PersistenceManager } from "../utils/persistence";

const EPHEMERAL = 64;

function log(guildId: string, msg: string): void {
  console.log(`[Game ${guildId.slice(0, 8)}] ${msg}`);
}

export class GameManager {
  private games: Map<string, GameState> = new Map();
  private client: Client;
  private persistence: PersistenceManager;

  constructor(client: Client, persistence: PersistenceManager) {
    this.client = client;
    this.persistence = persistence;
    console.log("[Bot] GameManager initialized");
  }

  getGame(guildId: string): GameState | undefined {
    return this.games.get(guildId);
  }

  createGame(guildId: string, hostUserId: string): GameState {
    const persisted = this.persistence.getSettings(guildId);
    const settings = persisted
      ? { gameMode: persisted.gameMode ?? GameMode.CLASSIC, meetingTimeMinutes: persisted.meetingTimeMinutes, roleDistribution: { ...persisted.roleDistribution }, anonymousVoting: persisted.anonymousVoting ?? true }
      : { gameMode: GameMode.CLASSIC, meetingTimeMinutes: 3, roleDistribution: {}, anonymousVoting: true };

    const game: GameState = {
      guildId, hostUserId,
      phase: GamePhase.WAITING,
      settings,
      players: new Map(), participants: persisted?.participants ?? [], dayCount: 0,
      gameTextChannelId: null, gameVoiceChannelId: null,
      werewolfTextChannelId: null, spectatorTextChannelId: null,
      waitingVoiceChannelId: null,
      votes: new Map(), nightActionResult: [],
      meetingTimer: null, nightActionTimeout: null,
      centerRoles: [], nightActionStep: 0,
      originalRoles: new Map(),
      gishinDeck: [], gishinHands: new Map(),
      gishinActionTokens: new Map(), gishinDecisions: new Map(),
      gishinReady: [], gishinRequestPending: null,
      gishinExchanges: false,
    };
    this.games.set(guildId, game);
    log(guildId, `Game created by <${hostUserId}>, settings loaded from persistence: ${!!persisted}`);
    return game;
  }

  deleteGame(guildId: string): void {
    log(guildId, "Game state deleted from memory");
    this.games.delete(guildId);
  }

  /** メモリ上にゲームが無ければ、永続化された設定から復元する */
  private ensureGame(guildId: string): GameState | undefined {
    const existing = this.games.get(guildId);
    if (existing) return existing;
    const persisted = this.persistence.getSettings(guildId);
    if (!persisted) return undefined;
    return this.createGame(guildId, persisted.hostUserId);
  }

  async setSetting(
    guildId: string, hostUserId: string, participants: string[],
    roleDistribution: Partial<Record<RoleType, number>>,
    meetingTimeMinutes: number,
    anonymousVoting?: boolean, gameMode?: GameMode,
  ): Promise<string> {
    let game = this.games.get(guildId);
    if (!game) game = this.createGame(guildId, hostUserId);
    if (game.hostUserId !== hostUserId) return "ホストのみが設定を変更できます。";
    if (game.phase !== GamePhase.WAITING) return "ゲームが進行中のため設定を変更できません。";

    const isGishinAnki = gameMode === GameMode.GISHINANKI;
    if (!isGishinAnki) {
      const total = Object.values(roleDistribution).reduce((a, b) => a + b, 0);
      if (gameMode === GameMode.CLASSIC && total > participants.length) {
        return "参加者数より役職数の合計が多いです。";
      }
      if (gameMode === GameMode.ONENIGHT && total > participants.length + 3) {
        return "役職数の合計が多すぎます（最大: 参加者数 + 3）。";
      }
    }
    if (isGishinAnki && participants.length !== 2) {
      return "ギシンアンキは2人専用です。";
    }
    if (!isGishinAnki && (roleDistribution[RoleType.WEREWOLF] ?? 0) < 1) {
      return "人狼を1人以上設定してください。";
    }

    game.participants = participants;
    game.settings.roleDistribution = { ...roleDistribution };
    game.settings.meetingTimeMinutes = meetingTimeMinutes;
    if (anonymousVoting !== undefined) game.settings.anonymousVoting = anonymousVoting;
    if (gameMode !== undefined) game.settings.gameMode = gameMode;

    log(guildId, `Settings updated: participants=${participants.length}, roles=${JSON.stringify(game.settings.roleDistribution)}, meetingTime=${meetingTimeMinutes}min, anonymousVoting=${game.settings.anonymousVoting}, gameMode=${game.settings.gameMode}`);

    try {
      await this.persistence.setSettings(guildId, {
        hostUserId,
        participants,
        roleDistribution: { ...game.settings.roleDistribution },
        meetingTimeMinutes,
        anonymousVoting: game.settings.anonymousVoting,
        gameMode: game.settings.gameMode,
      });
    } catch (e) {
      log(guildId, `Persistence save failed: ${e}`);
      return "設定の保存に失敗しました。保存先のストレージ設定を確認してください。";
    }

    return "設定が完了しました。`/start` でゲームを開始できます。";
  }

  async startGame(guildId: string, userId: string): Promise<string> {
    const game = this.ensureGame(guildId);
    if (!game) return "設定が行われていません。先に `/setting` を行ってください。";
    if (game.hostUserId !== userId) return "ホストのみがゲームを開始できます。";
    if (game.phase !== GamePhase.WAITING) return "すでにゲームが開始されています。";
    const minPlayers = game.settings.gameMode === GameMode.ONENIGHT ? 3 : game.settings.gameMode === GameMode.GISHINANKI ? 2 : 4;
    if (game.participants.length < minPlayers) return `最低${minPlayers}人以上の参加者が必要です。`;
    if (game.settings.gameMode === GameMode.GISHINANKI && game.participants.length > 2) return "ギシンアンキは2人専用です。";
    if (game.settings.gameMode !== GameMode.GISHINANKI && (game.settings.roleDistribution[RoleType.WEREWOLF] ?? 0) < 1) {
      return "人狼が設定されていません。`/setting` で人狼を1人以上設定してください。";
    }
    log(guildId, `Host <${userId}> starting game with ${game.participants.length} players (mode: ${game.settings.gameMode})`);

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return "ギルドが見つかりません。";

    // 参加者がサーバーから退出しているとチャンネル作成などが失敗するため、事前に確認する
    const missingMembers: string[] = [];
    for (const pid of game.participants) {
      try {
        await guild.members.fetch(pid);
      } catch {
        missingMembers.push(pid);
      }
    }
    if (missingMembers.length > 0) {
      return `次のユーザーがサーバーにいないため開始できません: ${missingMembers.map((id) => `<@${id}>`).join(", ")}`;
    }

    if (game.settings.gameMode === GameMode.ONENIGHT) {
      try {
        return await this.startOneNightGame(guild, game);
      } catch (error) {
        return this.abortStart(guild, game, error);
      }
    }

    if (game.settings.gameMode === GameMode.GISHINANKI) {
      try {
        return await this.startGishinAnkiGame(guild, game);
      } catch (error) {
        return this.abortStart(guild, game, error);
      }
    }

    try {
      await this.createGameChannels(guild, game);
      const roleMap = distributeRoles(game.participants, game.settings.roleDistribution);

      for (const pid of game.participants) {
        const role = roleMap.get(pid)!;
        game.players.set(pid, { userId: pid, role, team: getTeam(role), isAlive: true, isProtected: false });
      }

      await this.sendRoleMessages(guild, game);

      const werewolfIds = game.participants.filter((p) => game.players.get(p)!.role === RoleType.WEREWOLF);

      const wwChannel = game.werewolfTextChannelId
        ? (guild.channels.cache.get(game.werewolfTextChannelId) as TextChannel | undefined) : undefined;

      if (wwChannel) {
        for (const wid of werewolfIds) {
          await wwChannel.permissionOverwrites.create(wid, { ViewChannel: true, SendMessages: false });
        }
      }

      if (werewolfIds.length > 0 && wwChannel) {
        const names = werewolfIds.map((id) => `<@${id}>`).join(", ");
        await wwChannel.send(`**人狼メンバー**: ${names}\n夜になったらここで襲撃する相手を相談してください。`);
      }

      if (game.waitingVoiceChannelId) {
        const waitingVC = guild.channels.cache.get(game.waitingVoiceChannelId) as VoiceChannel | undefined;
        if (waitingVC) {
          const specChannelId = game.spectatorTextChannelId;
          for (const member of [...waitingVC.members.values()]) {
            if (!game.participants.includes(member.id)) {
              try { await member.voice.setMute(true); } catch {}
              if (specChannelId) {
                const specCh = guild.channels.cache.get(specChannelId) as TextChannel | undefined;
                if (specCh) {
                  try { await specCh.permissionOverwrites.create(member.id, { ViewChannel: true, SendMessages: true }); } catch {}
                }
              }
            }
          }
        }
      }

      const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
      if (specChannel) {
        let specMsg = "**全プレイヤーの役職:**\n";
        for (const pid of game.participants) {
          const ps = game.players.get(pid)!;
          specMsg += `<@${pid}>: ${getRoleName(ps.role)}\n`;
        }
        await specChannel.send(specMsg);
      }

      game.dayCount = 1;

      log(guildId, `Game started with ${game.participants.length} players`);
      await this.startDayDiscussion(guild, game);
      return "ゲームを開始しました！";
    } catch (error) {
      console.error(error);
      await this.cleanupGame(guildId).catch(() => {});
      return "ゲーム開始中にエラーが発生しました。";
    }
  }

  /** 開始途中で失敗したゲームを待機状態に戻す */
  private async abortStart(guild: Guild, game: GameState, error: unknown): Promise<string> {
    console.error(`[Game ${guild.id.slice(0, 8)}] Failed to start game:`, error);
    if (game.gameTextChannelId) {
      const ch = guild.channels.cache.get(game.gameTextChannelId);
      if (ch) {
        try { await ch.delete(); } catch {}
      }
      game.gameTextChannelId = null;
    }
    game.phase = GamePhase.WAITING;
    return "ゲーム開始中にエラーが発生しました。";
  }

  // ===== One Night Werewolf =====

  private async startOneNightGame(guild: Guild, game: GameState): Promise<string> {
    game.phase = GamePhase.NIGHT;
    game.dayCount = 1;

    const gameChannel = await guild.channels.create({
      name: "ワンナイト人狼", type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: ["ViewChannel"], type: OverwriteType.Role },
        ...game.participants.map((pid) => ({
          id: pid, allow: ["ViewChannel", "SendMessages"] as const, type: OverwriteType.Member as const,
        })),
      ],
    });
    game.gameTextChannelId = gameChannel.id;

    await gameChannel.send("**ワンナイト人狼を開始します！**\nまもなく夜になります。各プレイヤーにDMで夜のアクションが送られます。");

    this.prepareOneNightRoles(game);

    for (const pid of game.participants) {
      const ps = game.players.get(pid)!;
      game.originalRoles.set(pid, ps.role);
    }

    log(guild.id, `OneNight game started with ${game.participants.length} players, center: ${game.centerRoles.map((r) => getRoleName(r)).join(", ")}`);

    await this.sendOneNightRoleMessages(guild, game);
    // 夜の進行は完了まで数分かかるため、/start の応答を待たせない
    void this.runOneNightNightSequence(guild, game).catch((error) => {
      console.error(`[Game ${guild.id.slice(0, 8)}] OneNight night sequence failed:`, error);
    });
    return "ゲームを開始しました！";
  }

  private prepareOneNightRoles(game: GameState): void {
    const pool: RoleType[] = [];
    for (const [role, count] of Object.entries(game.settings.roleDistribution)) {
      for (let i = 0; i < (count as number); i++) {
        pool.push(role as RoleType);
      }
    }
    const remaining = (game.participants.length + 3) - pool.length;
    for (let i = 0; i < remaining; i++) {
      pool.push(RoleType.VILLAGER);
    }

    const shuffled = shuffle(pool);
    for (let i = 0; i < game.participants.length; i++) {
      const role = shuffled[i];
      game.players.set(game.participants[i], {
        userId: game.participants[i], role, team: getTeam(role), isAlive: true, isProtected: false,
      });
    }
    game.centerRoles = shuffled.slice(game.participants.length);
  }

  private async sendOneNightRoleMessages(guild: Guild, game: GameState): Promise<void> {
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("oneten_reveal_role")
        .setLabel("自分の役職を確認する")
        .setStyle(ButtonStyle.Secondary),
    );

    await gameChannel.send({
      content: "**役職を確認するには、下のボタンをクリックしてください。**\n（クリックするとあなただけに見える形で役職が表示されます）",
      components: [row],
    });

    const collector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === "oneten_reveal_role" && game.participants.includes(i.user.id),
      time: 30000,
    });

    collector.on("collect", async (i) => {
      const ps = game.players.get(i.user.id);
      if (!ps) {
        await i.reply({ content: "役職情報が見つかりません。", flags: EPHEMERAL });
        return;
      }
      // 夜のアクション中にカードが入れ替わるため、配布時の役職を表示する
      const originalRole = game.originalRoles.get(i.user.id) ?? ps.role;
      const def = ONENIGHT_ROLE_DEFINITIONS[originalRole] ?? ROLE_DEFINITIONS[originalRole];
      let msg = `あなたの役職は **${def.name}** です！\n${this.getOneNightRoleDesc(originalRole)}\n勝利条件: ${def.winCondition}`;

      if (originalRole === RoleType.WEREWOLF) {
        const wolfIds = game.participants.filter(
          (p) => (game.originalRoles.get(p) ?? game.players.get(p)?.role) === RoleType.WEREWOLF && p !== i.user.id
        );
        if (wolfIds.length > 0) {
          msg += `\n\n**他の人狼**: ${wolfIds.map((id) => `<@${id}>`).join(", ")}`;
        } else {
          msg += "\n\n他の人狼はいません。";
        }
      }

      await i.reply({ content: msg, flags: EPHEMERAL });
    });
  }

  private getOneNightRoleDesc(role: RoleType): string {
    const descs: Partial<Record<RoleType, string>> = {
      [RoleType.VILLAGER]: "特殊な能力はありません。議論と投票で人狼を見つけ出しましょう。",
      [RoleType.WEREWOLF]: "夜に他の人狼が誰かを確認できます。自分が人狼であることを隠してください。",
      [RoleType.FORTUNE_TELLER]: "夜にプレイヤー1人の役職カードを見るか、センターカード2枚を確認できます。",
      [RoleType.ROBBER]: "夜に他のプレイヤー1人と役職カードを交換し、交換後の自分の役職を確認します。",
      [RoleType.TROUBLEMAKER]: "夜に自分以外のプレイヤー2人を選び、その役職カードを交換します。中身は見えません。",
      [RoleType.DRUNK]: "夜に自分の役職カードをセンターカードのいずれか1枚と交換します。中身は見えません。",
      [RoleType.INSOMNIAC]: "夜の最後に自分の現在の役職を確認します。自分が交換されたかどうかを知ることができます。",
      [RoleType.HUNTER_ONENIGHT]: "投票で追放された場合、自分に投票したプレイヤーの中からランダムに1人道連れにします。",
      [RoleType.TANNER]: "自分が追放されると単独勝利します。追放されることを目指しましょう。",
    };
    return descs[role] ?? getRoleDescription(role);
  }

  private async runOneNightNightSequence(guild: Guild, game: GameState): Promise<void> {
    const NIGHT_ORDER: RoleType[] = [
      RoleType.WEREWOLF,
      RoleType.FORTUNE_TELLER,
      RoleType.ROBBER,
      RoleType.TROUBLEMAKER,
      RoleType.DRUNK,
      RoleType.INSOMNIAC,
    ];

    game.nightActionStep = 0;
    game.nightActionResult = [];

    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    await gameChannel.send("**夜になりました。** 各プレイヤーにDMで順番にアクションが送られます。");

    await this.processOneNightStep(guild, game, NIGHT_ORDER, 0);
  }

  private async processOneNightStep(guild: Guild, game: GameState, order: RoleType[], index: number): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    if (index >= order.length) {
      await this.finalizeOneNightNight(guild, game);
      return;
    }

    const role = order[index];
    const playersWithRole = game.participants.filter((p) => game.players.get(p)?.role === role && game.players.get(p)?.isAlive);

    if (playersWithRole.length === 0) {
      await this.processOneNightStep(guild, game, order, index + 1);
      return;
    }

    game.nightActionStep = index;

    if (role === RoleType.WEREWOLF) {
      await this.handleOneNightWerewolf(guild, game, playersWithRole, () => {
        this.processOneNightStep(guild, game, order, index + 1);
      });
    } else if (role === RoleType.FORTUNE_TELLER) {
      await this.handleOneNightSeer(guild, game, playersWithRole, () => {
        this.processOneNightStep(guild, game, order, index + 1);
      });
    } else if (role === RoleType.ROBBER) {
      await this.handleOneNightRobber(guild, game, playersWithRole, () => {
        this.processOneNightStep(guild, game, order, index + 1);
      });
    } else if (role === RoleType.TROUBLEMAKER) {
      await this.handleOneNightTroublemaker(guild, game, playersWithRole, () => {
        this.processOneNightStep(guild, game, order, index + 1);
      });
    } else if (role === RoleType.DRUNK) {
      await this.handleOneNightDrunk(guild, game, playersWithRole, () => {
        this.processOneNightStep(guild, game, order, index + 1);
      });
    } else if (role === RoleType.INSOMNIAC) {
      await this.handleOneNightInsomniac(guild, game, playersWithRole, () => {
        this.processOneNightStep(guild, game, order, index + 1);
      });
    } else {
      await this.processOneNightStep(guild, game, order, index + 1);
    }
  }

  private async handleOneNightWerewolf(guild: Guild, game: GameState, wolfIds: string[], onDone: () => void): Promise<void> {
    for (const wid of wolfIds) {
      try {
        const member = await guild.members.fetch(wid);
        const otherWolves = wolfIds.filter((id) => id !== wid);
        let msg = "**人狼を確認しました。**";
        if (otherWolves.length > 0) {
          msg += `\n他の人狼メンバー: ${otherWolves.map((id) => `<@${id}>`).join(", ")}`;
        } else {
          msg += "\n他の人狼はいません。";
        }
        await member.send(msg).catch(() => {});
      } catch {}
    }
    onDone();
  }

  private async handleOneNightSeer(guild: Guild, game: GameState, seerIds: string[], onDone: () => void): Promise<void> {
    const processSeer = async (idx: number) => {
      if (idx >= seerIds.length) { onDone(); return; }
      const sid = seerIds[idx];
      try {
        const member = await guild.members.fetch(sid);
        const otherPlayers = game.participants.filter((p) => p !== sid);
        const names = await this.resolveDisplayNames(guild, otherPlayers);
        const select = new StringSelectMenuBuilder()
          .setCustomId("oneten_seer_target")
          .setPlaceholder("占う対象を選んでください")
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel("センターカード2枚を見る").setValue("center"),
            ...otherPlayers.map((p) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(names.get(p)!)
                .setValue(p)
            )
          );
        const msg = await member.send({
          content: "**占い師**: プレイヤー1人の役職を見るか、センターカード2枚を確認してください。",
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        }).catch(() => null);
        if (!msg) { await processSeer(idx + 1); return; }

        const filter = (i: any) => i.user.id === sid && i.customId === "oneten_seer_target";
        try {
          const ci = await msg.awaitMessageComponent({ filter, time: 60000 });
          if (!ci.isStringSelectMenu()) { await processSeer(idx + 1); return; }
          const target = ci.values[0];
          if (target === "center") {
            const c1 = getRoleName(game.centerRoles[0]);
            const c2 = getRoleName(game.centerRoles[1]);
            await ci.update({ content: `センターカード: **${c1}**, **${c2}**`, components: [] });
          } else {
            const targetRole = getRoleName(game.players.get(target)!.role);
            await ci.update({ content: `<@${target}> の役職: **${targetRole}**`, components: [] });
          }
        } catch { await msg.edit({ content: "時間切れです。", components: [] }).catch(() => {}); }
      } catch {}
      await processSeer(idx + 1);
    };
    await processSeer(0);
  }

  private async handleOneNightRobber(guild: Guild, game: GameState, robberIds: string[], onDone: () => void): Promise<void> {
    const processRobber = async (idx: number) => {
      if (idx >= robberIds.length) { onDone(); return; }
      const rid = robberIds[idx];
      try {
        const member = await guild.members.fetch(rid);
        const otherPlayers = game.participants.filter((p) => p !== rid);
        const names = await this.resolveDisplayNames(guild, otherPlayers);
        const select = new StringSelectMenuBuilder()
          .setCustomId("oneten_robber_target")
          .setPlaceholder("交換する相手を選んでください")
          .addOptions(
            otherPlayers.map((p) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(names.get(p)!)
                .setValue(p)
            )
          );
        const msg = await member.send({
          content: "**怪盗**: 交換するプレイヤーを1人選んでください。相手の役職を獲得し、自分の役職を相手に渡します。",
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        }).catch(() => null);
        if (!msg) { await processRobber(idx + 1); return; }

        const filter = (i: any) => i.user.id === rid && i.customId === "oneten_robber_target";
        try {
          const ci = await msg.awaitMessageComponent({ filter, time: 60000 });
          if (!ci.isStringSelectMenu()) { await processRobber(idx + 1); return; }
          const targetId = ci.values[0];
          const robberRole = game.players.get(rid)!.role;
          const targetRole = game.players.get(targetId)!.role;
          game.players.get(rid)!.role = targetRole;
          game.players.get(rid)!.team = getTeam(targetRole);
          game.players.get(targetId)!.role = robberRole;
          game.players.get(targetId)!.team = getTeam(robberRole);
          await ci.update({ content: `交換完了！あなたの新しい役職は **${getRoleName(targetRole)}** です。`, components: [] });
        } catch { await msg.edit({ content: "時間切れです。", components: [] }).catch(() => {}); }
      } catch {}
      await processRobber(idx + 1);
    };
    await processRobber(0);
  }

  private async handleOneNightTroublemaker(guild: Guild, game: GameState, tmIds: string[], onDone: () => void): Promise<void> {
    const processTM = async (idx: number) => {
      if (idx >= tmIds.length) { onDone(); return; }
      const tid = tmIds[idx];
      try {
        const member = await guild.members.fetch(tid);
        const otherPlayers = game.participants.filter((p) => p !== tid);
        if (otherPlayers.length < 2) { await processTM(idx + 1); return; }

        const names = await this.resolveDisplayNames(guild, otherPlayers);
        const select = new StringSelectMenuBuilder()
          .setCustomId("oneten_tm_target1")
          .setPlaceholder("1人目を選んでください")
          .setMinValues(1).setMaxValues(1)
          .addOptions(
            otherPlayers.map((p) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(names.get(p)!)
                .setValue(p)
            )
          );
        const msg = await member.send({
          content: "**トラブルメーカー**: 交換する2人のプレイヤーを選んでください。（まず1人目）",
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        }).catch(() => null);
        if (!msg) { await processTM(idx + 1); return; }

        let target1: string | null = null;
        try {
          const ci = await msg.awaitMessageComponent({
            filter: (i: any) => i.user.id === tid && i.customId === "oneten_tm_target1",
            time: 60000,
          });
          if (!ci.isStringSelectMenu()) { await processTM(idx + 1); return; }
          target1 = ci.values[0];
          const remaining = otherPlayers.filter((p) => p !== target1);
          const remainingNames = await this.resolveDisplayNames(guild, remaining);
          const select2 = new StringSelectMenuBuilder()
            .setCustomId("oneten_tm_target2")
            .setPlaceholder("2人目を選んでください")
            .setMinValues(1).setMaxValues(1)
            .addOptions(
              remaining.map((p) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(remainingNames.get(p)!)
                  .setValue(p)
              )
            );
          await ci.update({
            content: `**トラブルメーカー**: 交換するもう1人を選んでください。`,
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select2)],
          });

          const ci2 = await msg.awaitMessageComponent({
            filter: (i2: any) => i2.user.id === tid && i2.customId === "oneten_tm_target2",
            time: 60000,
          });
          if (!ci2.isStringSelectMenu()) { await processTM(idx + 1); return; }
          const target2 = ci2.values[0];
          const role1 = game.players.get(target1)!.role;
          const role2 = game.players.get(target2)!.role;
          game.players.get(target1)!.role = role2;
          game.players.get(target1)!.team = getTeam(role2);
          game.players.get(target2)!.role = role1;
          game.players.get(target2)!.team = getTeam(role1);
          const finalNames = await this.resolveDisplayNames(guild, [target1, target2]);
          await ci2.update({ content: `**${finalNames.get(target1)!}** と **${finalNames.get(target2)!}** の役職を交換しました。`, components: [] });
        } catch {
          await msg.edit({ content: "時間切れです。", components: [] }).catch(() => {});
        }
      } catch {}
      await processTM(idx + 1);
    };
    await processTM(0);
  }

  private async handleOneNightDrunk(guild: Guild, game: GameState, drunkIds: string[], onDone: () => void): Promise<void> {
    const processDrunk = async (idx: number) => {
      if (idx >= drunkIds.length) { onDone(); return; }
      const did = drunkIds[idx];
      try {
        const member = await guild.members.fetch(did);
        const select = new StringSelectMenuBuilder()
          .setCustomId("oneten_drunk_target")
          .setPlaceholder("交換するセンターカードを選んでください")
          .addOptions(
            game.centerRoles.map((_, ci) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(`センターカード ${ci + 1}`)
                .setValue(String(ci))
            )
          );
        const msg = await member.send({
          content: "**酔っ払い**: 交換するセンターカードを1枚選んでください。（中身は見えません）",
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        }).catch(() => null);
        if (!msg) { await processDrunk(idx + 1); return; }

        const filter = (i: any) => i.user.id === did && i.customId === "oneten_drunk_target";
        try {
          const ci = await msg.awaitMessageComponent({ filter, time: 60000 });
          if (!ci.isStringSelectMenu()) { await processDrunk(idx + 1); return; }
          const ciIdx = parseInt(ci.values[0]);
          const drunkRole = game.players.get(did)!.role;
          const centerRole = game.centerRoles[ciIdx];
          game.players.get(did)!.role = centerRole;
          game.players.get(did)!.team = getTeam(centerRole);
          game.centerRoles[ciIdx] = drunkRole;
          await ci.update({ content: "センターカードと交換しました。何になったかはわかりません。", components: [] });
        } catch { await msg.edit({ content: "時間切れです。", components: [] }).catch(() => {}); }
      } catch {}
      await processDrunk(idx + 1);
    };
    await processDrunk(0);
  }

  private async handleOneNightInsomniac(guild: Guild, game: GameState, insomIds: string[], onDone: () => void): Promise<void> {
    for (const iid of insomIds) {
      try {
        const member = await guild.members.fetch(iid);
        const currentRole = getRoleName(game.players.get(iid)!.role);
        await member.send(`**失眠症**: あなたの最終的な役職は **${currentRole}** です。`).catch(() => {});
      } catch {}
    }
    onDone();
  }

  private async finalizeOneNightNight(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    await gameChannel.send("**夜が明けました！** 会議を始めてください。");
    game.phase = GamePhase.DAY_DISCUSSION;

    if (game.meetingTimer) clearTimeout(game.meetingTimer);
    game.meetingTimer = setTimeout(async () => {
      await this.startOneNightVoting(guild, game);
    }, game.settings.meetingTimeMinutes * 60 * 1000);
  }

  private async startOneNightVoting(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    if (game.phase !== GamePhase.DAY_DISCUSSION) return;
    game.phase = GamePhase.DAY_VOTING;
    game.votes.clear();

    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);
    const names = await this.resolveDisplayNames(guild, alivePlayers);

    const embed = new EmbedBuilder()
      .setTitle("投票時間")
      .setDescription("追放するプレイヤーを投票で決めてください。\n下のボタンをクリックして投票してください。")
      .setColor(0xff0000);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("oneten_vote_open").setLabel("投票する").setStyle(ButtonStyle.Primary),
    );

    await gameChannel.send({ embeds: [embed], components: [row] });

    const collector = gameChannel.createMessageComponentCollector({
      filter: (i) => alivePlayers.includes(i.user.id),
      time: 60000,
    });

    let voteResolve: (() => void) | null = null;
    const tryResolve = () => {
      if (!voteResolve) return;
      if (alivePlayers.every((p) => game.votes.has(p))) {
        collector.stop();
        voteResolve();
        voteResolve = null;
      }
    };

    collector.on("collect", async (i) => {
      if (i.customId === "oneten_vote_open") {
        const current = game.votes.get(i.user.id);
        const select = new StringSelectMenuBuilder()
          .setCustomId("oneten_vote_target")
          .setPlaceholder(current !== undefined ? "投票先を変更する" : "投票先を選んでください")
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel("棄権").setValue("abstain"),
            ...alivePlayers.map((p) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(names.get(p)!)
                .setValue(p)
            )
          );
        const msg = current === undefined
          ? "追放したいプレイヤーを選んでください。（棄権も選択できます）"
          : `現在: ${current === null ? "棄権" : `<@${current}>`}\n変更する場合は選び直してください。`;
        await i.reply({
          content: msg,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
          flags: EPHEMERAL,
        });
      } else if (i.customId === "oneten_vote_target" && i.isStringSelectMenu()) {
        const target = i.values[0];
        if (target === "abstain") {
          game.votes.set(i.user.id, null);
          await i.update({ content: "あなたは **棄権** しました。", components: [] });
        } else {
          game.votes.set(i.user.id, target);
          await i.update({ content: `あなたは **<@${target}>** に投票しました。`, components: [] });
        }
        tryResolve();
      }
    });

    await new Promise<void>((resolve) => {
      voteResolve = resolve;
      setTimeout(() => {
        collector.stop();
        if (voteResolve) { voteResolve(); voteResolve = null; }
      }, 60000);
    });

    collector.stop();
    await this.processOneNightResults(guild, game);
  }

  private async processOneNightResults(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);

    const abstainCount = [...game.votes.values()].filter((v) => v === null).length;
    if (abstainCount > alivePlayers.length / 2) {
      await gameChannel.send(`過半数（${abstainCount}人）が棄権したため、投票は無効となりました。`);
      await this.finishOneNightGame(guild, game, null);
      return;
    }

    const voteCount = new Map<string, number>();
    for (const [, target] of game.votes) {
      if (target !== null) voteCount.set(target, (voteCount.get(target) || 0) + 1);
    }

    if (voteCount.size === 0) {
      await gameChannel.send("有効投票なし。誰も追放されませんでした。");
      await this.finishOneNightGame(guild, game, null);
      return;
    }

    const maxVotes = Math.max(...voteCount.values());
    const mostVoted: string[] = [];
    for (const [pid, count] of voteCount) { if (count === maxVotes) mostVoted.push(pid); }

    if (mostVoted.length > 1) {
      await gameChannel.send(`同票のため決選投票を行います。\n**候補**: ${mostVoted.map((id) => `<@${id}>`).join(", ")}`);
      await this.runOneNightRunoff(guild, game, mostVoted);
      return;
    }

    const eliminated = mostVoted[0];
    game.players.get(eliminated)!.isAlive = false;
    await gameChannel.send(`**追放**: <@${eliminated}> が追放されました！`);

    if (game.players.get(eliminated)?.role === RoleType.HUNTER_ONENIGHT) {
      await this.handleOneNightHunterDeath(guild, game, eliminated);
    }

    await this.finishOneNightGame(guild, game, eliminated);
  }

  private async runOneNightRunoff(guild: Guild, game: GameState, candidates: string[]): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);
    game.votes.clear();
    const candidateNames = await this.resolveDisplayNames(guild, candidates);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("oneten_runoff_open").setLabel("決選投票する").setStyle(ButtonStyle.Danger),
    );
    await gameChannel.send({ content: `**決選投票**\n候補: ${candidates.map((id) => `<@${id}>`).join(", ")}`, components: [row] });

    const collector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === "oneten_runoff_open" && alivePlayers.includes(i.user.id),
      time: 30000,
    });

    collector.on("collect", async (i) => {
      const select = new StringSelectMenuBuilder()
        .setCustomId("oneten_runoff_target")
        .setPlaceholder("投票先を選んでください")
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel("棄権").setValue("abstain"),
          ...candidates.map((c) =>
            new StringSelectMenuOptionBuilder().setLabel(candidateNames.get(c)!).setValue(c)
          )
        );
      await i.reply({
        content: "追放したいプレイヤーを選んでください。",
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        flags: EPHEMERAL,
      });
    });

    const selectCollector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === "oneten_runoff_target" && alivePlayers.includes(i.user.id),
      time: 30000,
    });

    let resolve: (() => void) | null = null;
    const tryResolve = () => {
      if (!resolve) return;
      if (alivePlayers.every((p) => game.votes.has(p))) {
        collector.stop();
        selectCollector.stop();
        resolve();
        resolve = null;
      }
    };

    selectCollector.on("collect", async (i) => {
      if (!i.isStringSelectMenu()) return;
      const target = i.values[0];
      if (target === "abstain") {
        game.votes.set(i.user.id, null);
        await i.update({ content: "棄権しました。", components: [] });
      } else {
        game.votes.set(i.user.id, target);
        await i.update({ content: `<@${target}> に投票しました。`, components: [] });
      }
      tryResolve();
    });

    await new Promise<void>((resolve2) => {
      resolve = resolve2;
      setTimeout(() => {
        collector.stop();
        selectCollector.stop();
        if (resolve) { resolve(); resolve = null; }
      }, 30000);
    });

    const abstainCount = [...game.votes.values()].filter((v) => v === null).length;
    if (abstainCount > alivePlayers.length / 2) {
      await gameChannel.send(`決選投票で過半数が棄権したため、投票は無効となりました。`);
      await this.finishOneNightGame(guild, game, null);
      return;
    }

    const voteCount = new Map<string, number>();
    for (const [, target] of game.votes) {
      if (target !== null) voteCount.set(target, (voteCount.get(target) || 0) + 1);
    }

    if (voteCount.size === 0) {
      await gameChannel.send("決選投票でも決着がつきませんでした。");
      await this.finishOneNightGame(guild, game, null);
      return;
    }

    const maxVotes = Math.max(...voteCount.values());
    const mostVoted: string[] = [];
    for (const [pid, count] of voteCount) { if (count === maxVotes) mostVoted.push(pid); }

    const eliminated = mostVoted[0];
    game.players.get(eliminated)!.isAlive = false;
    await gameChannel.send(`**追放**: <@${eliminated}> が追放されました！`);

    if (game.players.get(eliminated)?.role === RoleType.HUNTER_ONENIGHT) {
      await this.handleOneNightHunterDeath(guild, game, eliminated);
    }

    await this.finishOneNightGame(guild, game, eliminated);
  }

  private async handleOneNightHunterDeath(guild: Guild, game: GameState, hunterId: string): Promise<void> {
    const voters = [...game.votes.entries()]
      .filter(([voter, target]) => target === hunterId && voter !== hunterId)
      .map(([voter]) => voter);
    if (voters.length === 0) {
      await (guild.channels.cache.get(game.gameTextChannelId!) as TextChannel)
        .send("狩人が追放されましたが、投票した人がいないため道連れはいません。");
      return;
    }
    const target = voters[Math.floor(Math.random() * voters.length)];
    game.players.get(target)!.isAlive = false;
    const channel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    await channel.send(`**狩人の道連れ**: <@${hunterId}> に投票した <@${target}> が道連れにされました！`);
  }

  private async finishOneNightGame(guild: Guild, game: GameState, eliminatedId: string | null): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    game.phase = GamePhase.FINISHED;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    const eliminatedRole = eliminatedId ? game.players.get(eliminatedId)?.role : null;
    const isWerewolfVoted = eliminatedRole === RoleType.WEREWOLF;
    const isTanner = eliminatedRole === RoleType.TANNER;

    let result = "**=== ワンナイト人狼 結果 ===**\n\n";

    if (eliminatedId) {
      result += `**追放されたプレイヤー**: <@${eliminatedId}>（最終役職: ${getRoleName(eliminatedRole!)}）\n\n`;
    } else {
      result += "**追放されたプレイヤー**: なし\n\n";
    }

    result += "**勝利判定:**\n";
    if (isTanner) {
      result += "**皮なめし職人の勝利！**\n皮なめし職人が追放され、単独勝利しました！\n\n";
    } else if (eliminatedId && isWerewolfVoted) {
      result += "**市民陣営の勝利！**\n人狼が追放されました。\n\n";
    } else {
      result += "**人狼陣営の勝利！**\n人狼は追放されませんでした。\n\n";
    }

    result += "**最終役職一覧:**\n";
    for (const pid of game.participants) {
      const ps = game.players.get(pid)!;
      const orig = getRoleName(game.originalRoles.get(pid)!);
      const current = getRoleName(ps.role);
      if (orig !== current) {
        result += `<@${pid}>: ${orig} → **${current}** (${ps.isAlive ? "生存" : "死亡"})\n`;
      } else {
        result += `<@${pid}>: **${current}** (${ps.isAlive ? "生存" : "死亡"})\n`;
      }
    }

    result += `\n**センターカード:** ${game.centerRoles.map((r) => getRoleName(r)).join(", ")}`;
    result += "\n\n`/end` でゲームを初期化してください。";

    await gameChannel.send(result);
    log(guild.id, `OneNight game finished. Eliminated: ${eliminatedId ?? "none"}, winner: ${isTanner ? "tanner" : isWerewolfVoted ? "village" : "werewolf"}`);
  }

  // ===== End One Night Werewolf =====

  // ===== Gishin Anki (疑心暗鬼/二人用人狼) =====

  private async startGishinAnkiGame(guild: Guild, game: GameState): Promise<string> {
    game.phase = GamePhase.GISHIN_INFORMATION;
    game.dayCount = 0;

    const gameChannel = await guild.channels.create({
      name: "ギシンアンキ", type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: ["ViewChannel"], type: OverwriteType.Role },
        ...game.participants.map((pid) => ({
          id: pid, allow: ["ViewChannel", "SendMessages"] as const, type: OverwriteType.Member as const,
        })),
      ],
    });
    game.gameTextChannelId = gameChannel.id;

    await gameChannel.send(
      "**ギシンアンキ（二人用人狼）を開始します！**\n" +
      "まもなく各プレイヤーにDMで役職が配布されます。"
    );

    this.prepareGishinAnkiRoles(game);

    for (const pid of game.participants) {
      game.originalRoles.set(pid, game.players.get(pid)!.role);
    }

    log(guild.id, `GishinAnki game started with players: ${game.participants.join(", ")}`);

    await this.sendGishinAnkiRoleMessages(guild, game);
    // 情報収集・決断フェーズは数分かかるため、/start の応答を待たせない
    void this.startGishinAnkiInformationPhase(guild, game).catch((error) => {
      console.error(`[Game ${guild.id.slice(0, 8)}] GishinAnki phase failed:`, error);
    });
    return "ゲームを開始しました！";
  }

  private prepareGishinAnkiRoles(game: GameState): void {
    const pool: RoleType[] = [
      RoleType.SURVIVOR, RoleType.SURVIVOR, RoleType.SURVIVOR,
      RoleType.MISANTHROPIST, RoleType.MISANTHROPIST,
      RoleType.WEREWOLF_GISHIN, RoleType.WEREWOLF_GISHIN,
    ];

    const shuffled = shuffle(pool);
    for (let i = 0; i < game.participants.length; i++) {
      const role = shuffled[i];
      game.players.set(game.participants[i], {
        userId: game.participants[i], role, team: getTeam(role), isAlive: true, isProtected: false,
      });
    }
    game.gishinDeck = shuffled.slice(game.participants.length);
    game.gishinHands = new Map();
    game.gishinActionTokens = new Map();
    game.gishinDecisions = new Map();
    game.gishinReady = [];
    game.gishinRequestPending = null;
    game.gishinExchanges = false;

    for (const pid of game.participants) {
      game.gishinHands.set(pid, []);
      game.gishinActionTokens.set(pid, 2);
    }

    log(game.guildId, `GishinAnki roles prepared. Players: ${game.participants.map((p) => `${p}=${getRoleName(game.players.get(p)!.role)}`).join(", ")}, Deck: ${game.gishinDeck.map((r) => getRoleName(r)).join(", ")}`);
  }

  private async sendGishinAnkiRoleMessages(guild: Guild, game: GameState): Promise<void> {
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("gishin_reveal_role")
        .setLabel("自分の役職を確認する")
        .setStyle(ButtonStyle.Secondary),
    );

    await gameChannel.send({
      content: "**役職を確認するには、下のボタンをクリックしてください。**",
      components: [row],
    });

    const collector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === "gishin_reveal_role" && game.participants.includes(i.user.id),
      time: 30000,
    });

    collector.on("collect", async (i) => {
      const ps = game.players.get(i.user.id);
      if (!ps) {
        await i.reply({ content: "役職情報が見つかりません。", flags: EPHEMERAL });
        return;
      }
      const def = GISHINANKI_ROLE_DEFINITIONS[ps.role];
      const remainingTokens = game.gishinActionTokens.get(i.user.id) ?? 2;
      let msg = `あなたの役職は **${def?.name ?? getRoleName(ps.role)}** です！\n${def?.description ?? ""}`;
      msg += `\n\n**アクションコマ**: ${remainingTokens}つ\n山札からカードを引いたり、相手の手札を要求できます。`;

      await i.reply({ content: msg, flags: EPHEMERAL });
    });
  }

  private async startGishinAnkiInformationPhase(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    await this.sendGishinAnkiStatus(gameChannel, game);

    const infoRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gishin_draw").setLabel("山札を見る").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("gishin_request").setLabel("相手のカードを要求").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gishin_ready").setLabel("決断に進む（準備完了）").setStyle(ButtonStyle.Success),
    );

    await gameChannel.send({
      content: "**情報収集フェーズ**\nアクションコマを消費して情報を集めましょう。両方が準備完了になると決断フェーズに進みます。",
      components: [infoRow],
    });

    const collector = gameChannel.createMessageComponentCollector({
      time: 150000,
      filter: (i) => game.participants.includes(i.user.id),
    });

    let resolvePhase: (() => void) | null = null;
    let phaseTimeout: NodeJS.Timeout | null = null;

    const finishPhase = () => {
      if (!resolvePhase) return;
      collector.stop();
      if (phaseTimeout) { clearTimeout(phaseTimeout); phaseTimeout = null; }
      resolvePhase();
      resolvePhase = null;
    };

    const checkReady = () => {
      if (game.gishinReady.length >= game.participants.length) finishPhase();
    };

    collector.on("collect", async (i) => {
      if (i.customId === "gishin_draw") {
        await this.handleGishinDraw(guild, game, i, gameChannel);
      } else if (i.customId === "gishin_request") {
        await this.handleGishinRequest(guild, game, i, gameChannel);
      } else if (i.customId === "gishin_ready") {
        if (!game.gishinReady.includes(i.user.id)) {
          game.gishinReady.push(i.user.id);
          await i.reply({ content: "準備完了しました。相手を待っています。", flags: EPHEMERAL });
          await this.sendGishinAnkiStatus(gameChannel, game);
          checkReady();
        } else {
          await i.reply({ content: "すでに準備完了しています。", flags: EPHEMERAL });
        }
      }
    });

    await new Promise<void>((resolve) => {
      resolvePhase = resolve;
      phaseTimeout = setTimeout(() => {
        collector.stop();
        if (resolvePhase) {
          resolvePhase();
          resolvePhase = null;
          gameChannel.send("**時間切れです。決断フェーズに移行します。**").catch(() => {});
        }
      }, 150000);
    });

    if (this.games.get(game.guildId) !== game) return;
    await this.startGishinAnkiDecisionPhase(guild, game);
  }

  private async sendGishinAnkiStatus(channel: TextChannel, game: GameState): Promise<void> {
    const p1 = game.participants[0];
    const p2 = game.participants[1];
    if (!p1 || !p2) return;

    const names = await this.resolveDisplayNames(channel.guild, [p1, p2]);
    const g1 = names.get(p1)!;
    const g2 = names.get(p2)!;

    const t1 = game.gishinActionTokens.get(p1) ?? 0;
    const t2 = game.gishinActionTokens.get(p2) ?? 0;
    const h1 = game.gishinHands.get(p1)?.length ?? 0;
    const h2 = game.gishinHands.get(p2)?.length ?? 0;
    const r1 = game.gishinReady.includes(p1) ? "✅" : "⏳";
    const r2 = game.gishinReady.includes(p2) ? "✅" : "⏳";
    const deck = game.gishinDeck.length;

    const embed = new EmbedBuilder()
      .setTitle("📊 情報収集フェーズ ステータス")
      .setColor(0x00aaff)
      .addFields(
        { name: `${g1} ${r1}`, value: `コマ: ${"●".repeat(t1)}${"○".repeat(2 - t1)}\n手札: ${h1}枚`, inline: true },
        { name: `${g2} ${r2}`, value: `コマ: ${"●".repeat(t2)}${"○".repeat(2 - t2)}\n手札: ${h2}枚`, inline: true },
        { name: "山札", value: `${deck}枚残り`, inline: true },
      );

    await channel.send({ embeds: [embed] }).catch(() => {});
  }

  private async handleGishinDraw(guild: Guild, game: GameState, i: any, channel: TextChannel): Promise<void> {
    // 後続の処理で3秒を超える可能性があるため、先に応答を保留する
    await i.deferReply({ flags: EPHEMERAL });
    if (this.games.get(game.guildId) !== game || game.phase !== GamePhase.GISHIN_INFORMATION) {
      await i.editReply({ content: "情報収集フェーズは終了しました。" });
      return;
    }
    const pid = i.user.id;
    const tokens = game.gishinActionTokens.get(pid) ?? 0;
    if (tokens <= 0) {
      await i.editReply({ content: "アクションコマが残っていません。" });
      return;
    }
    if (game.gishinDeck.length === 0) {
      await i.editReply({ content: "山札にカードが残っていません。" });
      return;
    }

    const drawn = game.gishinDeck.pop()!;
    game.gishinHands.get(pid)!.push(drawn);
    game.gishinActionTokens.set(pid, tokens - 1);

    try {
      const member = await guild.members.fetch(pid);
      await member.send(`**山札から引きました:** ${getRoleName(drawn)}`);
    } catch {}

    await i.editReply({ content: `山札から1枚引き、手札に加えました。（残りコマ: ${tokens - 1}）` });
    await this.sendGishinAnkiStatus(channel, game);
  }

  private async handleGishinRequest(guild: Guild, game: GameState, i: any, channel: TextChannel): Promise<void> {
    // 相手の応答を最大30秒待つため、先に応答を保留する
    await i.deferReply({ flags: EPHEMERAL });
    if (this.games.get(game.guildId) !== game || game.phase !== GamePhase.GISHIN_INFORMATION) {
      await i.editReply({ content: "情報収集フェーズは終了しました。" });
      return;
    }
    const pid = i.user.id;
    const opponent = game.participants.find((p) => p !== pid)!;
    const tokens = game.gishinActionTokens.get(pid) ?? 0;

    const myRole = game.players.get(pid)!.role;
    if (myRole === RoleType.MISANTHROPIST) {
      await i.editReply({ content: "**人間不信**のため、相手にカードを要求できません。" });
      return;
    }

    if (tokens <= 0) {
      await i.editReply({ content: "アクションコマが残っていません。" });
      return;
    }

    const myHand = game.gishinHands.get(pid) ?? [];
    if (myHand.length >= 2) {
      await i.editReply({ content: "手札が2枚のため、要求できません。" });
      return;
    }

    const oppHand = game.gishinHands.get(opponent) ?? [];
    const oppRole = game.players.get(opponent)!.role;

    let accept = true;
    let reason = "";

    if (oppRole === RoleType.MISANTHROPIST) {
      accept = false;
      reason = "相手が人間不信のため、自動的に拒否されました。";
    } else if (oppHand.length === 0) {
      accept = false;
      reason = "相手に手札がありません。";
    } else {
      await i.editReply({ content: "相手にカードを見せるよう要求しました。応答を待っています..." });
      try {
        const oppMember = await guild.members.fetch(opponent);
        const reqMember = await guild.members.fetch(pid);

        const handOptions = oppHand.map((r, idx) =>
          new StringSelectMenuOptionBuilder().setLabel(getRoleName(r)).setValue(String(idx))
        );
        const select = new StringSelectMenuBuilder()
          .setCustomId("gishin_show_card")
          .setPlaceholder("見せるカードを選んでください")
          .addOptions(handOptions);
        const rejectRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("gishin_reject_card")
            .setLabel("拒否する")
            .setStyle(ButtonStyle.Danger),
        );

        const msg = await oppMember.send({
          content: `**${reqMember.displayName}** があなたの手札を見せてもらうよう要求しています。\n見せるカードを選ぶか、拒否してください。`,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), rejectRow],
        }).catch(() => null);

        if (!msg) {
          accept = false;
          reason = "相手にDMを送信できませんでした。";
        } else {
          const filter2 = (resp: any) =>
            resp.user.id === opponent &&
            (resp.customId === "gishin_show_card" || resp.customId === "gishin_reject_card");
          const selectResp = await msg.awaitMessageComponent({ filter: filter2, time: 30000 }).catch(() => null);

          if (!selectResp) {
            accept = false;
            reason = "相手が応答しませんでした。";
            await msg.edit({ content: "時間切れです。", components: [] }).catch(() => {});
          } else if (selectResp.customId === "gishin_reject_card") {
            accept = false;
            reason = "相手に拒否されました。（コマは消費されません）";
            await selectResp.update({ content: "要求を拒否しました。", components: [] });
          } else if (!selectResp.isStringSelectMenu()) {
            accept = false;
            reason = "エラーが発生しました。";
          } else {
            const cardIdx = parseInt(selectResp.values[0]);
            const shownRole = oppHand[cardIdx];
            accept = true;

            await selectResp.update({
              content: `**${getRoleName(shownRole)}** を見せました。`,
              components: [],
            });

            try {
              await reqMember.send(`相手が **${getRoleName(shownRole)}** を見せてくれました。`);
            } catch {}
          }
        }
      } catch {
        accept = false;
        reason = "エラーが発生しました。";
      }
    }

    if (this.games.get(game.guildId) !== game || game.phase !== GamePhase.GISHIN_INFORMATION) {
      await i.editReply({ content: "情報収集フェーズは終了しました。" });
      return;
    }

    if (accept) {
      game.gishinActionTokens.set(pid, tokens - 1);
      await i.editReply({ content: `相手がカードを見せてくれました。（残りコマ: ${tokens - 1}）` });
    } else {
      const replyMsg = reason || "相手に拒否されました。（コマは消費されません）";
      await i.editReply({ content: replyMsg });
    }

    await this.sendGishinAnkiStatus(channel, game);
  }

  private async startGishinAnkiDecisionPhase(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    game.phase = GamePhase.GISHIN_DECISION;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    await gameChannel.send("**決断フェーズ**\n両プレイヤーにDMで決断が送られます。同時に選択してください。");

    // 両プレイヤーのDMを同時に送る（順番待ちで片方が時間切れになるのを防ぐ）
    const decisionPromises = game.participants.map((pid) => this.sendGishinAnkiDecisionDM(guild, game, pid));

    await new Promise<void>((resolve) => {
      let settled = false;
      let checkInterval: NodeJS.Timeout | null = null;
      let decisionTimeout: NodeJS.Timeout | null = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (checkInterval) clearInterval(checkInterval);
        if (decisionTimeout) clearTimeout(decisionTimeout);
        resolve();
      };

      checkInterval = setInterval(() => {
        if (game.gishinDecisions.size >= game.participants.length) finish();
      }, 500);

      decisionTimeout = setTimeout(() => {
        for (const pid of game.participants) {
          if (!game.gishinDecisions.has(pid)) {
            const role = game.players.get(pid)!.role;
            if (role === RoleType.WEREWOLF_GISHIN) {
              game.gishinDecisions.set(pid, "見逃す");
            } else {
              game.gishinDecisions.set(pid, "留まる");
            }
            gameChannel.send(`<@${pid}> の決断が時間切れのため自動設定されました。`).catch(() => {});
          }
        }
        finish();
      }, 60000);
    });

    await Promise.allSettled(decisionPromises);

    if (this.games.get(game.guildId) !== game) return;
    await this.finishGishinAnkiGame(guild, game);
  }

  private async sendGishinAnkiDecisionDM(guild: Guild, game: GameState, pid: string): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    const role = game.players.get(pid)!.role;
    let options: string[];

    if (role === RoleType.WEREWOLF_GISHIN) {
      options = ["喰らう", "見逃す"];
    } else if (role === RoleType.GHOST) {
      options = ["留まる"];
    } else {
      options = ["留まる", "立ち去る"];
    }

    try {
      const member = await guild.members.fetch(pid);
      const select = new StringSelectMenuBuilder()
        .setCustomId("gishin_decision")
        .setPlaceholder("決断を選んでください")
        .addOptions(
          options.map((o) => new StringSelectMenuOptionBuilder().setLabel(o).setValue(o))
        );

      const msg = await member.send({
        content: `**決断フェーズ**\nあなたの役職: ${getRoleName(role)}\n決断を選んでください。`,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      }).catch(() => null);

      if (!msg) return;

      const filter = (i: any) => i.user.id === pid && i.customId === "gishin_decision";
      const ci = await msg.awaitMessageComponent({ filter, time: 60000 }).catch(() => null);

      if (ci && ci.isStringSelectMenu()) {
        game.gishinDecisions.set(pid, ci.values[0]);
        await ci.update({
          content: `決断「**${ci.values[0]}**」を選択しました。相手の決断を待っています。`,
          components: [],
        });
      }
    } catch {}
  }

  private async finishGishinAnkiGame(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    game.phase = GamePhase.FINISHED;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    const p1 = game.participants[0];
    const p2 = game.participants[1];

    const role1 = game.players.get(p1)!.role;
    const role2 = game.players.get(p2)!.role;
    const dec1 = game.gishinDecisions.get(p1)!;
    const dec2 = game.gishinDecisions.get(p2)!;

    const result = this.calculateGishinAnkiWinner(role1, dec1, role2, dec2);

    let msg = "**=== ギシンアンキ 結果 ===**\n\n";
    msg += `**<@${p1}>**: ${getRoleName(role1)} → 「${dec1}」\n`;
    msg += `**<@${p2}>**: ${getRoleName(role2)} → 「${dec2}」\n\n`;

    if (result.winner1 === "win" && result.winner2 === "win") {
      msg += "**両者勝利！** 🎉\n";
    } else if (result.winner1 === "win") {
      msg += `**<@${p1}> の勝利！** 🎉\n`;
    } else if (result.winner2 === "win") {
      msg += `**<@${p2}> の勝利！** 🎉\n`;
    } else {
      msg += "**両者敗北…** 💀\n";
    }

    if (result.reason) {
      msg += `\n*${result.reason}*`;
    }

    msg += "\n\n**山札（残り）:** ";
    if (game.gishinDeck.length > 0) {
      msg += game.gishinDeck.map((r) => getRoleName(r)).join(", ");
    } else {
      msg += "なし";
    }

    msg += "\n**捨て札・交換履歴はありません。**";
    msg += "\n\n`/end` でゲームを初期化してください。";

    await gameChannel.send(msg);
    log(guild.id, `GishinAnki finished. ${p1}=${getRoleName(role1)}(${dec1}), ${p2}=${getRoleName(role2)}(${dec2}) → ${result.winner1}/${result.winner2}`);
  }

  private calculateGishinAnkiWinner(
    role1: RoleType, dec1: string,
    role2: RoleType, dec2: string,
  ): { winner1: "win" | "lose"; winner2: "win" | "lose"; reason: string } {
    const isHuman1 = role1 !== RoleType.WEREWOLF_GISHIN && role1 !== RoleType.GHOST;
    const isHuman2 = role2 !== RoleType.WEREWOLF_GISHIN && role2 !== RoleType.GHOST;
    const isWolf1 = role1 === RoleType.WEREWOLF_GISHIN;
    const isWolf2 = role2 === RoleType.WEREWOLF_GISHIN;
    const isGhost1 = role1 === RoleType.GHOST;
    const isGhost2 = role2 === RoleType.GHOST;

    // Ghost special
    if (isGhost1) {
      if (isHuman2 && dec2 === "立ち去る") return { winner1: "win", winner2: "lose", reason: "幽霊の勝利条件: 相手が人間で「立ち去る」を選んだ。" };
      if (isWolf2 && dec2 === "喰らう") return { winner1: "win", winner2: "lose", reason: "幽霊の勝利条件: 相手が人狼で「喰らう」を選んだ。" };
      return { winner1: "lose", winner2: "win", reason: "幽霊は敗北した。" };
    }
    if (isGhost2) {
      if (isHuman1 && dec1 === "立ち去る") return { winner1: "lose", winner2: "win", reason: "幽霊の勝利条件: 相手が人間で「立ち去る」を選んだ。" };
      if (isWolf1 && dec1 === "喰らう") return { winner1: "lose", winner2: "win", reason: "幽霊の勝利条件: 相手が人狼で「喰らう」を選んだ。" };
      return { winner1: "win", winner2: "lose", reason: "幽霊は敗北した。" };
    }

    // Both human
    if (isHuman1 && isHuman2) {
      if (dec1 === "留まる" && dec2 === "留まる") return { winner1: "win", winner2: "win", reason: "両者「留まる」→ 両者勝利！" };
      if (dec1 === "立ち去る" || dec2 === "立ち去る") return { winner1: "lose", winner2: "lose", reason: "どちらかが「立ち去る」→ 両者敗北。" };
    }

    // Both wolf
    if (isWolf1 && isWolf2) {
      if (dec1 === "見逃す" && dec2 === "見逃す") return { winner1: "win", winner2: "win", reason: "両者「見逃す」→ 両者勝利！" };
      return { winner1: "lose", winner2: "lose", reason: "どちらかが「喰らう」→ 両者敗北（共食い）。" };
    }

    // One human, one wolf
    const humanDec = isHuman1 ? dec1 : dec2;
    const wolfDec = isWolf1 ? dec1 : dec2;

    if (humanDec === "立ち去る") return { winner1: isHuman1 ? "win" : "lose", winner2: isHuman2 ? "win" : "lose", reason: "人間が「立ち去る」→ 人間の勝利。" };
    if (wolfDec === "見逃す") return { winner1: isHuman1 ? "win" : "lose", winner2: isHuman2 ? "win" : "lose", reason: "人狼が「見逃す」→ 人間の勝利。" };
    if (humanDec === "留まる" && wolfDec === "喰らう") return { winner1: isWolf1 ? "win" : "lose", winner2: isWolf2 ? "win" : "lose", reason: "人間「留まる」＋ 人狼「喰らう」→ 人狼の勝利。" };

    return { winner1: "lose", winner2: "lose", reason: "勝敗判定不能。" };
  }

  // ===== End Gishin Anki =====

  private async createGameChannels(guild: Guild, game: GameState): Promise<void> {
    const category = await guild.channels.create({ name: "人狼ゲーム", type: ChannelType.GuildCategory });
    const everyone = guild.roles.everyone;

    const gameText = await guild.channels.create({
      name: "ゲーム用テキスト", type: ChannelType.GuildText, parent: category.id,
      permissionOverwrites: [{ id: everyone.id, deny: ["ViewChannel"], type: OverwriteType.Role }],
    });
    for (const pid of game.participants) {
      await gameText.permissionOverwrites.create(pid, { ViewChannel: true });
    }

    const spectatorText = await guild.channels.create({
      name: "観戦用テキスト", type: ChannelType.GuildText, parent: category.id,
      permissionOverwrites: [{ id: everyone.id, deny: ["ViewChannel"], type: OverwriteType.Role }],
    });

    const waitingVC = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildVoice && c.name.includes("待機")
    ) as VoiceChannel | undefined;

    let gameVoice: VoiceChannel;
    if (waitingVC) {
      game.waitingVoiceChannelId = waitingVC.id;
      gameVoice = await guild.channels.create({
        name: "ゲーム用ボイス", type: ChannelType.GuildVoice, parent: category.id,
        permissionOverwrites: [{ id: everyone.id, deny: ["ViewChannel"], type: OverwriteType.Role }],
      });
      for (const pid of game.participants) {
        await gameVoice.permissionOverwrites.create(pid, { ViewChannel: true, Connect: true });
        try {
          const member = await guild.members.fetch(pid);
          if (member.voice.channelId) await member.voice.setChannel(gameVoice);
        } catch {}
      }
    } else {
      gameVoice = await guild.channels.create({
        name: "ゲーム用ボイス", type: ChannelType.GuildVoice, parent: category.id,
        permissionOverwrites: [
          { id: everyone.id, deny: ["ViewChannel"], type: OverwriteType.Role },
          ...game.participants.map((pid) => ({
            id: pid, allow: ["ViewChannel", "Connect"] as const, type: OverwriteType.Member as const,
          })),
        ],
      });
      for (const pid of game.participants) {
        try {
          const member = await guild.members.fetch(pid);
          if (member.voice.channelId) await member.voice.setChannel(gameVoice);
        } catch {}
      }
    }

    const werewolfText = await guild.channels.create({
      name: "人狼用テキスト", type: ChannelType.GuildText, parent: category.id,
      permissionOverwrites: [{ id: everyone.id, deny: ["ViewChannel"], type: OverwriteType.Role }],
    });

    game.gameTextChannelId = gameText.id;
    game.gameVoiceChannelId = gameVoice.id;
    game.werewolfTextChannelId = werewolfText.id;
    game.spectatorTextChannelId = spectatorText.id;
    log(guild.id, `Channels created: text=${gameText.id}, voice=${gameVoice.id}, ww=${werewolfText.id}, spec=${spectatorText.id}`);
  }

  private async sendRoleMessages(guild: Guild, game: GameState): Promise<void> {
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("reveal_my_role")
        .setLabel("自分の役職を確認する")
        .setStyle(ButtonStyle.Secondary),
    );

    await gameChannel.send({
      content: "**役職を確認するには、下のボタンをクリックしてください。**\n（クリックするとあなただけに見える形で役職が表示されます）",
      components: [row],
    });

    const collector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === "reveal_my_role" && game.participants.includes(i.user.id),
      time: 120000,
    });

    collector.on("collect", async (i) => {
      const msg = this.getMyRole(game.guildId, i.user.id);
      if (!msg) {
        await i.reply({ content: "役職情報が見つかりません。", flags: EPHEMERAL });
        return;
      }
      await i.reply({ content: msg, flags: EPHEMERAL });
    });
  }

  private async startDayDiscussion(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    game.phase = GamePhase.DAY_DISCUSSION;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    const dayMsg = game.dayCount === 1
      ? `**${game.dayCount}日目の昼です！**\n会議を開始してください。（制限時間: ${game.settings.meetingTimeMinutes}分）\n※1日目は投票を行いません。`
      : `**${game.dayCount}日目の昼です！**\n会議を開始してください。（制限時間: ${game.settings.meetingTimeMinutes}分）`;
    await gameChannel.send(dayMsg);

    const wwChannel = game.werewolfTextChannelId
      ? (guild.channels.cache.get(game.werewolfTextChannelId) as TextChannel | undefined) : undefined;
    if (wwChannel) {
      await wwChannel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    }

    if (game.meetingTimer) clearTimeout(game.meetingTimer);
    game.meetingTimer = setTimeout(async () => {
      if (game.dayCount === 1) {
        log(guild.id, "Day 1: no voting, skipping to night");
        await this.startNight(guild, game);
      } else {
        await this.startVoting(guild, game);
      }
    }, game.settings.meetingTimeMinutes * 60 * 1000);

    const gameVoice = guild.channels.cache.get(game.gameVoiceChannelId!) as VoiceChannel;
    if (gameVoice) {
      for (const pid of game.participants) {
        const player = game.players.get(pid);
        if (!player?.isAlive) continue;
        try {
          const member = await guild.members.fetch(pid);
          if (member.voice.channelId === gameVoice.id) await member.voice.setMute(false);
        } catch {}
      }
    }
  }

  private async startVoting(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    log(guild.id, `Day ${game.dayCount} discussion started (${game.settings.meetingTimeMinutes}min)`);
    if (game.phase !== GamePhase.DAY_DISCUSSION) return;
    game.phase = GamePhase.DAY_VOTING;
    log(guild.id, `Day ${game.dayCount} voting started`);
    game.votes.clear();

    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);
    const voteNames = await this.resolveDisplayNames(guild, alivePlayers);

    const embed = new EmbedBuilder()
      .setTitle(`投票時間 - ${game.dayCount}日目`)
      .setDescription("下のボタンをクリックして投票してください。\n自分に投票することも、棄権することもできます。")
      .setColor(0xff0000);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vote_open").setLabel("投票する").setStyle(ButtonStyle.Primary),
    );

    await gameChannel.send({ embeds: [embed], components: [row] });

    const collector = gameChannel.createMessageComponentCollector({
      filter: (i) => alivePlayers.includes(i.user.id),
      time: 60000,
    });

    let voteResolve: (() => void) | null = null;
    const tryResolveVote = () => {
      if (!voteResolve) return;
      if (alivePlayers.every((p) => game.votes.has(p))) {
        collector.stop();
        voteResolve();
        voteResolve = null;
      }
    };

    collector.on("collect", async (i) => {
      if (i.customId === "vote_open") {
        const current = game.votes.get(i.user.id);
        const select = new StringSelectMenuBuilder()
          .setCustomId("vote_target")
          .setPlaceholder(current !== undefined ? "投票先を変更する" : "投票先を選んでください")
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel("棄権").setValue("abstain"),
            ...alivePlayers.map((p) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(voteNames.get(p)!)
                .setValue(p)
            )
          );
        const msg = current === undefined
          ? "投票先を選んでください。（自分への投票も可能、棄権も選択できます）"
          : `現在: ${current === null ? "棄権" : `<@${current}>`}\n変更する場合は選び直してください。`;
        await i.reply({
          content: msg,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
          flags: EPHEMERAL,
        });
      } else if (i.customId === "vote_target" && i.isStringSelectMenu()) {
        const target = i.values[0];
        if (target === "abstain") {
          game.votes.set(i.user.id, null);
          await i.update({ content: "あなたは **棄権** しました。", components: [] });
        } else {
          game.votes.set(i.user.id, target);
          await i.update({ content: `あなたは **<@${target}>** に投票しました。`, components: [] });
        }
        tryResolveVote();
      }
    });

    await new Promise<void>((resolve) => {
      voteResolve = resolve;
      setTimeout(() => {
        collector.stop();
        if (voteResolve) { voteResolve(); voteResolve = null; }
      }, 60000);
    });

    collector.stop();
    await this.processVotingResults(guild, game);
  }

  private async processVotingResults(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);

    const buildResultMsg = (title: string): string => {
      if (game.settings.anonymousVoting) {
        const counts = new Map<string, number>();
        let abstain = 0;
        for (const [, target] of game.votes) {
          if (target === null) abstain++;
          else counts.set(target, (counts.get(target) || 0) + 1);
        }
        let msg = `${title}\n`;
        for (const [pid, c] of counts) msg += `<@${pid}>: ${c}票\n`;
        if (abstain > 0) msg += `棄権: ${abstain}人\n`;
        return msg;
      } else {
        let msg = `${title}\n`;
        for (const pid of alivePlayers) {
          const vote = game.votes.get(pid);
          msg += `<@${pid}> → ${vote !== null ? `<@${vote}>` : "棄権"}\n`;
        }
        return msg;
      }
    };

    const resultMsg = buildResultMsg("**投票結果:**");
    const abstainCount = [...game.votes.values()].filter((v) => v === null).length;
    if (abstainCount > alivePlayers.length / 2) {
      await gameChannel.send(resultMsg + `\n過半数（${abstainCount}人）が棄権したため、投票は無効となりました。明日へ続きます。`);
      await this.startNight(guild, game);
      return;
    }

    const voteCount = new Map<string, number>();
    for (const [, target] of game.votes) {
      if (target !== null) voteCount.set(target, (voteCount.get(target) || 0) + 1);
    }

    if (voteCount.size === 0) {
      await gameChannel.send(resultMsg + "\n有効投票なし。明日へ続きます。");
      await this.startNight(guild, game);
      return;
    }

    const maxVotes = Math.max(...voteCount.values());
    const mostVoted: string[] = [];
    for (const [pid, count] of voteCount) { if (count === maxVotes) mostVoted.push(pid); }

    if (mostVoted.length > 1) {
      await gameChannel.send(resultMsg + `\n同票のため決選投票を行います。\n**候補**: ${mostVoted.map((id) => `<@${id}>`).join(", ")}`);
      await this.runRunoffVote(guild, game, mostVoted);
      return;
    }

    const eliminated = mostVoted[0];
    await this.handleElimination(guild, game, eliminated, "vote");
    if (game.phase === GamePhase.FINISHED) return;

    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) {
      await specChannel.send(`**${game.dayCount}日目 投票結果:** <@${eliminated}> が追放されました。（役職: ${getRoleName(game.players.get(eliminated)!.role)}）`);
    }

    game.votes.clear();
    if (this.checkWinCondition(game)) return;
    await this.startNight(guild, game);
  }

  private async handlePlayerDeath(guild: Guild, game: GameState, playerId: string): Promise<void> {
    const specChannel = game.spectatorTextChannelId
      ? (guild.channels.cache.get(game.spectatorTextChannelId) as TextChannel | undefined) : undefined;
    const gameTextChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    const role = game.players.get(playerId)?.role;
    log(guild.id, `Player <${playerId}> died (role: ${role ? getRoleName(role) : "unknown"})`);

    if (specChannel) {
      try { await specChannel.permissionOverwrites.create(playerId, { ViewChannel: true, SendMessages: true }); } catch {}
    }

    try { await gameTextChannel.permissionOverwrites.edit(playerId, { SendMessages: false }); } catch {}

    try {
      const member = await guild.members.fetch(playerId);
      await member.voice.setMute(true);
    } catch {}
  }

  private async handleElimination(guild: Guild, game: GameState, playerId: string, cause: "vote" | "werewolf"): Promise<void> {
    const ps = game.players.get(playerId);
    if (!ps) return;
    ps.isAlive = false;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    await this.handlePlayerDeath(guild, game, playerId);

    if (cause === "vote") {
      await gameChannel.send(`**追放**: <@${playerId}> が追放されました。`);
      if (ps.role === RoleType.TERU_TERU) { await this.handleTeruTeruWin(guild, game, playerId); return; }
      if (ps.role === RoleType.NEKOMATA) await this.handleNekomataVoteDeath(guild, game, playerId);
      if (ps.role === RoleType.BLACK_CAT) await this.handleBlackCatVoteDeath(guild, game, playerId);
    }
  }

  private async handleTeruTeruWin(guild: Guild, game: GameState, playerId: string): Promise<void> {
    game.phase = GamePhase.FINISHED;
    await this.unlockAllChannels(guild, game);
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    let r = `**=== ゲーム終了 ===**\n\n**てるてる坊主の勝利！**\n<@${playerId}> が会議の投票で死亡し、単独勝利しました！\n\n**役職一覧:**\n`;
    for (const pid of game.participants) { const p = game.players.get(pid)!; r += `<@${pid}>: ${getRoleName(p.role)} (${p.isAlive ? "生存" : "死亡"})\n`; }
    r += "\n`/end` でゲームを初期化してください。";
    await gameChannel.send(r);
    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) await specChannel.send(r);
  }

  private async handleNekomataVoteDeath(guild: Guild, game: GameState, playerId: string): Promise<void> {
    const alive = game.participants.filter((p) => p !== playerId && game.players.get(p)?.isAlive);
    if (alive.length === 0) return;
    const target = alive[Math.floor(Math.random() * alive.length)];
    game.players.get(target)!.isAlive = false;
    await this.handlePlayerDeath(guild, game, target);
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    await gameChannel.send(`**猫又の道連れ**: <@${target}> が道連れにされました。`);
    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) await specChannel.send(`**猫又の道連れ**: <@${target}> (${getRoleName(game.players.get(target)!.role)}) が道連れにされました。`);
  }

  private async handleNekomataWerewolfDeath(guild: Guild, game: GameState, playerId: string): Promise<void> {
    const alive = game.participants.filter((p) => p !== playerId && game.players.get(p)?.isAlive && game.players.get(p)?.role === RoleType.WEREWOLF);
    if (alive.length === 0) return;
    const target = alive[Math.floor(Math.random() * alive.length)];
    game.players.get(target)!.isAlive = false;
    await this.handlePlayerDeath(guild, game, target);
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    await gameChannel.send(`**猫又の呪い**: <@${target}> が道連れにされました。`);
    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) await specChannel.send(`**猫又の呪い**: <@${target}> (${getRoleName(game.players.get(target)!.role)}) が道連れにされました。`);
  }

  private async handleBlackCatVoteDeath(guild: Guild, game: GameState, playerId: string): Promise<void> {
    const alive = game.participants.filter((p) => p !== playerId && game.players.get(p)?.isAlive && game.players.get(p)?.team !== Team.WEREWOLF);
    if (alive.length === 0) return;
    const target = alive[Math.floor(Math.random() * alive.length)];
    game.players.get(target)!.isAlive = false;
    await this.handlePlayerDeath(guild, game, target);
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    await gameChannel.send(`**黒猫の道連れ**: <@${target}> が道連れにされました。`);
    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) await specChannel.send(`**黒猫の道連れ**: <@${target}> (${getRoleName(game.players.get(target)!.role)}) が道連れにされました。`);
  }

  private async runRunoffVote(guild: Guild, game: GameState, candidates: string[]): Promise<void> {
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);
    game.votes.clear();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("runoff_open").setLabel("決選投票する").setStyle(ButtonStyle.Danger),
    );
    await gameChannel.send({ content: `**決選投票**\n候補: ${candidates.map((id) => `<@${id}>`).join(", ")}\n下のボタンをクリックしてください。`, components: [row] });

    const runoffCandidateNames = await this.resolveDisplayNames(guild, candidates);

    const collector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === "runoff_open" && alivePlayers.includes(i.user.id),
      time: 30000,
    });

    collector.on("collect", async (i) => {
      const current = game.votes.get(i.user.id);
      const select = new StringSelectMenuBuilder()
        .setCustomId("runoff_target")
        .setPlaceholder(current !== undefined ? "投票先を変更する" : "投票先を選んでください")
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel("棄権").setValue("abstain"),
          ...candidates.map((c) =>
            new StringSelectMenuOptionBuilder().setLabel(runoffCandidateNames.get(c)!).setValue(c)
          )
        );
      const msg = current === undefined
        ? "追放したいプレイヤーを選んでください。（棄権も選択できます）"
        : `現在: ${current === null ? "棄権" : `<@${current}>`}\n変更する場合は選び直してください。`;
      await i.reply({
        content: msg,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        flags: EPHEMERAL,
      });
    });

    const selectCollector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === "runoff_target" && alivePlayers.includes(i.user.id),
      time: 30000,
    });

    let runoffResolve: (() => void) | null = null;
    const tryResolveRunoff = () => {
      if (!runoffResolve) return;
      if (alivePlayers.every((p) => game.votes.has(p))) {
        collector.stop();
        selectCollector.stop();
        runoffResolve();
        runoffResolve = null;
      }
    };

    selectCollector.on("collect", async (i) => {
      if (!i.isStringSelectMenu()) return;
      const target = i.values[0];
      if (target === "abstain") {
        game.votes.set(i.user.id, null);
        await i.update({ content: "あなたは **棄権** しました。", components: [] });
      } else {
        game.votes.set(i.user.id, target);
        await i.update({ content: `あなたは **<@${target}>** に投票しました。`, components: [] });
      }
      tryResolveRunoff();
    });

    await new Promise<void>((resolve) => {
      runoffResolve = resolve;
      setTimeout(async () => {
        collector.stop();
        selectCollector.stop();
        if (runoffResolve) { runoffResolve(); runoffResolve = null; }
      }, 30000);
    });

    const abstainCount = [...game.votes.values()].filter((v) => v === null).length;
    if (abstainCount > alivePlayers.length / 2) {
      await gameChannel.send(`決選投票で過半数（${abstainCount}人）が棄権したため、投票は無効となりました。明日へ続きます。`);
      await this.startNight(guild, game);
      return;
    }

    const voteCount = new Map<string, number>();
    for (const [, target] of game.votes) {
      if (target !== null) voteCount.set(target, (voteCount.get(target) || 0) + 1);
    }

    if (voteCount.size === 0) {
      await gameChannel.send("決選投票でも決着がつきませんでした。明日へ続きます。");
      await this.startNight(guild, game);
      return;
    }

    let runoffResult = "**決選投票結果:**\n";
    if (game.settings.anonymousVoting) {
      for (const [pid, c] of voteCount) runoffResult += `<@${pid}>: ${c}票\n`;
      if (abstainCount > 0) runoffResult += `棄権: ${abstainCount}人\n`;
    } else {
      for (const pid of alivePlayers) {
        const vote = game.votes.get(pid);
        runoffResult += `<@${pid}> → ${vote !== null ? `<@${vote}>` : "棄権"}\n`;
      }
    }
    await gameChannel.send(runoffResult);

    const maxVotes = Math.max(...voteCount.values());
    const mostVoted: string[] = [];
    for (const [pid, count] of voteCount) { if (count === maxVotes) mostVoted.push(pid); }

    const eliminated = mostVoted[0];
    await this.handleElimination(guild, game, eliminated, "vote");
    if (game.phase === GamePhase.FINISHED) return;

    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) {
      await specChannel.send(`**${game.dayCount}日目 決選投票結果:** <@${eliminated}> が追放されました。（役職: ${getRoleName(game.players.get(eliminated)!.role)}）`);
    }

    game.votes.clear();
    if (this.checkWinCondition(game)) return;
    await this.startNight(guild, game);
  }

  private async startNight(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    game.phase = GamePhase.NIGHT;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const gameVoice = guild.channels.cache.get(game.gameVoiceChannelId!) as VoiceChannel;

    await gameChannel.send(`**${game.dayCount}日目の夜です。**\n全員ミュートになりました。能力を持つプレイヤーは下のボタンをクリックしてアクションを行ってください。`);

    if (gameVoice) {
      for (const pid of game.participants) {
        try {
          const member = await guild.members.fetch(pid);
          if (member.voice.channelId === gameVoice.id) await member.voice.setMute(true);
        } catch {}
      }
    }

    await gameChannel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });

    const wwChannel = game.werewolfTextChannelId
      ? (guild.channels.cache.get(game.werewolfTextChannelId) as TextChannel | undefined) : undefined;
    if (wwChannel) {
      const werewolfIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.WEREWOLF);
      for (const wid of werewolfIds) {
        await wwChannel.permissionOverwrites.edit(wid, { SendMessages: game.players.get(wid)?.isAlive === true });
      }
      await wwChannel.send(`**夜になりました。** 襲撃する相手を相談してください。`);
    }

    log(guild.id, `Night ${game.dayCount} started`);

    game.nightActionResult = [];
    await this.runNightActions(guild, game);
  }

  private async runNightActions(guild: Guild, game: GameState): Promise<void> {
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);
    const wwChannel = game.werewolfTextChannelId
      ? (guild.channels.cache.get(game.werewolfTextChannelId) as TextChannel | undefined) : undefined;

    const hasNightRole = alivePlayers.some((p) => {
      const r = game.players.get(p)?.role;
      return r === RoleType.KNIGHT || r === RoleType.FORTUNE_TELLER || r === RoleType.MEDIUM || r === RoleType.WEREWOLF;
    });

    if (!hasNightRole) {
      await this.finalizeNight(guild, game);
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("night_action_btn")
        .setLabel("夜のアクションを行う")
        .setStyle(ButtonStyle.Primary),
    );

    await gameChannel.send({
      content: "**夜のアクション:** 下のボタンをクリックしてアクションを行ってください。\n（クリックするとあなただけに見える形で操作できます）",
      components: [row],
    });

    const btnCollector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === "night_action_btn" && alivePlayers.includes(i.user.id),
      time: 85000,
    });

    btnCollector.on("collect", async (i) => {
      // 対象の表示名取得などで3秒を超える可能性があるため、先に応答を保留する
      await i.deferReply({ flags: EPHEMERAL });
      const info = this.getNightActionInfo(game.guildId, i.user.id);
      if (typeof info === "string") {
        await i.editReply({ content: info });
        return;
      }

      const { role, targets } = info;
      const targetNames = await this.resolveDisplayNames(guild, targets);

      const select = new StringSelectMenuBuilder()
        .setCustomId("night_action_select")
        .setPlaceholder("対象を選んでください")
        .addOptions(targets.map((t) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(targetNames.get(t)!)
            .setValue(t)
        ));

      await i.editReply({
        content: `**${getRoleName(role)}:** 対象を選んでください。`,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      });
    });

    const nightRolePlayers = alivePlayers.filter((p) => {
      const r = game.players.get(p)?.role;
      return r === RoleType.KNIGHT || r === RoleType.FORTUNE_TELLER || r === RoleType.MEDIUM || r === RoleType.WEREWOLF;
    });

    const selectCollector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === "night_action_select" && alivePlayers.includes(i.user.id),
      time: 85000,
    });

    let nightResolve: (() => void) | null = null;
    const tryResolveNight = () => {
      if (!nightResolve) return;
      const actedUsers = new Set(game.nightActionResult.map((a) => a.split(":")[1]));
      const allDone = nightRolePlayers.every((pid) => actedUsers.has(pid));
      if (allDone) {
        if (game.nightActionTimeout) { clearTimeout(game.nightActionTimeout); game.nightActionTimeout = null; }
        nightResolve();
        nightResolve = null;
      }
    };

    selectCollector.on("collect", async (i) => {
      if (!i.isStringSelectMenu()) return;
      const role = game.players.get(i.user.id)?.role;
      if (!role) return;

      const targetId = i.values[0];
      const resultMsg = this.recordNightAction(game.guildId, i.user.id, targetId, role);
      await i.update({ content: resultMsg, components: [] });

      if (role === RoleType.WEREWOLF && wwChannel) {
        const aliveWolfIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.WEREWOLF && game.players.get(p)?.isAlive);
        const wolfVotes = game.nightActionResult.filter((a) => a.startsWith("werewolf:"));
        const votedCount = new Set(wolfVotes.map((a) => a.split(":")[1])).size;
        await wwChannel.send(`<@${i.user.id}> が <@${targetId}> に投票しました。（${votedCount}/${aliveWolfIds.length} 投票済み）`);
        if (votedCount >= aliveWolfIds.length) {
          const voteCounts: Record<string, number> = {};
          for (const a of wolfVotes) {
            const tid = a.split(":")[2];
            voteCounts[tid] = (voteCounts[tid] || 0) + 1;
          }
          const sorted = Object.entries(voteCounts).sort(([, a], [, b]) => b - a);
          await wwChannel.send(`**全人狼の投票が揃いました。** 襲撃対象: <@${sorted[0][0]}>（${sorted[0][1]}票）に決定しました。`);
        }
      }

      tryResolveNight();
    });

    await new Promise<void>((resolve) => {
      nightResolve = resolve;
      if (game.nightActionTimeout) clearTimeout(game.nightActionTimeout);
      game.nightActionTimeout = setTimeout(() => {
        log(guild.id, `Night ${game.dayCount} timeout expired (90s)`);
        if (nightResolve) { nightResolve(); nightResolve = null; }
      }, 90000);
    });

    btnCollector.stop();
    selectCollector.stop();
    log(guild.id, `Night ${game.dayCount} actions complete, finalizing`);
    await this.finalizeNight(guild, game);
  }

  getMyRole(guildId: string, userId: string): string | null {
    const game = this.games.get(guildId);
    if (!game) return null;
    const player = game.players.get(userId);
    if (!player) return null;

    const isOneNight = game.settings.gameMode === GameMode.ONENIGHT;
    const isGishin = game.settings.gameMode === GameMode.GISHINANKI;
    const def = isGishin
      ? (GISHINANKI_ROLE_DEFINITIONS[player.role] ?? ROLE_DEFINITIONS[player.role])
      : isOneNight
        ? (ONENIGHT_ROLE_DEFINITIONS[player.role] ?? ROLE_DEFINITIONS[player.role])
        : ROLE_DEFINITIONS[player.role];
    const werewolfIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.WEREWOLF);
    const fanaticIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.FANATIC);

    const desc = isOneNight ? this.getOneNightRoleDesc(player.role) : def.description;
    let msg = `あなたの役職は **${def.name}** です！\n${desc}\n勝利条件: ${def.winCondition}`;

    if (player.role === RoleType.WEREWOLF && werewolfIds.length > 0) {
      msg += `\n\n**他の人狼**: ${werewolfIds.filter((id) => id !== userId).map((id) => `<@${id}>`).join(", ")}`;
    }
    if (!isOneNight) {
      if (player.role === RoleType.WEREWOLF && fanaticIds.length > 0) {
        msg += `\n\n**狂信者**: ${fanaticIds.map((id) => `<@${id}>`).join(", ")}`;
      }
      if (player.role === RoleType.FANATIC && werewolfIds.length > 0) {
        msg += `\n\n**人狼メンバー**: ${werewolfIds.map((id) => `<@${id}>`).join(", ")}`;
      }
      if (player.role === RoleType.ACCOMPLICE && werewolfIds.length > 0) {
        msg += `\n\n**人狼メンバー**: ${werewolfIds.map((id) => `<@${id}>`).join(", ")}`;
      }
    }

    return msg;
  }

  getNightActionInfo(guildId: string, userId: string): { role: RoleType; targets: string[] } | string {
    const game = this.games.get(guildId);
    if (!game || game.phase !== GamePhase.NIGHT) return "現在夜ではありません。";
    const player = game.players.get(userId);
    if (!player || !player.isAlive) return "あなたには夜の能力がありません。";

    const role = player.role;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);

    let targets: string[];
    switch (role) {
      case RoleType.KNIGHT:
        targets = alivePlayers;
        break;
      case RoleType.FORTUNE_TELLER:
        targets = alivePlayers;
        break;
      case RoleType.MEDIUM:
        targets = game.participants;
        break;
      case RoleType.WEREWOLF:
        targets = alivePlayers.filter((p) => p !== userId);
        break;
      default:
        return "あなたには夜の能力がありません。";
    }

    if (role !== RoleType.WEREWOLF) {
      const alreadyActed = game.nightActionResult.some((a) => a.startsWith(`${role}:${userId}:`));
      if (alreadyActed) return "すでにアクションは完了しています。";
    }

    return { role, targets };
  }

  recordNightAction(guildId: string, userId: string, targetId: string, role: RoleType): string {
    const game = this.games.get(guildId);
    if (!game) return "エラー: ゲームが見つかりません。";

    if (role === RoleType.WEREWOLF) {
      const oldIdx = game.nightActionResult.findIndex((a) => a.startsWith(`werewolf:${userId}:`));
      if (oldIdx >= 0) {
        game.nightActionResult[oldIdx] = `${role}:${userId}:${targetId}`;
      } else {
        game.nightActionResult.push(`${role}:${userId}:${targetId}`);
      }
    } else {
      const alreadyActed = game.nightActionResult.some((a) => a.startsWith(`${role}:${userId}:`));
      if (alreadyActed) return "すでにアクションは完了しています。";
      game.nightActionResult.push(`${role}:${userId}:${targetId}`);
    }

    switch (role) {
      case RoleType.KNIGHT:
        game.players.get(targetId)!.isProtected = true;
        return `**<@${targetId}>** を守護しました。`;
      case RoleType.FORTUNE_TELLER:
        return `**<@${targetId}>** の陣営: **${getFortuneResult(game.players.get(targetId)!.role)}**`;
      case RoleType.MEDIUM:
        return !game.players.get(targetId)?.isAlive
          ? `**<@${targetId}>** は死亡しています。陣営: **${getFortuneResult(game.players.get(targetId)!.role)}**`
          : `**<@${targetId}>** は生存しています。`;
      case RoleType.WEREWOLF: {
        const aliveWolfIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.WEREWOLF && game.players.get(p)?.isAlive);
        const wolfVotes = game.nightActionResult.filter((a) => a.startsWith("werewolf:"));
        const votedWolfIds = new Set(wolfVotes.map((a) => a.split(":")[1]));
        const remaining = aliveWolfIds.length - votedWolfIds.size;

        const voteCounts: Record<string, number> = {};
        for (const a of wolfVotes) {
          const tid = a.split(":")[2];
          voteCounts[tid] = (voteCounts[tid] || 0) + 1;
        }
        const tallyLines = Object.entries(voteCounts)
          .sort(([, a], [, b]) => b - a)
          .map(([tid, c]) => `<@${tid}>: ${c}票`)
          .join("\n");

        let msg = `**<@${targetId}>** に投票しました。\n\n**📊 現在の得票:**\n${tallyLines}`;
        if (remaining > 0) {
          msg += `\n\n⏳ 全人狼の投票が揃うまでお待ちください。（残り${remaining}票）`;
        } else {
          msg += `\n\n🎯 全人狼の投票が揃いました！襲撃対象が決定しました。`;
        }
        return msg;
      }
      default:
        return "アクションを記録しました。";
    }
  }

  private async finalizeNight(guild: Guild, game: GameState): Promise<void> {
    if (this.games.get(game.guildId) !== game) return;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const wwChannel = game.werewolfTextChannelId
      ? (guild.channels.cache.get(game.werewolfTextChannelId) as TextChannel | undefined) : undefined;

    if (wwChannel) {
      const werewolfIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.WEREWOLF);
      for (const wid of werewolfIds) await wwChannel.permissionOverwrites.edit(wid, { SendMessages: false });
    }

    const werewolfActions = game.nightActionResult.filter((a) => a.startsWith("werewolf:"));
    if (werewolfActions.length > 0) {
      const voteCounts = new Map<string, number>();
      for (const a of werewolfActions) {
        const tid = a.split(":")[2];
        voteCounts.set(tid, (voteCounts.get(tid) || 0) + 1);
      }
      let maxCount = 0;
      let targetId = "";
      for (const [tid, count] of voteCounts) {
        if (count > maxCount) {
          maxCount = count;
          targetId = tid;
        }
      }
      if (targetId) {
        const tp = game.players.get(targetId);
        if (tp) {
          if (tp.role === RoleType.FOX) {
            await gameChannel.send("妖狐は人狼の襲撃を回避しました。");
          } else if (tp.role === RoleType.NEKOMATA) {
            tp.isAlive = false;
            await this.handlePlayerDeath(guild, game, targetId);
            await gameChannel.send(`**<@${targetId}>** が昨夜、殺害されました。（猫又）`);
            const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
            if (specChannel) await specChannel.send(`**${game.dayCount}日目の夜:** <@${targetId}> (猫又) が人狼に殺害されました。`);
            await this.handleNekomataWerewolfDeath(guild, game, targetId);
          } else if (tp.isProtected) {
            await gameChannel.send("騎士が守護していたため、襲撃は失敗しました。");
            tp.isProtected = false;
          } else {
            tp.isAlive = false;
            await this.handlePlayerDeath(guild, game, targetId);
            await gameChannel.send(`**<@${targetId}>** が昨夜、殺害されました。`);
          }
        }
      }
    } else {
      await gameChannel.send("昨夜は誰も襲撃されませんでした。");
    }

    // 妖狐は占われると死亡する
    const divinedFoxIds = new Set<string>();
    for (const action of game.nightActionResult.filter((a) => a.startsWith("fortune_teller:"))) {
      const tid = action.split(":")[2];
      const target = game.players.get(tid);
      if (target && target.role === RoleType.FOX && target.isAlive) divinedFoxIds.add(tid);
    }
    for (const foxId of divinedFoxIds) {
      game.players.get(foxId)!.isAlive = false;
      await this.handlePlayerDeath(guild, game, foxId);
      await gameChannel.send(`**<@${foxId}>** が昨夜、占いにより死亡しました。`);
    }

    for (const [, ps] of game.players) ps.isProtected = false;
    game.nightActionResult = [];

    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) {
      let info = `**${game.dayCount}日目の夜の結果:**\n`;
      for (const pid of game.participants) {
        const ps = game.players.get(pid)!;
        info += `<@${pid}>: ${ps.isAlive ? "生存" : "死亡"}`;
        if (!ps.isAlive) info += ` (${getRoleName(ps.role)})`;
        info += "\n";
      }
      await specChannel.send(info);
    }

    log(guild.id, `Night ${game.dayCount} finalized, survivors: ${game.participants.filter((p) => game.players.get(p)?.isAlive).length}/${game.participants.length}`);

    if (this.checkWinCondition(game)) return;

    await gameChannel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
    game.dayCount++;
    log(guild.id, `Day ${game.dayCount} starting`);
    await this.startDayDiscussion(guild, game);
  }

  private checkWinCondition(game: GameState): boolean {
    const alive = game.participants.filter((p) => game.players.get(p)?.isAlive);
    const aliveTrueWW = alive.filter((p) => isTrueWerewolf(game.players.get(p)!.role));
    const aliveVillagerSide = alive.filter((p) => game.players.get(p)!.team === Team.VILLAGER || isCountedAsVillager(game.players.get(p)!.role));
    const aliveFox = alive.filter((p) => game.players.get(p)!.role === RoleType.FOX);

    log(game.guildId, `Win check: ${alive.length} alive, werewolves=${aliveTrueWW.length}, villageSide=${aliveVillagerSide.length}, fox=${aliveFox.length}`);

    if (aliveTrueWW.length === 0) {
      log(game.guildId, "Win condition: all werewolves eliminated");
      this.handleWin(game, aliveFox.length > 0 ? null : Team.VILLAGER, false, aliveFox.length > 0);
      return true;
    }
    if (aliveTrueWW.length >= aliveVillagerSide.length) {
      log(game.guildId, `Win condition: werewolves (${aliveTrueWW.length}) >= villageSide (${aliveVillagerSide.length})`);
      this.handleWin(game, aliveFox.length > 0 ? null : Team.WEREWOLF, false, aliveFox.length > 0);
      return true;
    }
    return false;
  }

  private async unlockAllChannels(guild: Guild, game: GameState): Promise<void> {
    const e = guild.roles.everyone;
    const ids: (string | null)[] = [
      game.gameTextChannelId, game.werewolfTextChannelId,
      game.spectatorTextChannelId, game.gameVoiceChannelId,
    ];
    for (const id of ids) {
      if (!id) continue;
      const ch = guild.channels.cache.get(id);
      if (!ch) continue;
      if (!("permissionOverwrites" in ch)) continue;
      try {
        await (ch as TextChannel | VoiceChannel).permissionOverwrites.edit(e, { ViewChannel: true, SendMessages: true, Connect: true, Speak: true });
      } catch {}
    }

    if (game.gameTextChannelId) {
      const gtch = guild.channels.cache.get(game.gameTextChannelId) as TextChannel | undefined;
      if (gtch) {
        const memberOverwriteIds = [...gtch.permissionOverwrites.cache.values()]
          .filter((ow) => ow.type === OverwriteType.Member)
          .map((ow) => ow.id);
        for (const id of memberOverwriteIds) {
          try { await gtch.permissionOverwrites.delete(id); } catch {}
        }
      }
    }

    if (game.gameVoiceChannelId) {
      const vc = guild.channels.cache.get(game.gameVoiceChannelId) as VoiceChannel | undefined;
      if (vc) {
        for (const member of [...vc.members.values()]) {
          try { await member.voice.setMute(false); } catch {}
        }
      }
    }

    if (game.waitingVoiceChannelId) {
      const wvc = guild.channels.cache.get(game.waitingVoiceChannelId) as VoiceChannel | undefined;
      if (wvc) {
        for (const member of [...wvc.members.values()]) {
          try { await member.voice.setMute(false); } catch {}
        }
      }
    }
  }

  private async handleWin(game: GameState, winningTeam: Team | null, _teruTeru = false, foxWin = false): Promise<void> {
    const guild = this.client.guilds.cache.get(game.guildId);
    if (!guild) return;
    game.phase = GamePhase.FINISHED;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    await this.unlockAllChannels(guild, game);

    let winMsg = foxWin ? "妖狐" : winningTeam === Team.VILLAGER ? "市民陣営" : winningTeam === Team.WEREWOLF ? "人狼陣営" : "不明";
    log(game.guildId, `Game over — winner: ${winMsg}`);

    let r = "**=== ゲーム終了 ===**\n\n";
    if (foxWin) r += "**妖狐の勝利！**\n妖狐が生き残り、他の陣営の勝利を打ち消しました。\n\n";
    else if (winningTeam === Team.VILLAGER) r += "**市民陣営の勝利！**\n全ての人狼を追放しました。\n\n";
    else if (winningTeam === Team.WEREWOLF) r += "**人狼陣営の勝利！**\n市民陣営を同数以下にしました。\n\n";

    r += "**役職一覧:**\n";
    for (const pid of game.participants) { const p = game.players.get(pid)!; r += `<@${pid}>: ${getRoleName(p.role)} (${p.isAlive ? "生存" : "死亡"})\n`; }
    r += "\n`/end` でゲームを初期化してください。";
    await gameChannel.send(r);

    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) await specChannel.send(r);
  }

  getSettingStatus(guildId: string, userId: string): string {
    const game = this.ensureGame(guildId);
    if (!game) return "設定がまだ行われていません。";
    if (game.hostUserId !== userId) return "ホストのみが設定を確認できます。";
    const dist = game.settings.roleDistribution;
    const modeNames: Record<string, string> = {
      [GameMode.CLASSIC]: "通常人狼",
      [GameMode.ONENIGHT]: "ワンナイト人狼",
      [GameMode.GISHINANKI]: "ギシンアンキ",
    };
    const modeName = modeNames[game.settings.gameMode] ?? game.settings.gameMode;
    let msg = `**現在の設定**\nモード: ${modeName}\n参加者: ${game.participants.length}人\n`;
    if (game.settings.gameMode === GameMode.GISHINANKI) {
      msg += "役職: 自動配布（生存者×3/人間不信×2/人狼×2）\n";
    } else {
      for (const [role, count] of Object.entries(dist)) {
        if ((count as number) > 0) msg += `${getRoleName(role as RoleType)}: ${count}人\n`;
      }
    }
    if (game.settings.gameMode !== GameMode.GISHINANKI) {
      msg += `会議時間: ${game.settings.meetingTimeMinutes}分\n`;
    }
    msg += `フェーズ: ${game.phase}`;
    return msg;
  }

  getHelp(guildId?: string | null, args?: string): string {
    const game = guildId ? this.games.get(guildId) : undefined;
    const currentMode = game?.settings.gameMode;

    if (args === "classic_roles") {
      let msg = "**=== 通常人狼 役職一覧 ===**\n\n";
      const exclude = new Set([
        RoleType.ROBBER, RoleType.TROUBLEMAKER, RoleType.DRUNK, RoleType.INSOMNIAC, RoleType.HUNTER_ONENIGHT, RoleType.TANNER,
        RoleType.SURVIVOR, RoleType.MISANTHROPIST, RoleType.WEREWOLF_GISHIN, RoleType.GHOST, RoleType.FOOL,
      ]);
      for (const def of Object.values(ROLE_DEFINITIONS)) {
        if (exclude.has(def.type)) continue;
        msg += `**${def.name}** (${def.team === Team.VILLAGER ? "市民陣営" : def.team === Team.WEREWOLF ? "人狼陣営" : "第三陣営"})\n${def.description}\n勝利条件: ${def.winCondition}\n\n`;
      }
      msg += "※狂人・共犯者・狂信者・黒猫は人狼陣営だが勝敗の人数カウントでは市民陣営側の人数としてカウントされます。";
      return msg;
    }

    if (args === "oneten_roles") {
      let msg = "**=== ワンナイト人狼 役職一覧 ===**\n\n";
      for (const [, def] of Object.entries(ONENIGHT_ROLE_DEFINITIONS)) {
        if (!def) continue;
        msg += `**${def.name}** (${def.team === Team.VILLAGER ? "市民陣営" : def.team === Team.WEREWOLF ? "人狼陣営" : "第三陣営"})\n${def.description}\n勝利条件: ${def.winCondition}\n\n`;
      }
      return msg;
    }

    if (args === "classic_rules") {
      return (
        "**=== 通常人狼 ルール説明 ===**\n\n" +
        "通常人狼は複数日跨いで行う長期戦の人狼ゲームです。\n\n" +
        "**ゲームの流れ:**\n" +
        "1. 設定 → 2. 役職配布 → 3. 1日目昼(議論のみ) → 4. 夜(各役職のアクション) → " +
        "5. 昼(議論＋投票→追放) → 6. 夜... を繰り返し、勝利条件を満たした陣営が勝利。\n\n" +
        "**基本ルール:**\n" +
        "• 市民陣営は人狼を全員追放すれば勝利\n" +
        "• 人狼陣営は市民陣営の数を同数以下にすれば勝利\n" +
        "• 夜に人狼は市民を1人襲撃できる（騎士が守護可能）\n" +
        "• 占い師は夜に1人を占い、陣営を確認できる\n" +
        "• 妖狐は人狼襲撃を受け付けず、生き残ったまま他陣営が勝利条件を満たすと単独勝利\n\n" +
        "**会話チャンネル:**\n" +
        "• ゲーム用テキストチャンネル: 全員が議論\n" +
        "• 人狼用テキストチャンネル: 夜に人狼のみ会話可能\n" +
        "• 観戦用テキストチャンネル: 全役職が見える\n\n" +
        "**役職詳細は `/help 項目: 通常人狼 役職一覧`**"
      );
    }

    if (args === "oneten_rules") {
      return (
        "**=== ワンナイト人狼 ルール説明 ===**\n\n" +
        "ワンナイト人狼は夜→昼の1ラウンドのみで勝敗が決まる短時間決戦型の人狼ゲームです。\n\n" +
        "**ゲームの流れ:**\n" +
        "1. 設定 → 2. 役職配布(＋3枚のセンターカード) → " +
        "3. 夜(順番に各役職がアクション) → 4. 昼(議論) → " +
        "5. 投票(追放) → 6. 結果発表・勝敗判定\n\n" +
        "**通常人狼との違い:**\n" +
        "• 夜の襲撃はなく、代わりに役職カードが入れ替わる\n" +
        "• 参加者数＋3枚のカードを用意し、余った3枚はセンターに\n" +
        "• 誰が何の役職かは夜のアクションで変化し得る\n" +
        "• 人狼テキストチャンネルは使わない\n\n" +
        "**夜のアクション順:**\n" +
        "人狼(互いを確認) → 占い師 → 怪盗 → トラブルメーカー → 酔っ払い → 失眠症\n\n" +
        "**勝利条件:**\n" +
        "• 市民陣営: 追放された人が人狼\n" +
        "• 人狼陣営: 追放された人が人狼でない（誰も追放されなければ人狼陣営の勝利）\n" +
        "• 皮なめし職人: 自分が追放される（単独勝利・上書き）\n\n" +
        "**役職詳細は `/help 項目: ワンナイト人狼 役職一覧`**"
      );
    }

    if (args === "gishinanki_roles") {
      let msg = "**=== ギシンアンキ（二人用人狼） 役職一覧 ===**\n\n";
      for (const [, def] of Object.entries(GISHINANKI_ROLE_DEFINITIONS)) {
        if (!def) continue;
        msg += `**${def.name}** (${def.team === Team.VILLAGER ? "人間陣営" : def.team === Team.WEREWOLF ? "人狼陣営" : "第三陣営"})\n${def.description}\n勝利条件: ${def.winCondition}\n\n`;
      }
      return msg;
    }

    if (args === "gishinanki_rules") {
      return (
        "**=== ギシンアンキ（二人用人狼） ルール説明 ===**\n\n" +
        "ギシンアンキは2人専用の短期決戦型人狼ゲームです。原作は「疑心暗鬼の小屋」。\n\n" +
        "**ゲームの流れ:**\n" +
        "1. 設定 → 2. 役職配布(7枚のカードから各1枚ずつ) → " +
        "3. 情報収集フェーズ(アクションコマ消費) → " +
        "4. 決断フェーズ(「留まる/立ち去る」or「喰らう/見逃す」) → " +
        "5. 結果発表・勝敗判定\n\n" +
        "**カード構成（7枚）:**\n" +
        "生存者×3 / 人間不信×2 / 人狼×2\n\n" +
        "**情報収集フェーズのアクション:**\n" +
        "各プレイヤー2つのアクションコマを持ってスタート。1コマ消費で以下を実行:\n" +
        "1. **山札を見る**: 山札から1枚引き、手札として持つ（自分だけ確認可能）\n" +
        "2. **相手のカードを要求**: 相手の手札を1枚見せてもらうよう要求（相手が拒否可、拒否されたらコマ消費なし）\n\n" +
        "**制限:**\n" +
        "• 手札が2枚の場合は要求不可\n" +
        "• 人間不信は要求不可＆要求されたら必ず拒否\n" +
        "• 会話は自由（嘘/本当どちらを言ってもOK）\n\n" +
        "**決断:**\n" +
        "• 生存者/人間不信/愚者: 「留まる」or「立ち去る」\n" +
        "• 人狼: 「喰らう」or「見逃す」\n" +
        "• 幽霊: 「留まる」のみ\n\n" +
        "**勝利条件マトリックス:**\n" +
        "人間vs人間: 両方留まる→両者勝利、片方立ち去る→両者敗北\n" +
        "人間vs人狼: 立ち去るor見逃す→人間勝利、留まる＋喰らう→人狼勝利\n" +
        "人狼vs人狼: 両方見逃す→両者勝利、どちらか喰らう→両者敗北\n" +
        "幽霊: 相手が人間で立ち去るor人狼で喰らう→幽霊勝利\n\n" +
        "**役職詳細は `/help 項目: ギシンアンキ 役職一覧`**"
      );
    }

    let modeInfo = "";
    if (currentMode) {
      const modeNames: Record<string, string> = {
        [GameMode.CLASSIC]: "通常人狼",
        [GameMode.ONENIGHT]: "ワンナイト人狼",
        [GameMode.GISHINANKI]: "ギシンアンキ",
      };
      modeInfo = `現在の設定モード: **${modeNames[currentMode] ?? currentMode}**\n\n`;
    }

    return (
      `${modeInfo}**コマンド一覧**\n` +
      "`/setting` - 対話形式で設定を決める (ホストのみ)\n" +
      "`/setting-status` - 現在の設定を確認する\n" +
      "`/start` - ゲームを開始する (ホストのみ)\n" +
      "`/stop` - ゲームを強制終了し初期化する (ホストのみ/試合中のみ)\n" +
      "`/skip` - 会議時間をスキップし投票に移る (ホストのみ/会議時間中のみ)\n" +
      "`/end` - 試合終了後に初期化を行う (試合終了後のみ)\n" +
      "`/help` - このメッセージを表示\n\n" +
      "**ヘルプ項目:**\n" +
      "`/help 項目: 通常人狼 ルール説明` - 通常人狼のルール\n" +
      "`/help 項目: 通常人狼 役職一覧` - 通常人狼の役職\n" +
      "`/help 項目: ワンナイト人狼 ルール説明` - ワンナイト人狼のルール\n" +
      "`/help 項目: ワンナイト人狼 役職一覧` - ワンナイト人狼の役職\n" +
      "`/help 項目: ギシンアンキ ルール説明` - ギシンアンキのルール\n" +
      "`/help 項目: ギシンアンキ 役職一覧` - ギシンアンキの役職"
    );
  }

  async skipVote(guildId: string, userId: string): Promise<string> {
    const game = this.games.get(guildId);
    if (!game) return "ゲームが進行中ではありません。";
    if (game.hostUserId !== userId) return "ホストのみがスキップできます。";
    if (game.phase !== GamePhase.DAY_DISCUSSION) return "会議時間中のみスキップできます。";
    log(guildId, `Host <${userId}> skipped meeting`);
    if (game.meetingTimer) clearTimeout(game.meetingTimer);
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return "ギルドが見つかりません。";
    if (game.settings.gameMode === GameMode.ONENIGHT) {
      await this.startOneNightVoting(guild, game);
      return "会議をスキップし、投票に移ります。";
    }
    if (game.settings.gameMode === GameMode.GISHINANKI) {
      return "ギシンアンキモードではスキップ機能は使用できません。";
    }
    if (game.dayCount === 1) {
      await this.startNight(guild, game);
      return "会議をスキップし、夜に移ります。（1日目は投票を行いません）";
    }
    await this.startVoting(guild, game);
    return "会議をスキップし、投票に移ります。";
  }

  async stopGame(guildId: string, userId: string): Promise<string> {
    const game = this.games.get(guildId);
    if (!game) return "ゲームが進行中ではありません。";
    if (game.hostUserId !== userId) return "ホストのみがゲームを停止できます。";
    if (game.phase === GamePhase.WAITING || game.phase === GamePhase.FINISHED) return "試合中のみ使用できます。";
    log(guildId, `Host <${userId}> stopped the game (phase: ${game.phase})`);
    await this.cleanupGame(guildId);
    return "ゲームを強制終了し、初期化しました。";
  }

  async endGame(guildId: string, userId: string): Promise<string> {
    const game = this.games.get(guildId);
    if (!game) return "ゲームが進行中ではありません。";
    if (game.phase !== GamePhase.FINISHED) return "試合終了後のみ使用できます。";
    if (game.hostUserId !== userId) return "ホストのみがゲームを終了できます。";
    log(guildId, `Host <${userId}> ended the game`);
    await this.cleanupGame(guildId);
    return "ゲームを初期化しました。";
  }

  private async cleanupGame(guildId: string): Promise<void> {
    const game = this.games.get(guildId);
    if (!game) return;
    log(guildId, "Cleaning up game channels and state");
    const guild = this.client.guilds.cache.get(guildId);

    if (game.settings.gameMode === GameMode.ONENIGHT || game.settings.gameMode === GameMode.GISHINANKI) {
      if (guild && game.gameTextChannelId) {
        const ch = guild.channels.cache.get(game.gameTextChannelId);
        if (ch) { try { await ch.delete(); } catch {} }
      }
      if (game.meetingTimer) clearTimeout(game.meetingTimer);
      if (game.nightActionTimeout) clearTimeout(game.nightActionTimeout);
      this.deleteGame(guildId);
      return;
    }

    if (guild) {
      if (game.waitingVoiceChannelId) {
        const wvc = guild.channels.cache.get(game.waitingVoiceChannelId) as VoiceChannel | undefined;
        if (wvc) {
          for (const member of [...wvc.members.values()]) {
            try { await member.voice.setMute(false); } catch {}
          }
        }
      }

      if (game.gameVoiceChannelId) {
        const gameVC = guild.channels.cache.get(game.gameVoiceChannelId) as VoiceChannel | undefined;
        if (gameVC) {
          for (const member of [...gameVC.members.values()]) {
            try { await member.voice.setMute(false); } catch {}
          }
          const waitingVC = game.waitingVoiceChannelId ? (guild.channels.cache.get(game.waitingVoiceChannelId) as VoiceChannel | undefined) : undefined;
          for (const member of [...gameVC.members.values()]) {
            try { if (waitingVC) await member.voice.setChannel(waitingVC); else await member.voice.disconnect(); } catch {}
          }
        }
      }

      let categoryId: string | null = null;
      const ids = [game.gameTextChannelId, game.gameVoiceChannelId, game.werewolfTextChannelId, game.spectatorTextChannelId];
      for (const id of ids) {
        if (id) {
          const ch = guild.channels.cache.get(id);
          if (ch) {
            if (!categoryId && ch.parentId) categoryId = ch.parentId;
            try { await ch.delete(); } catch {}
          }
        }
      }

      if (categoryId) {
        const cat = guild.channels.cache.get(categoryId);
        if (cat) { try { await cat.delete(); } catch {} }
      }
    }
    if (game.meetingTimer) clearTimeout(game.meetingTimer);
    if (game.nightActionTimeout) clearTimeout(game.nightActionTimeout);
    this.deleteGame(guildId);
  }

  loadSettings(guildId: string): { participants: string[]; settings: GameSettings } | null {
    const game = this.games.get(guildId);
    if (game) {
      return {
        participants: [...game.participants],
        settings: {
          gameMode: game.settings.gameMode,
          meetingTimeMinutes: game.settings.meetingTimeMinutes,
          roleDistribution: { ...game.settings.roleDistribution },
          anonymousVoting: game.settings.anonymousVoting,
        },
      };
    }
    const persisted = this.persistence.getSettings(guildId);
    if (!persisted) return null;
    return {
      participants: persisted.participants,
      settings: {
        gameMode: persisted.gameMode ?? GameMode.CLASSIC,
        meetingTimeMinutes: persisted.meetingTimeMinutes,
        roleDistribution: { ...persisted.roleDistribution },
        anonymousVoting: persisted.anonymousVoting ?? true,
      },
    };
  }

  getHostUserId(guildId: string): string | null {
    const game = this.games.get(guildId);
    return game ? game.hostUserId : null;
  }

  getActiveGameGuildIds(): string[] {
    const ids: string[] = [];
    for (const [guildId, game] of this.games) {
      if (game.phase !== GamePhase.WAITING && game.phase !== GamePhase.FINISHED) {
        ids.push(guildId);
      }
    }
    return ids;
  }

  async muteSpectator(memberId: string, channelId: string, guild: Guild): Promise<void> {
    for (const gid of this.getActiveGameGuildIds()) {
      const game = this.games.get(gid)!;
      if (game.waitingVoiceChannelId === channelId && !game.participants.includes(memberId)) {
        const gameGuild = this.client.guilds.cache.get(gid) ?? guild;
        try {
          const member = await gameGuild.members.fetch(memberId);
          await member.voice.setMute(true);
          // 途中から観戦に加わった人にも観戦用チャンネルを見せる
          if (game.spectatorTextChannelId) {
            const specCh = gameGuild.channels.cache.get(game.spectatorTextChannelId) as TextChannel | undefined;
            if (specCh) {
              await specCh.permissionOverwrites
                .create(memberId, { ViewChannel: true, SendMessages: true })
                .catch(() => {});
            }
          }
          console.log(`[Game ${gid.slice(0, 8)}] Server-muted spectator ${memberId} in waiting VC`);
        } catch {}
      }
    }
  }

  private async resolveDisplayNames(guild: Guild, userIds: string[]): Promise<Map<string, string>> {
    const entries = await Promise.all(
      userIds.map(async (id) => {
        try {
          const member = await guild.members.fetch(id);
          return [id, member.displayName] as const;
        } catch {
          return [id, id] as const;
        }
      })
    );
    return new Map(entries);
  }
}
