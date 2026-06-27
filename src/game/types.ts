export enum GameMode {
  CLASSIC = "classic",
  ONENIGHT = "oneten",
  GISHINANKI = "gishinanki",
}

export enum GamePhase {
  WAITING = "waiting",
  DAY_DISCUSSION = "day_discussion",
  DAY_VOTING = "day_voting",
  NIGHT = "night",
  FINISHED = "finished",
  GISHIN_INFORMATION = "gishin_information",
  GISHIN_DECISION = "gishin_decision",
}

export enum RoleType {
  VILLAGER = "villager",
  WEREWOLF = "werewolf",
  ACCOMPLICE = "accomplice",
  MADMAN = "madman",
  FANATIC = "fanatic",
  FOX = "fox",
  FORTUNE_TELLER = "fortune_teller",
  MEDIUM = "medium",
  KNIGHT = "knight",
  TERU_TERU = "teru_teru",
  NEKOMATA = "nekomata",
  BLACK_CAT = "black_cat",
  // One Night roles
  ROBBER = "robber",
  TROUBLEMAKER = "troublemaker",
  DRUNK = "drunk",
  INSOMNIAC = "insomniac",
  HUNTER_ONENIGHT = "hunter_one_night",
  TANNER = "tanner",
  // Gishin Anki roles
  SURVIVOR = "survivor",
  MISANTHROPIST = "misanthropist",
  WEREWOLF_GISHIN = "werewolf_gishin",
  GHOST = "ghost",
  FOOL = "fool",
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
  gameMode: GameMode;
  meetingTimeMinutes: number;
  roleDistribution: Partial<Record<RoleType, number>>;
  anonymousVoting: boolean;
}

export interface PlayerState {
  userId: string;
  role: RoleType;
  team: Team;
  isAlive: boolean;
  isProtected: boolean;
}

export interface OneNightSwap {
  kind: "player_player" | "player_center";
  actorId: string;
  targetId?: string;
  centerIndex?: number;
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
  votes: Map<string, string | null>;
  nightActionResult: string[];
  meetingTimer: NodeJS.Timeout | null;
  nightActionTimeout: NodeJS.Timeout | null;
  // One Night specific
  centerRoles: RoleType[];
  nightActionStep: number;
  originalRoles: Map<string, RoleType>;
  // Gishin Anki specific
  gishinDeck: RoleType[];
  gishinHands: Map<string, RoleType[]>;
  gishinActionTokens: Map<string, number>;
  gishinDecisions: Map<string, string>;
  gishinReady: string[];
  gishinRequestPending: { from: string; to: string } | null;
  gishinExchanges: boolean;
}

export const ONENIGHT_ROLE_DEFINITIONS: Partial<Record<RoleType, RoleInfo>> = {
  [RoleType.VILLAGER]: {
    type: RoleType.VILLAGER,
    name: "市民",
    team: Team.VILLAGER,
    description: "特殊な能力はありません。議論と投票で人狼を見つけ出しましょう。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.WEREWOLF]: {
    type: RoleType.WEREWOLF,
    name: "人狼",
    team: Team.WEREWOLF,
    description: "夜に他の人狼が誰かを確認できます。自分が人狼であることを隠して議論をかく乱しましょう。",
    winCondition: "追放されたプレイヤーが人狼でないこと。",
  },
  [RoleType.FORTUNE_TELLER]: {
    type: RoleType.FORTUNE_TELLER,
    name: "占い師",
    team: Team.VILLAGER,
    description: "夜にプレイヤー1人の役職カードを見るか、センターカード2枚を確認できます。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.ROBBER]: {
    type: RoleType.ROBBER,
    name: "怪盗",
    team: Team.VILLAGER,
    description: "夜に他のプレイヤー1人と役職カードを交換し、交換後の自分の役職を確認します。交換された相手は気づきません。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.TROUBLEMAKER]: {
    type: RoleType.TROUBLEMAKER,
    name: "トラブルメーカー",
    team: Team.VILLAGER,
    description: "夜に自分以外のプレイヤー2人を選び、その役職カードを交換します。中身は見えません。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.DRUNK]: {
    type: RoleType.DRUNK,
    name: "酔っ払い",
    team: Team.VILLAGER,
    description: "夜に自分の役職カードをセンターカードのいずれか1枚と交換します。中身は見えません。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.INSOMNIAC]: {
    type: RoleType.INSOMNIAC,
    name: "失眠症",
    team: Team.VILLAGER,
    description: "夜の最後に自分の現在の役職を確認します。自分が交換されたかどうかを知ることができます。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.HUNTER_ONENIGHT]: {
    type: RoleType.HUNTER_ONENIGHT,
    name: "狩人",
    team: Team.VILLAGER,
    description: "投票で追放された場合、自分に投票したプレイヤーの中からランダムに1人道連れにします。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.TANNER]: {
    type: RoleType.TANNER,
    name: "皮なめし職人",
    team: Team.THIRD,
    description: "自分が追放されると単独勝利します。いかに自分が追放されるかが鍵です。",
    winCondition: "会議の投票で自分が追放されること。",
  },
};

