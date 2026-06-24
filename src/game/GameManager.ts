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
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import {
  GamePhase,
  GameState,
  RoleType,
  Team,
  ROLE_DEFINITIONS,
} from "./types";
import {
  distributeRoles,
  getRoleName,
  getFortuneResult,
  getTeam,
  isTrueWerewolf,
  isCountedAsVillager,
} from "./roles";
import { PersistenceManager, PersistedSettings } from "../utils/persistence";

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
      ? { meetingTimeMinutes: persisted.meetingTimeMinutes, roleDistribution: { ...persisted.roleDistribution }, anonymousVoting: persisted.anonymousVoting ?? true }
      : { meetingTimeMinutes: 3, roleDistribution: {}, anonymousVoting: true };

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
    };
    this.games.set(guildId, game);
    log(guildId, `Game created by <${hostUserId}>, settings loaded from persistence: ${!!persisted}`);
    return game;
  }

  deleteGame(guildId: string): void {
    log(guildId, "Game state deleted from memory");
    this.games.delete(guildId);
  }

  async setSetting(
    guildId: string, hostUserId: string, participants: string[],
    werewolfCount: number, accompliceCount: number, madmanCount: number,
    fanaticCount: number, foxCount: number, fortuneTellerCount: number,
    mediumCount: number, knightCount: number, teruTeruCount: number,
    nekomataCount: number, blackCatCount: number, meetingTimeMinutes: number,
    anonymousVoting?: boolean,
  ): Promise<string> {
    let game = this.games.get(guildId);
    if (!game) game = this.createGame(guildId, hostUserId);
    if (game.hostUserId !== hostUserId) return "ホストのみが設定を変更できます。";
    if (game.phase !== GamePhase.WAITING) return "ゲームが進行中のため設定を変更できません。";

    const total = werewolfCount + accompliceCount + madmanCount + fanaticCount +
      foxCount + fortuneTellerCount + mediumCount + knightCount +
      teruTeruCount + nekomataCount + blackCatCount;
    if (total > participants.length) return "参加者数より役職数の合計が多いです。";

    game.participants = participants;
    game.settings.roleDistribution = {};
    const entries: [number, RoleType][] = [
      [werewolfCount, RoleType.WEREWOLF], [accompliceCount, RoleType.ACCOMPLICE],
      [madmanCount, RoleType.MADMAN], [fanaticCount, RoleType.FANATIC],
      [foxCount, RoleType.FOX], [fortuneTellerCount, RoleType.FORTUNE_TELLER],
      [mediumCount, RoleType.MEDIUM], [knightCount, RoleType.KNIGHT],
      [teruTeruCount, RoleType.TERU_TERU], [nekomataCount, RoleType.NEKOMATA],
      [blackCatCount, RoleType.BLACK_CAT],
    ];
    for (const [c, r] of entries) { if (c > 0) game.settings.roleDistribution[r] = c; }
    game.settings.meetingTimeMinutes = meetingTimeMinutes;
    if (anonymousVoting !== undefined) game.settings.anonymousVoting = anonymousVoting;

    log(guildId, `Settings updated: participants=${participants.length}, roles=${JSON.stringify(game.settings.roleDistribution)}, meetingTime=${meetingTimeMinutes}min, anonymousVoting=${game.settings.anonymousVoting}`);

    try {
      await this.persistence.setSettings(guildId, {
        hostUserId,
        participants,
        roleDistribution: { ...game.settings.roleDistribution },
        meetingTimeMinutes,
        anonymousVoting: game.settings.anonymousVoting,
      });
    } catch (e) {
      log(guildId, `Persistence save failed: ${e}`);
      return "設定の保存に失敗しました。ファイルの権限を確認してください。";
    }

    return "設定が完了しました。`/start` でゲームを開始できます。";
  }

  async startGame(guildId: string, userId: string): Promise<string> {
    const game = this.games.get(guildId);
    if (!game) return "設定が行われていません。先に `/setting` を行ってください。";
    if (game.hostUserId !== userId) return "ホストのみがゲームを開始できます。";
    if (game.phase !== GamePhase.WAITING) return "すでにゲームが開始されています。";
    if (game.participants.length < 4) return "最低4人以上の参加者が必要です。";
    log(guildId, `Host <${userId}> starting game with ${game.participants.length} players`);

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return "ギルドが見つかりません。";

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
      return "ゲーム開始中にエラーが発生しました。";
    }
  }

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
        await gameVoice.permissionOverwrites.create(pid, { ViewChannel: true, Connect: true, Speak: false });
        try {
          const member = await guild.members.fetch(pid);
          if (member.voice.channelId === waitingVC.id) await member.voice.setChannel(gameVoice);
        } catch {}
      }
    } else {
      gameVoice = await guild.channels.create({
        name: "ゲーム用ボイス", type: ChannelType.GuildVoice, parent: category.id,
        permissionOverwrites: [
          { id: everyone.id, deny: ["ViewChannel"], type: OverwriteType.Role },
          ...game.participants.map((pid) => ({
            id: pid, allow: ["ViewChannel", "Connect"] as const, deny: ["Speak"] as const, type: OverwriteType.Member as const,
          })),
        ],
      });
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
        try {
          const member = await guild.members.fetch(pid);
          if (member.voice.channelId === gameVoice.id) await member.voice.setMute(false);
        } catch {}
      }
    }
  }

  private async startVoting(guild: Guild, game: GameState): Promise<void> {
    log(guild.id, `Day ${game.dayCount} discussion started (${game.settings.meetingTimeMinutes}min)`);
    if (game.phase !== GamePhase.DAY_DISCUSSION) return;
    game.phase = GamePhase.DAY_VOTING;
    log(guild.id, `Day ${game.dayCount} voting started`);
    game.votes.clear();

    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);

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
                .setLabel(guild.members.cache.get(p)?.displayName ?? p)
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
            new StringSelectMenuOptionBuilder().setLabel(guild.members.cache.get(c)?.displayName ?? c).setValue(c)
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
      const werewolfIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.WEREWOLF && game.players.get(p)?.isAlive);
      for (const wid of werewolfIds) await wwChannel.permissionOverwrites.edit(wid, { SendMessages: true });
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
      const info = this.getNightActionInfo(game.guildId, i.user.id);
      if (typeof info === "string") {
        await i.reply({ content: info, flags: EPHEMERAL });
        return;
      }

      const { role, targets } = info;

      const select = new StringSelectMenuBuilder()
        .setCustomId("night_action_select")
        .setPlaceholder("対象を選んでください")
        .addOptions(targets.map((t) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(guild.members.cache.get(t)?.displayName ?? t)
            .setValue(t)
        ));

      await i.reply({
        content: `**${getRoleName(role)}:** 対象を選んでください。`,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        flags: EPHEMERAL,
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
      const allDone = nightRolePlayers.every((pid) => {
        const r = game.players.get(pid)?.role;
        if (r === RoleType.WEREWOLF) return actedUsers.has(pid);
        return actedUsers.has(pid);
      });
      if (allDone) { nightResolve(); nightResolve = null; }
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

    const def = ROLE_DEFINITIONS[player.role];
    const werewolfIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.WEREWOLF);
    const fanaticIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.FANATIC);

    let msg = `あなたの役職は **${def.name}** です！\n${def.description}\n勝利条件: ${def.winCondition}`;

    if (player.role === RoleType.WEREWOLF && werewolfIds.length > 0) {
      msg += `\n\n**他の人狼**: ${werewolfIds.filter((id) => id !== userId).map((id) => `<@${id}>`).join(", ")}`;
    }
    if (player.role === RoleType.WEREWOLF && fanaticIds.length > 0) {
      msg += `\n\n**狂信者**: ${fanaticIds.map((id) => `<@${id}>`).join(", ")}`;
    }
    if (player.role === RoleType.FANATIC && werewolfIds.length > 0) {
      msg += `\n\n**人狼メンバー**: ${werewolfIds.map((id) => `<@${id}>`).join(", ")}`;
    }
    if (player.role === RoleType.ACCOMPLICE && werewolfIds.length > 0) {
      msg += `\n\n**人狼メンバー**: ${werewolfIds.map((id) => `<@${id}>`).join(", ")}`;
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
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const wwChannel = game.werewolfTextChannelId
      ? (guild.channels.cache.get(game.werewolfTextChannelId) as TextChannel | undefined) : undefined;

    if (wwChannel) {
      const werewolfIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.WEREWOLF && game.players.get(p)?.isAlive);
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
        for (const [, ow] of gtch.permissionOverwrites.cache) {
          if (ow.type === OverwriteType.Member) {
            try { await ow.delete(); } catch {}
          }
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
    const game = this.games.get(guildId);
    if (!game) return "設定がまだ行われていません。";
    if (game.hostUserId !== userId) return "ホストのみが設定を確認できます。";
    const dist = game.settings.roleDistribution;
    let msg = `**現在の設定**\n参加者: ${game.participants.length}人\n`;
    for (const [role, count] of Object.entries(dist)) {
      if ((count as number) > 0) msg += `${getRoleName(role as RoleType)}: ${count}人\n`;
    }
    msg += `会議時間: ${game.settings.meetingTimeMinutes}分\nフェーズ: ${game.phase}`;
    return msg;
  }

  getHelp(args?: string): string {
    if (args === "roles") {
      let msg = "**役職一覧**\n\n";
      for (const def of Object.values(ROLE_DEFINITIONS)) {
        msg += `**${def.name}** (${def.team === Team.VILLAGER ? "市民陣営" : def.team === Team.WEREWOLF ? "人狼陣営" : "第三陣営"})\n${def.description}\n勝利条件: ${def.winCondition}\n\n`;
      }
      msg += "※狂人・共犯者・狂信者・黒猫は人狼陣営だが勝敗の人数カウントでは市民陣営側の人数としてカウントされます。";
      return msg;
    }
    return "**コマンド一覧**\n`/setting` - 対話形式で設定を決める (ホストのみ)\n`/setting-status` - 現在の設定を確認する\n`/start` - ゲームを開始する (ホストのみ)\n`/stop` - ゲームを強制終了し初期化する (ホストのみ/試合中のみ)\n`/skip` - 会議時間をスキップし投票に移る (ホストのみ/会議時間中のみ)\n`/end` - 試合終了後に初期化を行う (試合終了後のみ)\n`/help` - このメッセージを表示\n`/help roles` - 役職ごとの説明を見る";
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

  getHostUserId(guildId: string): string | null {
    const game = this.games.get(guildId);
    return game ? game.hostUserId : null;
  }
}
