export enum GamePhase {
  WAITING = "waiting",
  DAY_DISCUSSION = "day_discussion",
  DAY_VOTING = "day_voting",
  NIGHT = "night",
  FINISHED = "finished",
}

export enum RoleType {
  VILLAGER = "villager",
  WEREWOLF = "werewolf",
  ACCOMPLICE = "accomplice",
  FOX = "fox",
  FORTUNE_TELLER = "fortune_teller",
  MEDIUM = "medium",
  KNIGHT = "knight",
}

export enum Team {
  VILLAGER = "villager",
  WEREWOLF = "werewolf",
  THIRD = "third",
}

export interface RoleInfo {
  type: RoleType;
  name: string;
  team: Team;
  description: string;
  winCondition: string;
}

export interface GameSettings {
  meetingTimeMinutes: number;
  roleDistribution: Partial<Record<RoleType, number>>;
}

export interface PlayerState {
  userId: string;
  role: RoleType;
  team: Team;
  isAlive: boolean;
  isProtected: boolean;
}

export interface GameState {
  guildId: string;
  hostUserId: string;
  phase: GamePhase;
  settings: GameSettings;
  players: Map<string, PlayerState>;
  participants: string[];
  dayCount: number;
  gameTextChannelId: string | null;
  gameVoiceChannelId: string | null;
  werewolfTextChannelId: string | null;
  spectatorTextChannelId: string | null;
  waitingVoiceChannelId: string | null;
  votes: Map<string, string>;
  nightActionResult: string[];
  meetingTimer: NodeJS.Timeout | null;
  nightActionTimeout: NodeJS.Timeout | null;
}

export const ROLE_DEFINITIONS: Record<RoleType, RoleInfo> = {
  [RoleType.VILLAGER]: {
    type: RoleType.VILLAGER,
    name: "市民",
    team: Team.VILLAGER,
    description: "昼の時間にゲーム用のテキストチャンネルで会議をして投票を行います。",
    winCondition: "人狼陣営が全員死亡すること。",
  },
  [RoleType.WEREWOLF]: {
    type: RoleType.WEREWOLF,
    name: "人狼",
    team: Team.WEREWOLF,
    description:
      "昼は議論の場をかき乱し、夜に人狼用テキストチャンネルで会議して殺す市民を選びます。他の人狼が誰か分かります。",
    winCondition: "市民陣営の数が人狼陣営の数の同数以下になること。",
  },
  [RoleType.ACCOMPLICE]: {
    type: RoleType.ACCOMPLICE,
    name: "共犯者",
    team: Team.WEREWOLF,
    description:
      "昼に議論の場をかき乱します。誰が人狼なのかを知ることができますが、人狼からは誰が共犯者なのかはわかりません。",
    winCondition: "市民陣営の数が人狼陣営の数の同数以下になること。",
  },
  [RoleType.FOX]: {
    type: RoleType.FOX,
    name: "妖狐",
    team: Team.THIRD,
    description:
      "人狼によって殺されるのに選ばれても死亡しませんが、占われたり会議の投票によって死亡します。",
    winCondition:
      "人狼陣営か市民陣営のどちらかが勝利した場合に自分自身が生き残っていたときに、別陣営の勝利を取り消して単独で勝利します。",
  },
  [RoleType.FORTUNE_TELLER]: {
    type: RoleType.FORTUNE_TELLER,
    name: "占い師",
    team: Team.VILLAGER,
    description:
      "夜の時間にプレイヤーをひとり選んで占い、その役職の陣営を把握できます。(共犯者は市民陣営と表示されます)",
    winCondition: "人狼陣営が全員死亡すること。",
  },
  [RoleType.MEDIUM]: {
    type: RoleType.MEDIUM,
    name: "霊媒師",
    team: Team.VILLAGER,
    description:
      "夜の時間にプレイヤーを一人選び、そのプレイヤーがすでに死んでいた場合、その役職の陣営を把握できます。(共犯者は市民陣営と表示されます)",
    winCondition: "人狼陣営が全員死亡すること。",
  },
  [RoleType.KNIGHT]: {
    type: RoleType.KNIGHT,
    name: "騎士",
    team: Team.VILLAGER,
    description:
      "夜の時間にプレイヤーを一人選び、そのプレイヤーを守護します。守護されたプレイヤーは人狼に殺されるのを回避できます。",
    winCondition: "人狼陣営が全員死亡すること。",
  },
};