export const GISHINANKI_ROLE_DEFINITIONS: Partial<Record<RoleType, RoleInfo>> = {
  [RoleType.SURVIVOR]: {
    type: RoleType.SURVIVOR,
    name: "生存者",
    team: Team.VILLAGER,
    description: "自由に行動・交渉可能な基本の人間役職です。情報収集フェーズで山札からカードを引いたり、相手の手札を要求できます。「留まる」または「立ち去る」の決断が可能です。",
    winCondition: "相手の決断との組み合わせにより変動（勝利表参照）。",
  },
  [RoleType.MISANTHROPIST]: {
    type: RoleType.MISANTHROPIST,
    name: "人間不信",
    team: Team.VILLAGER,
    description: "他プレイヤーにカードの要求ができず、相手から要求された場合は必ず拒否しなければなりません。決断は「留まる」または「立ち去る」を選べます。",
    winCondition: "相手の決断との組み合わせにより変動（勝利表参照）。",
  },
  [RoleType.WEREWOLF_GISHIN]: {
    type: RoleType.WEREWOLF_GISHIN,
    name: "人狼",
    team: Team.WEREWOLF,
    description: "人間に擬態して情報を引き出しましょう。特殊な制限はなく、生存者と同じように行動できます。決断は「喰らう」または「見逃す」を選べます。",
    winCondition: "相手の決断との組み合わせにより変動（勝利表参照）。",
  },
  [RoleType.GHOST]: {
    type: RoleType.GHOST,
    name: "幽霊",
    team: Team.THIRD,
    description: "決断で「留まる」しか選べません。相手の決断によって勝利条件が変わる特殊な役職です。",
    winCondition: "相手が人間で「立ち去る」を選ぶ、または相手が人狼で「喰らう」を選ぶと幽霊の勝利。それ以外は敗北。",
  },
  [RoleType.FOOL]: {
    type: RoleType.FOOL,
    name: "愚者",
    team: Team.VILLAGER,
    description: "特定の条件（両者のアクションコマ消費＆カードの受け渡しなし）を満たすと、場のカードと自分の役職を交換できます。決断は「留まる」または「立ち去る」を選べます。",
    winCondition: "相手の決断との組み合わせにより変動（勝利表参照）。",
  },
};

