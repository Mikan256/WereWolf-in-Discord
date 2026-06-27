import { RoleType, Team } from "./types";

const WEREWOLF_TEAM_ROLES = new Set([
  RoleType.WEREWOLF, RoleType.ACCOMPLICE,
  RoleType.MADMAN, RoleType.FANATIC, RoleType.BLACK_CAT,
  RoleType.WEREWOLF_GISHIN,
]);

export function isTrueWerewolf(role: RoleType): boolean {
  return role === RoleType.WEREWOLF || role === RoleType.WEREWOLF_GISHIN;
}

export function isCountedAsVillager(role: RoleType): boolean {
  return role !== RoleType.WEREWOLF && WEREWOLF_TEAM_ROLES.has(role);
}

export function getTeam(role: RoleType): Team {
  if (WEREWOLF_TEAM_ROLES.has(role)) return Team.WEREWOLF;
  if (role === RoleType.FOX || role === RoleType.TERU_TERU || role === RoleType.GHOST) return Team.THIRD;
  return Team.VILLAGER;
}

export function getRoleName(role: RoleType): string {
  const names: Record<RoleType, string> = {
    [RoleType.VILLAGER]: "市民",
    [RoleType.WEREWOLF]: "人狼",
    [RoleType.ACCOMPLICE]: "共犯者",
    [RoleType.MADMAN]: "狂人",
    [RoleType.FANATIC]: "狂信者",
    [RoleType.FOX]: "妖狐",
    [RoleType.FORTUNE_TELLER]: "占い師",
    [RoleType.MEDIUM]: "霊媒師",
    [RoleType.KNIGHT]: "騎士",
    [RoleType.TERU_TERU]: "てるてる坊主",
    [RoleType.NEKOMATA]: "猫又",
    [RoleType.BLACK_CAT]: "黒猫",
    [RoleType.ROBBER]: "怪盗",
    [RoleType.TROUBLEMAKER]: "トラブルメーカー",
    [RoleType.DRUNK]: "酔っ払い",
    [RoleType.INSOMNIAC]: "失眠症",
    [RoleType.HUNTER_ONENIGHT]: "狩人",
    [RoleType.TANNER]: "皮なめし職人",
    [RoleType.SURVIVOR]: "生存者",
    [RoleType.MISANTHROPIST]: "人間不信",
    [RoleType.WEREWOLF_GISHIN]: "人狼",
    [RoleType.GHOST]: "幽霊",
    [RoleType.FOOL]: "愚者",
  };
  return names[role];
}

export function getRoleDescription(role: RoleType): string {
  const descriptions: Record<RoleType, string> = {
    [RoleType.VILLAGER]:
      "あなたは市民です。昼の会議で議論し、投票で人狼を見つけ出しましょう。",
    [RoleType.WEREWOLF]:
      "あなたは人狼です。夜に他の人狼と相談して市民を襲撃しましょう。他の人狼メンバーが分かります。",
    [RoleType.ACCOMPLICE]:
      "あなたは共犯者です。人狼陣営ですが、人狼用チャンネルにはアクセスできません。誰が人狼か知ることができます。",
    [RoleType.MADMAN]:
      "あなたは狂人です。人狼陣営ですが、誰が人狼かは分かりません。人狼からもあなたが誰かは分かりません。",
    [RoleType.FANATIC]:
      "あなたは狂信者です。人狼陣営で、誰が人狼か分かります。人狼からもあなたが狂信者と把握されています。",
    [RoleType.FOX]:
      "あなたは妖狐です。人狼に襲われても死にませんが、占いや投票で死亡します。両陣営の勝負がついたとき生き残っていれば単独勝利します。",
    [RoleType.FORTUNE_TELLER]:
      "あなたは占い師です。夜に一人を選んで占い、その陣営を確認できます。(共犯者は市民と表示)",
    [RoleType.MEDIUM]:
      "あなたは霊媒師です。夜に死亡したプレイヤーを一人選び、その陣営を確認できます。(共犯者は市民と表示)",
    [RoleType.KNIGHT]:
      "あなたは騎士です。夜に一人を選んで守護し、人狼の襲撃から守ります。",
    [RoleType.TERU_TERU]:
      "あなたはてるてる坊主です。会議の投票で死亡すると勝利します。それ以外の死に方や他陣営の勝利時は敗北します。",
    [RoleType.NEKOMATA]:
      "あなたは猫又です。投票で死亡した場合、ランダムに一人道連れにします。人狼に殺された場合、人狼からランダムに一人道連れにします。騎士の守護は無効です。",
    [RoleType.BLACK_CAT]:
      "あなたは黒猫です。投票で死亡した場合、人狼陣営を除いたプレイヤーからランダムに一人道連れにします。",
    [RoleType.ROBBER]:
      "あなたは怪盗です。夜に他のプレイヤー1人と役職カードを交換できます。交換後、自分の新しい役職を確認できます。",
    [RoleType.TROUBLEMAKER]:
      "あなたはトラブルメーカーです。夜に自分以外のプレイヤー2人を選び、その役職カードを交換します。中身は見えません。",
    [RoleType.DRUNK]:
      "あなたは酔っ払いです。夜に自分の役職カードをセンターカードのいずれか1枚と交換します。中身は見えません。",
    [RoleType.INSOMNIAC]:
      "あなたは失眠症です。夜の最後に自分の現在の役職を確認できます。自分が交換されたかどうかを知ることができます。",
    [RoleType.HUNTER_ONENIGHT]:
      "あなたは狩人です。投票で追放された場合、自分に投票したプレイヤーの中からランダムに1人道連れにします。",
    [RoleType.TANNER]:
      "あなたは皮なめし職人です。自分が追放されると単独勝利します。追放されることを目指しましょう。",
    [RoleType.SURVIVOR]:
      "あなたは生存者です。自由に行動・交渉できます。山札からカードを引いたり、相手に手札を見せてもらうことができます。決断は「留まる」または「立ち去る」から選びます。",
    [RoleType.MISANTHROPIST]:
      "あなたは人間不信です。他プレイヤーにカードの要求ができません。相手から要求された場合は必ず拒否しなければなりません。決断は「留まる」または「立ち去る」から選びます。",
    [RoleType.WEREWOLF_GISHIN]:
      "あなたは人狼です。人間に擬態して情報を引き出しましょう。生存者と同じように行動できます。決断は「喰らう」または「見逃す」から選びます。",
    [RoleType.GHOST]:
      "あなたは幽霊です。決断で「留まる」しか選べません。相手が人間で「立ち去る」か、相手が人狼で「喰らう」を選べばあなたの勝利です。",
    [RoleType.FOOL]:
      "あなたは愚者です。条件を満たせば場のカードと自分の役職を交換できます。決断は「留まる」または「立ち去る」から選びます。",
  };
  return descriptions[role];
}

