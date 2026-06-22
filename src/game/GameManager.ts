import {
  Client,
  Guild,
  TextChannel,
  VoiceChannel,
  CategoryChannel,
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
  GameSettings,
  PlayerState,
  RoleType,
  Team,
  ROLE_DEFINITIONS,
} from "./types";
import { distributeRoles, getRoleName, getFortuneResult, getTeam } from "./roles";

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
      guildId,
      hostUserId,
      phase: GamePhase.WAITING,
      settings: {
        meetingTimeMinutes: 3,
        roleDistribution: {},
      },
      players: new Map(),
      participants: [],
      dayCount: 0,
      gameTextChannelId: null,
      gameVoiceChannelId: null,
      werewolfTextChannelId: null,
      spectatorTextChannelId: null,
      waitingVoiceChannelId: null,
      votes: new Map(),
      nightActionResult: [],
      meetingTimer: null,
      nightActionTimeout: null,
    };
    this.games.set(guildId, game);
    return game;
  }

  deleteGame(guildId: string): void {
    this.games.delete(guildId);
  }

  async setSetting(
    guildId: string,
    hostUserId: string,
    participants: string[],
    werewolfCount: number,
    accompliceCount: number,
    foxCount: number,
    fortuneTellerCount: number,
    mediumCount: number,
    knightCount: number,
    meetingTimeMinutes: number
  ): Promise<string> {
    let game = this.games.get(guildId);
    if (!game) {
      game = this.createGame(guildId, hostUserId);
    }
    if (game.hostUserId !== hostUserId) return "ホストのみが設定を変更できます。";
    if (game.phase !== GamePhase.WAITING) return "ゲームが進行中のため設定を変更できません。";

    const totalSpecial =
      werewolfCount + accompliceCount + foxCount + fortuneTellerCount + mediumCount + knightCount;
    if (totalSpecial > participants.length) {
      return "参加者数より役職数の合計が多いです。";
    }

    game.participants = participants;
    game.settings.roleDistribution = {};
    if (werewolfCount > 0) game.settings.roleDistribution[RoleType.WEREWOLF] = werewolfCount;
    if (accompliceCount > 0) game.settings.roleDistribution[RoleType.ACCOMPLICE] = accompliceCount;
    if (foxCount > 0) game.settings.roleDistribution[RoleType.FOX] = foxCount;
    if (fortuneTellerCount > 0)
      game.settings.roleDistribution[RoleType.FORTUNE_TELLER] = fortuneTellerCount;
    if (mediumCount > 0) game.settings.roleDistribution[RoleType.MEDIUM] = mediumCount;
    if (knightCount > 0) game.settings.roleDistribution[RoleType.KNIGHT] = knightCount;
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
        const team = getTeam(role);
        game.players.set(pid, {
          userId: pid,
          role,
          team,
          isAlive: true,
          isProtected: false,
        });
      }

      await this.sendRoleMessages(guild, game);

      const werewolfIds = game.participants.filter(
        (p) => game.players.get(p)!.role === RoleType.WEREWOLF
      );
      if (werewolfIds.length > 0) {
        const wwChannel = guild.channels.cache.get(game.werewolfTextChannelId!) as TextChannel;
        if (wwChannel) {
          const werewolfNames = werewolfIds
            .map((id) => `<@${id}>`)
            .join(", ");
          await wwChannel.send(
            `**人狼メンバー**: ${werewolfNames}\n夜になったらここで襲撃する相手を相談してください。`
          );
        }
      }

      const accompliceIds = game.participants.filter(
        (p) => game.players.get(p)!.role === RoleType.ACCOMPLICE
      );
      for (const aid of accompliceIds) {
        const user = await guild.members.fetch(aid);
        if (user) {
          const wwNames = werewolfIds.map((id) => `<@${id}>`).join(", ");
          await user.send(
            `あなたは共犯者です。以下のプレイヤーが人狼です：${wwNames}`
          ).catch(() => {});
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
    const category = await guild.channels.create({
      name: "人狼ゲーム",
      type: ChannelType.GuildCategory,
    });

    const everyoneRole = guild.roles.everyone;

    const gameText = await guild.channels.create({
      name: "ゲーム用テキスト",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: everyoneRole.id,
          deny: ["ViewChannel"],
          type: OverwriteType.Role,
        },
      ],
    });

    for (const pid of game.participants) {
      await gameText.permissionOverwrites.create(pid, {
        ViewChannel: true,
      });
    }

    const spectatorText = await guild.channels.create({
      name: "観戦用テキスト",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: everyoneRole.id,
          deny: ["ViewChannel"],
          type: OverwriteType.Role,
        },
      ],
    });

    const waitingVC = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildVoice && c.name.includes("待機")
    ) as VoiceChannel | undefined;

    let gameVoice: VoiceChannel;
    if (waitingVC) {
      game.waitingVoiceChannelId = waitingVC.id;
      gameVoice = await guild.channels.create({
        name: "ゲーム用ボイス",
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
          {
            id: everyoneRole.id,
            deny: ["ViewChannel"],
            type: OverwriteType.Role,
          },
        ],
      });
      for (const pid of game.participants) {
        await gameVoice.permissionOverwrites.create(pid, {
          ViewChannel: true,
          Connect: true,
          Speak: false,
        });
        try {
          const member = await guild.members.fetch(pid);
          if (member.voice.channelId === waitingVC.id) {
            await member.voice.setChannel(gameVoice);
          }
        } catch {}
      }
    } else {
      gameVoice = await guild.channels.create({
        name: "ゲーム用ボイス",
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
          {
            id: everyoneRole.id,
            deny: ["ViewChannel"],
            type: OverwriteType.Role,
          },
          ...game.participants.map((pid) => ({
            id: pid,
            allow: ["ViewChannel", "Connect"] as const,
            deny: ["Speak"] as const,
            type: OverwriteType.Member as const,
          })),
        ],
      });
    }

    const werewolfText = await guild.channels.create({
      name: "人狼用テキスト",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: everyoneRole.id,
          deny: ["ViewChannel"],
          type: OverwriteType.Role,
        },
      ],
    });

    const werewolfIds = game.participants.filter(
      (p) => getTeam(game.players.get(p)?.role ?? RoleType.VILLAGER) === Team.WEREWOLF &&
        game.players.get(p)?.role === RoleType.WEREWOLF
    );
    for (const wid of werewolfIds) {
      await werewolfText.permissionOverwrites.create(wid, {
        ViewChannel: true,
        SendMessages: false,
      });
    }

    game.gameTextChannelId = gameText.id;
    game.gameVoiceChannelId = gameVoice.id;
    game.werewolfTextChannelId = werewolfText.id;
    game.spectatorTextChannelId = spectatorText.id;
  }

  private async sendRoleMessages(guild: Guild, game: GameState): Promise<void> {
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    for (const pid of game.participants) {
      const ps = game.players.get(pid)!;
      const def = ROLE_DEFINITIONS[ps.role];
      await gameChannel.send(
        `<@${pid}> あなたの役職は **${def.name}** です！\n${def.description}\n勝利条件: ${def.winCondition}`
      );
    }
  }

  private async startDayDiscussion(guild: Guild, game: GameState): Promise<void> {
    game.phase = GamePhase.DAY_DISCUSSION;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    await gameChannel.send(
      `**${game.dayCount}日目の昼です！**\n会議を開始してください。（制限時間: ${game.settings.meetingTimeMinutes}分）`
    );

    const wwChannel = game.werewolfTextChannelId ? (guild.channels.cache.get(game.werewolfTextChannelId) as TextChannel | undefined) : undefined;
    if (wwChannel) {
      await wwChannel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false,
      });
    }

    if (game.meetingTimer) clearTimeout(game.meetingTimer);
    game.meetingTimer = setTimeout(async () => {
      await this.startVoting(guild, game);
    }, game.settings.meetingTimeMinutes * 60 * 1000);

    const gameVoice = guild.channels.cache.get(game.gameVoiceChannelId!) as VoiceChannel;
    if (gameVoice) {
      for (const pid of game.participants) {
        try {
          const member = await guild.members.fetch(pid);
          if (member.voice.channelId === gameVoice.id) {
            await member.voice.setMute(false);
          }
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
      .setDescription("追放したいプレイヤーに投票してください。")
      .setColor(0xff0000);

    await gameChannel.send({ embeds: [embed] });

    for (const pid of alivePlayers) {
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`vote_${pid}`)
        .setPlaceholder("投票先を選んでください")
        .addOptions(
          alivePlayers
            .filter((p) => p !== pid)
            .map((p) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(`<@${p}>`)
                .setValue(p)
                .setDescription(`このプレイヤーに投票`)
            )
        );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

      try {
        const dmChannel = await this.client.users.createDM(pid);
        await dmChannel.send({ content: "**投票時間です。** 追放したいプレイヤーを選んでください。", components: [row] });
      } catch {
        await gameChannel.send({ content: `<@${pid}> DMで投票してください。`, components: [row] });
      }
    }

    const voteCollectors = new Map<string, any>();

    for (const pid of alivePlayers) {
      const dmChannel = await this.client.users.createDM(pid).catch(() => null);
      const targetChannel = dmChannel || gameChannel;

      const collector = targetChannel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === pid,
        time: 60000,
      });

      collector.on("collect", async (i) => {
        const target = i.values[0];
        game.votes.set(pid, target);
        await i.reply({ content: `**<@${target}>** に投票しました。`, ephemeral: true });
      });

      voteCollectors.set(pid, collector);
    }

    setTimeout(async () => {
      for (const [, c] of voteCollectors) c.stop();
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
    for (const [, target] of game.votes) {
      voteCount.set(target, (voteCount.get(target) || 0) + 1);
    }

    if (voteCount.size === 0) {
      await gameChannel.send(resultMsg + "\n投票なし。明日へ続きます。");
      await this.startNight(guild, game);
      return;
    }

    let maxVotes = Math.max(...voteCount.values());
    let mostVoted: string[] = [];
    for (const [pid, count] of voteCount) {
      if (count === maxVotes) mostVoted.push(pid);
    }

    if (mostVoted.length > 1) {
      await gameChannel.send(
        resultMsg + `\n同票のため決選投票を行います。\n**候補**: ${mostVoted.map((id) => `<@${id}>`).join(", ")}`
      );
      await this.runRunoffVote(guild, game, mostVoted);
      return;
    }

    const eliminated = mostVoted[0];
    game.players.get(eliminated)!.isAlive = false;

    await gameChannel.send(
      resultMsg + `\n**追放**: <@${eliminated}> が追放されました。`
    );

    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) {
      await specChannel.send(
        `**${game.dayCount}日目 投票結果:** <@${eliminated}> が追放されました。（役職: ${getRoleName(game.players.get(eliminated)!.role)}）`
      );
    }

    game.votes.clear();

    if (this.checkWinCondition(game)) return;

    await this.startNight(guild, game);
  }

  private async runRunoffVote(
    guild: Guild,
    game: GameState,
    candidates: string[]
  ): Promise<void> {
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);

    game.votes.clear();
    for (const pid of alivePlayers) {
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`runoff_${pid}`)
        .setPlaceholder("決選投票")
        .addOptions(
          candidates.map((c) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`<@${c}>`)
              .setValue(c)
          )
        );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
      try {
        const dm = await this.client.users.createDM(pid);
        await dm.send({ content: "**決選投票です。**", components: [row] });
      } catch {
        await gameChannel.send({ content: `<@${pid}> DMで投票してください。`, components: [row] });
      }
    }

    setTimeout(async () => {
      const voteCount = new Map<string, number>();
      for (const [, target] of game.votes) {
        voteCount.set(target, (voteCount.get(target) || 0) + 1);
      }

      if (voteCount.size === 0) {
        await gameChannel.send("決選投票でも決着がつきませんでした。明日へ続きます。");
        await this.startNight(guild, game);
        return;
      }

      let maxVotes = Math.max(...voteCount.values());
      let mostVoted: string[] = [];
      for (const [pid, count] of voteCount) {
        if (count === maxVotes) mostVoted.push(pid);
      }

      const eliminated = mostVoted[0];
      game.players.get(eliminated)!.isAlive = false;
      await gameChannel.send(`**決選投票の結果**: <@${eliminated}> が追放されました。`);

      const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
      if (specChannel) {
        await specChannel.send(
          `**${game.dayCount}日目 決選投票結果:** <@${eliminated}> が追放されました。（役職: ${getRoleName(game.players.get(eliminated)!.role)}）`
        );
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

    await gameChannel.send(
      `**${game.dayCount}日目の夜です。**\n全員ミュートになりました。役職者はDMでアクションを行ってください。`
    );

    if (gameVoice) {
      for (const pid of game.participants) {
        try {
          const member = await guild.members.fetch(pid);
          if (member.voice.channelId === gameVoice.id) {
            await member.voice.setMute(true);
          }
        } catch {}
      }
    }

    await gameChannel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: false,
    });

    const wwChannel = game.werewolfTextChannelId ? (guild.channels.cache.get(game.werewolfTextChannelId) as TextChannel | undefined) : undefined;
    if (wwChannel) {
      const werewolfIds = game.participants.filter(
        (p) =>
          game.players.get(p)?.role === RoleType.WEREWOLF &&
          game.players.get(p)?.isAlive
      );
      for (const wid of werewolfIds) {
        await wwChannel.permissionOverwrites.edit(wid, {
          SendMessages: true,
        });
      }
      await wwChannel.send(
        `**夜になりました。** 襲撃する相手を相談し、下のボタンで襲撃先を決定してください。`
      );
    }

    game.nightActionResult = [];
    await this.runNightActions(guild, game);
  }

  private async runNightActions(guild: Guild, game: GameState): Promise<void> {
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);
    const actionQueue: RoleType[] = [];

    if (alivePlayers.some((p) => game.players.get(p)?.role === RoleType.KNIGHT))
      actionQueue.push(RoleType.KNIGHT);
    if (alivePlayers.some((p) => game.players.get(p)?.role === RoleType.FORTUNE_TELLER))
      actionQueue.push(RoleType.FORTUNE_TELLER);
    if (alivePlayers.some((p) => game.players.get(p)?.role === RoleType.MEDIUM))
      actionQueue.push(RoleType.MEDIUM);
    actionQueue.push(RoleType.WEREWOLF);

    await this.processNightActionQueue(guild, game, actionQueue, 0);
  }

  private async processNightActionQueue(
    guild: Guild,
    game: GameState,
    queue: RoleType[],
    index: number
  ): Promise<void> {
    if (index >= queue.length) {
      await this.finalizeNight(guild, game);
      return;
    }

    const role = queue[index];
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);
    const actors = alivePlayers.filter((p) => game.players.get(p)?.role === role);
    const targets = alivePlayers;

    if (actors.length === 0) {
      await this.processNightActionQueue(guild, game, queue, index + 1);
      return;
    }

    const actorNames = actors.map((a) => `<@${a}>`).join(", ");
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    await gameChannel.send(
      `**${getRoleName(role)}のアクション**: ${actorNames} さん、DMで対象を選んでください。`
    );

    let actionResolve: () => void;
    const actionPromise = new Promise<void>((resolve) => {
      actionResolve = resolve;
    });

    const actorCollectors: any[] = [];
    let completedCount = 0;
    const totalActors = actors.length;

    for (const actorId of actors) {
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`night_${role}_${actorId}`)
        .setPlaceholder(`対象を選んでください`)
        .addOptions(
          targets.map((t) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`<@${t}>`)
              .setValue(t)
          )
        );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

      try {
        const dm = await this.client.users.createDM(actorId);
        await dm.send({
          content: `**夜のアクション (${getRoleName(role)})**\n対象を選んでください。`,
          components: [row],
        });
      } catch {
        await gameChannel.send({
          content: `<@${actorId}> DMで対象を選んでください。`,
          components: [row],
        });
      }

      const targetDm = await this.client.users.createDM(actorId).catch(() => null);
      const collectorChannel = targetDm || gameChannel;

      const timeout = 30000;
      const collector = collectorChannel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === actorId,
        time: timeout,
      });

      actorCollectors.push(collector);

      collector.on("collect", async (i) => {
        const targetId = i.values[0];
        game.nightActionResult.push(`${role}:${actorId}:${targetId}`);

        let actionMsg = "";
        switch (role) {
          case RoleType.KNIGHT:
            game.players.get(targetId)!.isProtected = true;
            actionMsg = `**<@${targetId}>** を守護しました。`;
            break;
          case RoleType.FORTUNE_TELLER:
            const ftResult = getFortuneResult(game.players.get(targetId)!.role);
            actionMsg = `**<@${targetId}>** の陣営: **${ftResult}**`;
            break;
          case RoleType.MEDIUM:
            if (!game.players.get(targetId)?.isAlive) {
              const medResult = getFortuneResult(game.players.get(targetId)!.role);
              actionMsg = `**<@${targetId}>** は死亡しています。陣営: **${medResult}**`;
            } else {
              actionMsg = `**<@${targetId}>** は生存しています。`;
            }
            break;
          case RoleType.WEREWOLF:
            actionMsg = `**<@${targetId}>** を襲撃対象に選びました。`;
            break;
        }

        await i.reply({ content: actionMsg, ephemeral: true });
        completedCount++;

        if (completedCount >= totalActors) {
          for (const c of actorCollectors) c.stop();
          actionResolve!();
        }
      });
    }

    setTimeout(() => {
      for (const c of actorCollectors) c.stop();
      actionResolve!();
    }, 35000);

    await actionPromise;
    await this.processNightActionQueue(guild, game, queue, index + 1);
  }

  private async finalizeNight(guild: Guild, game: GameState): Promise<void> {
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;
    const wwChannel = game.werewolfTextChannelId ? (guild.channels.cache.get(game.werewolfTextChannelId) as TextChannel | undefined) : undefined;

    if (wwChannel) {
      const werewolfIds = game.participants.filter(
        (p) =>
          game.players.get(p)?.role === RoleType.WEREWOLF &&
          game.players.get(p)?.isAlive
      );
      for (const wid of werewolfIds) {
        await wwChannel.permissionOverwrites.edit(wid, {
          SendMessages: false,
        });
      }
    }

    const werewolfActions = game.nightActionResult.filter((a) => a.startsWith("werewolf:"));
    if (werewolfActions.length > 0) {
      const lastAction = werewolfActions[werewolfActions.length - 1];
      const [, , targetId] = lastAction.split(":");

      if (targetId) {
        const targetPlayer = game.players.get(targetId);
        if (targetPlayer) {
          if (targetPlayer.role === RoleType.FOX) {
            await gameChannel.send(
              `妖狐は人狼の襲撃を回避しました。`
            );
          } else if (targetPlayer.isProtected) {
            await gameChannel.send(
              `騎士が守護していたため、襲撃は失敗しました。`
            );
            targetPlayer.isProtected = false;
          } else {
            targetPlayer.isAlive = false;
            await gameChannel.send(
              `**<@${targetId}>** が昨夜、殺害されました。`
            );
          }
        }
      }
    } else {
      await gameChannel.send("昨夜は誰も襲撃されませんでした。");
    }

    for (const [, ps] of game.players) {
      ps.isProtected = false;
    }

    game.nightActionResult = [];

    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) {
      let deadInfo = `**${game.dayCount}日目の夜の結果:**\n`;
      for (const pid of game.participants) {
        const ps = game.players.get(pid)!;
        deadInfo += `<@${pid}>: ${ps.isAlive ? "生存" : "死亡"}`;
        if (!ps.isAlive) deadInfo += ` (${getRoleName(ps.role)})`;
        deadInfo += "\n";
      }
      await specChannel.send(deadInfo);
    }

    if (this.checkWinCondition(game)) return;

    await gameChannel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: null,
    });

    game.dayCount++;
    await this.startDayDiscussion(guild, game);
  }

  private checkWinCondition(game: GameState): boolean {
    const alivePlayers = game.participants.filter((p) => game.players.get(p)?.isAlive);
    const aliveWerewolf = alivePlayers.filter(
      (p) => game.players.get(p)?.team === Team.WEREWOLF
    );
    const aliveVillager = alivePlayers.filter(
      (p) => game.players.get(p)?.team === Team.VILLAGER
    );
    const aliveFox = alivePlayers.filter(
      (p) => game.players.get(p)?.role === RoleType.FOX
    );

    const foxAlive = aliveFox.length > 0;

    if (aliveWerewolf.length === 0) {
      this.handleWin(game, Team.VILLAGER);
      return true;
    }

    if (aliveWerewolf.length >= aliveVillager.length) {
      if (foxAlive) {
        this.handleWin(game, null, true);
      } else {
        this.handleWin(game, Team.WEREWOLF);
      }
      return true;
    }

    return false;
  }

  private async handleWin(
    game: GameState,
    winningTeam: Team | null,
    foxWin: boolean = false
  ): Promise<void> {
    const guild = this.client.guilds.cache.get(game.guildId);
    if (!guild) return;

    game.phase = GamePhase.FINISHED;
    const gameChannel = guild.channels.cache.get(game.gameTextChannelId!) as TextChannel;

    let resultMsg = "**=== ゲーム終了 ===**\n\n";

    if (foxWin) {
      resultMsg += "**妖狐の勝利！**\n妖狐が生き残り、他の陣営の勝利を打ち消しました。\n\n";
    } else if (winningTeam === Team.VILLAGER) {
      resultMsg += "**市民陣営の勝利！**\n全ての人狼を追放しました。\n\n";
    } else {
      resultMsg += "**人狼陣営の勝利！**\n市民陣営を同数以下にしました。\n\n";
    }

    resultMsg += "**役職一覧:**\n";
    for (const pid of game.participants) {
      const ps = game.players.get(pid)!;
      resultMsg += `<@${pid}>: ${getRoleName(ps.role)} (${ps.isAlive ? "生存" : "死亡"})\n`;
    }

    resultMsg += "\n`/end` でゲームを初期化してください。";

    await gameChannel.send(resultMsg);

    const specChannel = guild.channels.cache.get(game.spectatorTextChannelId!) as TextChannel;
    if (specChannel) {
      await specChannel.send(resultMsg);
    }
  }

  async skipVote(guildId: string, userId: string): Promise<string> {
    const game = this.games.get(guildId);
    if (!game) return "ゲームが進行中ではありません。";
    if (game.hostUserId !== userId) return "ホストのみがスキップできます。";
    if (game.phase !== GamePhase.DAY_DISCUSSION) return "会議時間中のみスキップできます。";

    if (game.meetingTimer) clearTimeout(game.meetingTimer);
    const guild = this.client.guilds.cache.get(guildId);
    if (guild) {
      await this.startVoting(guild, game);
    }
    return "会議をスキップし、投票に移ります。";
  }

  async stopGame(guildId: string, userId: string): Promise<string> {
    const game = this.games.get(guildId);
    if (!game) return "ゲームが進行中ではありません。";
    if (game.hostUserId !== userId) return "ホストのみがゲームを停止できます。";
    if (game.phase === GamePhase.WAITING || game.phase === GamePhase.FINISHED)
      return "試合中のみ使用できます。";

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
      const channels: (string | null)[] = [
        game.gameTextChannelId,
        game.gameVoiceChannelId,
        game.werewolfTextChannelId,
        game.spectatorTextChannelId,
      ];

      for (const chId of channels) {
        if (chId) {
          const ch = guild.channels.cache.get(chId);
          if (ch) {
            try {
              await ch.delete();
            } catch {}
          }
        }
      }

      if (game.waitingVoiceChannelId) {
        const waitingVC = guild.channels.cache.get(game.waitingVoiceChannelId) as VoiceChannel;
        if (waitingVC) {
          for (const pid of game.participants) {
            try {
              const member = await guild.members.fetch(pid);
              if (member.voice.channel) {
                await member.voice.setChannel(waitingVC);
              }
            } catch {}
          }
        }
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