export const ROLE_DEFINITIONS: Record<RoleType, RoleInfo> = {
  [RoleType.VILLAGER]: {
    type: RoleType.VILLAGER,
    name: "市民",
    team: Team.VILLAGER,
    description: "昼の時間にゲーム用のテキストチャンネルで会議をして投票を行います。",
    winCondition: "人狼陣営(共犯者/狂人/狂信者/黒猫以外の人狼陣営)が全員死亡すること。",
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
  [RoleType.MADMAN]: {
    type: RoleType.MADMAN,
    name: "狂人",
    team: Team.WEREWOLF,
    description:
      "昼に議論の場をかき乱します。誰が人狼なのかを知ることはできず、人狼からも誰が狂人なのかはわかりません。",
    winCondition: "市民陣営の数が人狼陣営の数の同数以下になること。",
  },
  [RoleType.FANATIC]: {
    type: RoleType.FANATIC,
    name: "狂信者",
    team: Team.WEREWOLF,
    description:
      "昼に議論の場をかき乱します。誰が人狼なのかがわかるし、人狼からも誰が狂信者かは把握できます。",
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
    winCondition: "人狼陣営(共犯者/狂人/狂信者/黒猫以外の人狼陣営)が全員死亡すること。",
  },
  [RoleType.MEDIUM]: {
    type: RoleType.MEDIUM,
    name: "霊媒師",
    team: Team.VILLAGER,
    description:
      "夜の時間にプレイヤーを一人選び、そのプレイヤーがすでに死んでいた場合、その役職の陣営を把握できます。(共犯者は市民陣営と表示されます)",
    winCondition: "人狼陣営(共犯者/狂人/狂信者/黒猫以外の人狼陣営)が全員死亡すること。",
  },
  [RoleType.KNIGHT]: {
    type: RoleType.KNIGHT,
    name: "騎士",
    team: Team.VILLAGER,
    description:
      "夜の時間にプレイヤーを一人選び、そのプレイヤーを守護します。守護されたプレイヤーは人狼に殺されるのを回避できます。",
    winCondition: "人狼陣営(共犯者/狂人/狂信者/黒猫以外の人狼陣営)が全員死亡すること。",
  },
  [RoleType.TERU_TERU]: {
    type: RoleType.TERU_TERU,
    name: "てるてる坊主",
    team: Team.THIRD,
    description:
      "会議の投票によって死亡したら勝利します。それ以外の勝利か他陣営が勝利したときは敗北します。",
    winCondition: "他陣営の勝敗が決まる前に会議の投票で死亡すること。",
  },
  [RoleType.NEKOMATA]: {
    type: RoleType.NEKOMATA,
    name: "猫又",
    team: Team.VILLAGER,
    description:
      "会議の投票によって死亡した場合は全プレイヤーの中からランダムに一人道連れにします。人狼によって殺された場合は人狼の中から一人をランダムに道連れにします。(騎士による守りは発動不可)",
    winCondition: "人狼陣営(共犯者/狂人/狂信者/黒猫以外の人狼陣営)が全員死亡すること。",
  },
  [RoleType.BLACK_CAT]: {
    type: RoleType.BLACK_CAT,
    name: "黒猫",
    team: Team.WEREWOLF,
    description:
      "会議の投票によって死亡した場合は人狼陣営を除いたプレイヤーの中からランダムに一人道連れにします。(騎士による守りは発動不可)",
    winCondition: "市民陣営の数が人狼陣営の数の同数以下になること。",
  },
  [RoleType.ROBBER]: {
    type: RoleType.ROBBER,
    name: "怪盗",
    team: Team.VILLAGER,
    description: "夜に他のプレイヤー1人と役職カードを交換し、交換後の自分の役職を確認します。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.TROUBLEMAKER]: {
    type: RoleType.TROUBLEMAKER,
    name: "トラブルメーカー",
    team: Team.VILLAGER,
    description: "夜に自分以外のプレイヤー2人を選び、その役職カードを交換します。中身は見えません。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.DRUNK]: {
    type: RoleType.DRUNK,
    name: "酔っ払い",
    team: Team.VILLAGER,
    description: "夜に自分の役職カードをセンターカードのいずれか1枚と交換します。中身は見えません。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.INSOMNIAC]: {
    type: RoleType.INSOMNIAC,
    name: "失眠症",
    team: Team.VILLAGER,
    description: "夜の最後に自分の現在の役職を確認します。自分が交換されたかどうかを知ることができます。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.HUNTER_ONENIGHT]: {
    type: RoleType.HUNTER_ONENIGHT,
    name: "狩人",
    team: Team.VILLAGER,
    description: "投票で追放された場合、自分に投票したプレイヤーの中からランダムに1人道連れにします。",
    winCondition: "追放されたプレイヤーが人狼であること。",
  },
  [RoleType.TANNER]: {
    type: RoleType.TANNER,
    name: "皮なめし職人",
    team: Team.THIRD,
    description: "自分が追放されると単独勝利します。",
    winCondition: "会議の投票で自分が追放されること。",
  },
  // Gishin Anki roles
  [RoleType.SURVIVOR]: {
    type: RoleType.SURVIVOR,
    name: "生存者",
    team: Team.VILLAGER,
    description: "自由に行動・交渉可能な基本の人間役職です。",
    winCondition: "相手の決断との組み合わせにより変動。",
  },
  [RoleType.MISANTHROPIST]: {
    type: RoleType.MISANTHROPIST,
    name: "人間不信",
    team: Team.VILLAGER,
    description: "カードの要求が不可。相手から要求されたら必ず拒否。",
    winCondition: "相手の決断との組み合わせにより変動。",
  },
  [RoleType.WEREWOLF_GISHIN]: {
    type: RoleType.WEREWOLF_GISHIN,
    name: "人狼",
    team: Team.WEREWOLF,
    description: "人間に擬態。特殊な制限はなく、生存者と同じように行動できる。",
    winCondition: "相手の決断との組み合わせにより変動。",
  },
  [RoleType.GHOST]: {
    type: RoleType.GHOST,
    name: "幽霊",
    team: Team.THIRD,
    description: "決断で「留まる」しか選べない。",
    winCondition: "相手が人間で「立ち去る」または相手が人狼で「喰らう」で幽霊勝利。",
  },
  [RoleType.FOOL]: {
    type: RoleType.FOOL,
    name: "愚者",
    team: Team.VILLAGER,
    description: "条件を満たすと場のカードと役職を交換できる。",
    winCondition: "相手の決断との組み合わせにより変動。",
  },
};