export function distributeRoles(
  playerIds: string[],
  distribution: Partial<Record<RoleType, number>>
): Map<string, RoleType> {
  const result = new Map<string, RoleType>();
  const pool: RoleType[] = [];

  for (const [role, count] of Object.entries(distribution)) {
    for (let i = 0; i < (count as number); i++) {
      pool.push(role as RoleType);
    }
  }

  const remainingVillager = playerIds.length - pool.length;
  for (let i = 0; i < remainingVillager; i++) {
    pool.push(RoleType.VILLAGER);
  }

  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  for (let i = 0; i < shuffled.length; i++) {
    result.set(shuffled[i], pool[i]);
  }

  return result;
}

export function getFortuneResult(role: RoleType): string {
  if (role === RoleType.WEREWOLF) return "人狼陣営";
  if (role === RoleType.ACCOMPLICE) return "市民陣營"; // disguised
  if (role === RoleType.FOX) return "第三陣営";
  return "市民陣営";
}

const ONENIGHT_ROLE_NAMES: Partial<Record<RoleType, string>> = {
  [RoleType.ROBBER]: "怪盗",
  [RoleType.TROUBLEMAKER]: "トラブルメーカー",
  [RoleType.DRUNK]: "酔っ払い",
  [RoleType.INSOMNIAC]: "失眠症",
  [RoleType.HUNTER_ONENIGHT]: "狩人",
  [RoleType.TANNER]: "皮なめし職人",
};

export function getOneNightRoleName(role: RoleType): string {
  return ONENIGHT_ROLE_NAMES[role] ?? getRoleName(role);
}

const ONENIGHT_ROLE_DESCRIPTIONS: Partial<Record<RoleType, string>> = {
  [RoleType.ROBBER]:
    "あなたは怪盗です。夜に他のプレイヤー1人と役職カードを交換できます。交換後、自分の新しい役職を確認できます。",
  [RoleType.TROUBLEMAKER]:
    "あなたはトラブルメーカーです。夜に自分以外のプレイヤー2人を選び、その役職カードを交換します。中身は見えません。",
  [RoleType.DRUNK]:
    "あなたは酔っ払いです。夜に自分の役職カードをセンターカードのいずれか1枚と交換します。中身は見えません。",
  [RoleType.INSOMNIAC]:
    "あなたは失眠症です。夜の最後に自分の現在の役職を確認できます。自分が交換されたかどうかを知ることができます。",
  [RoleType.HUNTER_ONENIGHT]:
    "あなたは狩人です。投票で追放された場合、自分に投票したプレイヤーの中からランダムに1人道連れにします。",
  [RoleType.TANNER]:
    "あなたは皮なめし職人です。自分が追放されると単独勝利します。追放されることを目指しましょう。",
};

export function getOneNightRoleDescription(role: RoleType): string {
  return ONENIGHT_ROLE_DESCRIPTIONS[role] ?? getRoleDescription(role);
}
