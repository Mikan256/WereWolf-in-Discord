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

const EPHEMERAL = 64;

export class GameManager {
  private games: Map<string, GameState> = new Map();
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  getGame(guildId: string): GameState | undefined {
    return this.games.get(guildId);
  }

  createGame(guildId: string, hostUserId: string): GameState {
    const game: GameState = {
      guildId, hostUserId,
      phase: GamePhase.WAITING,
      settings: { meetingTimeMinutes: 3, roleDistribution: {} },
      players: new Map(), participants: [], dayCount: 0,
      gameTextChannelId: null, gameVoiceChannelId: null,
      werewolfTextChannelId: null, spectatorTextChannelId: null,
      waitingVoiceChannelId: null,
      votes: new Map(), nightActionResult: [],
      meetingTimer: null, nightActionTimeout: null,
    };
    this.games.set(guildId, game);
    return game;
  }

  deleteGame(guildId: string): void { this.games.delete(guildId); }

  async setSetting(
    guildId: string, hostUserId: string, participants: string[],
    werewolfCount: number, accompliceCount: number, madmanCount: number,
    fanaticCount: number, foxCount: number, fortuneTellerCount: number,
    mediumCount: number, knightCount: number, teruTeruCount: number,
    nekomataCount: number, blackCatCount: number, meetingTimeMinutes: number,
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
    return "設定が完了しました。`/start` でゲームを開始できます。";
  }

  async startGame(guildId: string, userId: string): Promise<string> {
    const game = this.games.get(guildId);
    if (!game) return "設定が行われていません。先に `/setting` を行ってください。";
    if (game.hostUserId !== userId) return "ホストのみがゲームを開始できます。";
    if (game.phase !== GamePhase.WAITING) return "すでにゲームが開始されています。";
    if (game.participants.length < 4) return "最低4人以上の参加者が必要です。";

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

      if (werewolfIds.length > 0) {
        const wwChannel = guild.channels.cache.get(game.werewolfTextChannelId!) as TextChannel;
        if (wwChannel) {
          const names = werewolfIds.map((id) => `<@${id}>`).join(", ");
          await wwChannel.send(`**人狼メンバー**: ${names}\n夜になったらここで襲撃する相手を相談してください。`);
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
    const werewolfIds = game.participants.filter((p) => game.players.get(p)?.role === RoleType.WEREWOLF);
    for (const wid of werewolfIds) {
      await werewolfText.permissionOverwrites.create(wid, { ViewChannel: true, SendMessages: false });
    }

    game.gameTextChannelId = gameText.id;
    game.gameVoiceChannelId = gameVoice.id;
    game.werewolfTextChannelId = werewolfText.id;
    game.spectatorTextChannelId = spectatorText.id;
  }

  private async sendRoleMessages(guild: Guild, game: GameState): Promise<void> {
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    const werewolfIds = game.participants.filter((p) => game.players.get(p)!.role === RoleType.WEREWOLF);
    const accompliceIds = game.participants.filter((p) => game.players.get(p)!.role === RoleType.ACCOMPLICE);
    const fanaticIds = game.participants.filter((p) => game.players.get(p)!.role === RoleType.FANATIC);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...game.participants.map((pid) =>
        new ButtonBuilder()
          .setCustomId(`reveal_${pid}`)
          .setLabel(`${guild.members.cache.get(pid)?.displayName ?? pid} の役職`)
          .setStyle(ButtonStyle.Secondary)
      ),
    );

    const msg = await gameChannel.send({
      content: "**役職を確認するには、自分の名前のボタンをクリックしてください。**\n（クリックするとあなただけに見える形で役職が表示されます）",
      components: [row],
    });

    const collector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId.startsWith("reveal_") && game.participants.includes(i.user.id),
      time: 120000,
    });

    collector.on("collect", async (i) => {
      const pid = i.customId.replace("reveal_", "");
      if (pid !== i.user.id) {
        await i.reply({ content: "他の人の役職は確認できません。", flags: EPHEMERAL });
        return;
      }

      const ps = game.players.get(pid)!;
      const def = ROLE_DEFINITIONS[ps.role];

      let extra = "";
      if (ps.role === RoleType.WEREWOLF && werewolfIds.length > 0) {
        extra += `\n\n**他の人狼**: ${werewolfIds.filter((id) => id !== pid).map((id) => `<@${id}>`).join(", ")}`;
      }
      if (ps.role === RoleType.WEREWOLF && fanaticIds.length > 0) {
        extra += `\n\n**狂信者**: ${fanaticIds.map((id) => `<@${id}>`).join(", ")}`;
      }
      if (ps.role === RoleType.FANATIC && werewolfIds.length > 0) {
        extra += `\n\n**人狼メンバー**: ${werewolfIds.map((id) => `<@${id}>`).join(", ")}`;
      }
      if (ps.role === RoleType.ACCOMPLICE && werewolfIds.length > 0) {
        extra += `\n\n**人狼メンバー**: ${werewolfIds.map((id) => `<@${id}>`).join(", ")}`;
      }

      await i.reply({
        content: `あなたの役職は **${def.name}** です！\n${def.description}\n勝利条件: ${def.winCondition}${extra}`,
        flags: EPHEMERAL,
      });
    });
  }

  private async startDayDiscussion(guild: Guild, game: GameState): Promise<void> {
    game.phase = GamePhase.DAY_DISCUSSION;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    await gameChannel.send(`**${game.dayCount}日目の昼です！**\n会議を開始してください。（制限時間: ${game.settings.meetingTimeMinutes}分）`);

    const wwChannel = game.werewolfTextChannelId
      ? (guild.channels.cache.get(game.werewolfTextChannelId) as TextChannel | undefined) : undefined;
    if (wwChannel) {
      await wwChannel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    }

    if (game.meetingTimer) clearTimeout(game.meetingTimer);
    game.meetingTimer = setTimeout(async () => { await this.startVoting(guild, game); }, game.settings.meetingTimeMinutes * 60 * 1000);

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
    if (game.phase !== GamePhase.DAY_DISCUSSION) return;
    game.phase = GamePhase.DAY_VOTING;
    game.votes.clear();

    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);

    const embed = new EmbedBuilder()
      .setTitle(`投票時間 - ${game.dayCount}日目`)
      .setDescription("下のボタンをクリックして投票してください。")
      .setColor(0xff0000);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vote_open").setLabel("投票する").setStyle(ButtonStyle.Primary),
    );

    await gameChannel.send({ embeds: [embed], components: [row] });

    const collector = gameChannel.createMessageComponentCollector({
      filter: (i) => alivePlayers.includes(i.user.id),
      time: 60000,
    });

    collector.on("collect", async (i) => {
      if (i.customId === "vote_open") {
        const select = new StringSelectMenuBuilder()
          .setCustomId(`vote_select`)
          .setPlaceholder("投票先を選んでください")
          .addOptions(
            alivePlayers.filter((p) => p !== i.user.id).map((p) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(guild.members.cache.get(p)?.displayName ?? p)
                .setValue(p)
            )
          );
        await i.reply({
          content: "追放したいプレイヤーを選んでください。",
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
          flags: EPHEMERAL,
        });
      } else if (i.customId.startsWith("vote_")) {
        const pid = i.customId.replace("vote_", "");
        const current = game.votes.get(pid);
        const select = new StringSelectMenuBuilder()
          .setCustomId(`vote_select`)
          .setPlaceholder(current ? `現在: ${guild.members.cache.get(current)?.displayName} (変更する)` : "投票先を選んでください")
          .addOptions(
            alivePlayers.filter((p) => p !== pid).map((p) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(guild.members.cache.get(p)?.displayName ?? p)
                .setValue(p)
            )
          );
        await i.update({
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        });
      }
    });

    setTimeout(async () => {
      collector.stop();
      await this.processVotingResults(guild, game);
    }, 60000);
  }

  private async processVotingResults(guild: Guild, game: GameState): Promise<void> {
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);

    let resultMsg = "**投票結果:**\n";
    for (const pid of alivePlayers) {
      const vote = game.votes.get(pid);
      resultMsg += `<@${pid}> → ${vote ? `<@${vote}>` : "棄権"}\n`;
    }

    const voteCount = new Map<string, number>();
    for (const [, target] of game.votes) voteCount.set(target, (voteCount.get(target) || 0) + 1);

    if (voteCount.size === 0) {
      await gameChannel.send(resultMsg + "\n投票なし。明日へ続きます。");
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

  private async handleElimination(guild: Guild, game: GameState, playerId: string, cause: "vote" | "werewolf"): Promise<void> {
    const ps = game.players.get(playerId);
    if (!ps) return;
    ps.isAlive = false;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    if (cause === "vote") {
      await gameChannel.send(`**追放**: <@${playerId}> が追放されました。`);
      if (ps.role === RoleType.TERU_TERU) { await this.handleTeruTeruWin(guild, game, playerId); return; }
      if (ps.role === RoleType.NEKOMATA) await this.handleNekomataVoteDeath(guild, game, playerId);
      if (ps.role === RoleType.BLACK_CAT) await this.handleBlackCatVoteDeath(guild, game, playerId);
    }
  }

  private async handleTeruTeruWin(guild: Guild, game: GameState, playerId: string): Promise<void> {
    game.phase = GamePhase.FINISHED;
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
      const select = new StringSelectMenuBuilder()
        .setCustomId(`runoff_select`)
        .setPlaceholder("投票先を選んでください")
        .addOptions(candidates.map((c) =>
          new StringSelectMenuOptionBuilder().setLabel(guild.members.cache.get(c)?.displayName ?? c).setValue(c)
        ));
      await i.reply({
        content: "追放したいプレイヤーを選んでください。",
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        flags: EPHEMERAL,
      });
    });

    setTimeout(async () => {
      collector.stop();
      const voteCount = new Map<string, number>();
      for (const [, target] of game.votes) voteCount.set(target, (voteCount.get(target) || 0) + 1);

      if (voteCount.size === 0) {
        await gameChannel.send("決選投票でも決着がつきませんでした。明日へ続きます。");
        await this.startNight(guild, game);
        return;
      }

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
    }, 30000);
  }

  private async startNight(guild: Guild, game: GameState): Promise<void> {
    game.phase = GamePhase.NIGHT;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const gameVoice = guild.channels.cache.get(game.gameVoiceChannelId!) as VoiceChannel;

    await gameChannel.send(`**${game.dayCount}日目の夜です。**\n全員ミュートになりました。下のボタンをクリックしてアクションを行ってください。`);

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

    game.nightActionResult = [];
    await this.runNightActions(guild, game);
  }

  private async runNightActions(guild: Guild, game: GameState): Promise<void> {
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);
    const actionQueue: RoleType[] = [];

    if (alivePlayers.some((p) => game.players.get(p)?.role === RoleType.KNIGHT)) actionQueue.push(RoleType.KNIGHT);
    if (alivePlayers.some((p) => game.players.get(p)?.role === RoleType.FORTUNE_TELLER)) actionQueue.push(RoleType.FORTUNE_TELLER);
    if (alivePlayers.some((p) => game.players.get(p)?.role === RoleType.MEDIUM)) actionQueue.push(RoleType.MEDIUM);
    actionQueue.push(RoleType.WEREWOLF);

    await this.processNightActionQueue(guild, game, actionQueue, 0);
  }

  private async processNightActionQueue(guild: Guild, game: GameState, queue: RoleType[], index: number): Promise<void> {
    if (index >= queue.length) { await this.finalizeNight(guild, game); return; }

    const role = queue[index];
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);
    const actors = alivePlayers.filter((p) => game.players.get(p)?.role === role);

    if (actors.length === 0) {
      await this.processNightActionQueue(guild, game, queue, index + 1);
      return;
    }

    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const label = role === RoleType.WEREWOLF ? `襲撃する` : `能力を使う`;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`night_${role}`).setLabel(`${getRoleName(role)}: ${label}`).setStyle(ButtonStyle.Primary),
    );

    const msg = await gameChannel.send({
      content: `**${getRoleName(role)}のアクション**: ${actors.map((a) => `<@${a}>`).join(", ")} さん、下のボタンをクリックしてください。`,
      components: [row],
    });

    let actionResolve: () => void;
    const actionPromise = new Promise<void>((resolve) => { actionResolve = resolve; });

    const completed = new Set<string>();
    const totalActors = actors.length;
    const targets = alivePlayers;

    const collector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === `night_${role}` && actors.includes(i.user.id),
      time: 35000,
    });

    collector.on("collect", async (i) => {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`night_select_${role}`)
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

    const selectCollector = gameChannel.createMessageComponentCollector({
      filter: (i) => i.customId === `night_select_${role}` && actors.includes(i.user.id),
      time: 35000,
    });

    selectCollector.on("collect", async (i) => {
      if (!i.isStringSelectMenu()) return;
      const targetId = i.values[0];
      if (completed.has(i.user.id)) {
        await i.update({ content: "すでにアクションは完了しています。", components: [] });
        return;
      }
      completed.add(i.user.id);

      game.nightActionResult.push(`${role}:${i.user.id}:${targetId}`);

      let actionMsg = "";
      switch (role) {
        case RoleType.KNIGHT:
          game.players.get(targetId)!.isProtected = true;
          actionMsg = `**<@${targetId}>** を守護しました。`;
          break;
        case RoleType.FORTUNE_TELLER:
          actionMsg = `**<@${targetId}>** の陣営: **${getFortuneResult(game.players.get(targetId)!.role)}**`;
          break;
        case RoleType.MEDIUM:
          actionMsg = !game.players.get(targetId)?.isAlive
            ? `**<@${targetId}>** は死亡しています。陣営: **${getFortuneResult(game.players.get(targetId)!.role)}**`
            : `**<@${targetId}>** は生存しています。`;
          break;
        case RoleType.WEREWOLF:
          actionMsg = `**<@${targetId}>** を襲撃対象に選びました。`;
          break;
      }

      await i.update({ content: actionMsg, components: [] });

      if (completed.size >= totalActors) {
        collector.stop();
        selectCollector.stop();
        actionResolve!();
      }
    });

    setTimeout(() => {
      collector.stop();
      selectCollector.stop();
      actionResolve!();
    }, 40000);

    await actionPromise;
    await this.processNightActionQueue(guild, game, queue, index + 1);
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
      const [, , targetId] = werewolfActions[werewolfActions.length - 1].split(":");
      if (targetId) {
        const tp = game.players.get(targetId);
        if (tp) {
          if (tp.role === RoleType.FOX) {
            await gameChannel.send("妖狐は人狼の襲撃を回避しました。");
          } else if (tp.role === RoleType.NEKOMATA) {
            tp.isAlive = false;
            await gameChannel.send(`**<@${targetId}>** が昨夜、殺害されました。（猫又）`);
            const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
            if (specChannel) await specChannel.send(`**${game.dayCount}日目の夜:** <@${targetId}> (猫又) が人狼に殺害されました。`);
            await this.handleNekomataWerewolfDeath(guild, game, targetId);
          } else if (tp.isProtected) {
            await gameChannel.send("騎士が守護していたため、襲撃は失敗しました。");
            tp.isProtected = false;
          } else {
            tp.isAlive = false;
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

    if (this.checkWinCondition(game)) return;

    await gameChannel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
    game.dayCount++;
    await this.startDayDiscussion(guild, game);
  }

  private checkWinCondition(game: GameState): boolean {
    const alive = game.participants.filter((p) => game.players.get(p)?.isAlive);
    const aliveTrueWW = alive.filter((p) => isTrueWerewolf(game.players.get(p)!.role));
    const aliveVillagerSide = alive.filter((p) => game.players.get(p)!.team === Team.VILLAGER || isCountedAsVillager(game.players.get(p)!.role));
    const aliveFox = alive.filter((p) => game.players.get(p)!.role === RoleType.FOX);

    if (aliveTrueWW.length === 0) {
      this.handleWin(game, aliveFox.length > 0 ? null : Team.VILLAGER, false, aliveFox.length > 0);
      return true;
    }
    if (aliveTrueWW.length >= aliveVillagerSide.length) {
      this.handleWin(game, aliveFox.length > 0 ? null : Team.WEREWOLF, false, aliveFox.length > 0);
      return true;
    }
    return false;
  }

  private async handleWin(game: GameState, winningTeam: Team | null, _teruTeru = false, foxWin = false): Promise<void> {
    const guild = this.client.guilds.cache.get(game.guildId);
    if (!guild) return;
    game.phase = GamePhase.FINISHED;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

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
    if (game.meetingTimer) clearTimeout(game.meetingTimer);
    const guild = this.client.guilds.cache.get(guildId);
    if (guild) await this.startVoting(guild, game);
    return "会議をスキップし、投票に移ります。";
  }

  async stopGame(guildId: string, userId: string): Promise<string> {
    const game = this.games.get(guildId);
    if (!game) return "ゲームが進行中ではありません。";
    if (game.hostUserId !== userId) return "ホストのみがゲームを停止できます。";
    if (game.phase === GamePhase.WAITING || game.phase === GamePhase.FINISHED) return "試合中のみ使用できます。";
    await this.cleanupGame(guildId);
    return "ゲームを強制終了し、初期化しました。";
  }

  async endGame(guildId: string, userId: string): Promise<string> {
    const game = this.games.get(guildId);
    if (!game) return "ゲームが進行中ではありません。";
    if (game.phase !== GamePhase.FINISHED) return "試合終了後のみ使用できます。";
    if (game.hostUserId !== userId) return "ホストのみがゲームを終了できます。";
    await this.cleanupGame(guildId);
    return "ゲームを初期化しました。";
  }

  private async cleanupGame(guildId: string): Promise<void> {
    const game = this.games.get(guildId);
    if (!game) return;
    const guild = this.client.guilds.cache.get(guildId);
    if (guild) {
      if (game.gameVoiceChannelId) {
        const gameVC = guild.channels.cache.get(game.gameVoiceChannelId) as VoiceChannel | undefined;
        if (gameVC) {
          const waitingVC = game.waitingVoiceChannelId ? (guild.channels.cache.get(game.waitingVoiceChannelId) as VoiceChannel | undefined) : undefined;
          for (const member of [...gameVC.members.values()]) {
            try { if (waitingVC) await member.voice.setChannel(waitingVC); else await member.voice.disconnect(); } catch {}
          }
        }
      }
      const ids = [game.gameTextChannelId, game.gameVoiceChannelId, game.werewolfTextChannelId, game.spectatorTextChannelId];
      for (const id of ids) {
        if (id) { const ch = guild.channels.cache.get(id); if (ch) { try { await ch.delete(); } catch {} } }
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
