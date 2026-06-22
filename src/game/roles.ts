import { RoleType, Team } from "./types";

export function getTeam(role: RoleType): Team {
  switch (role) {
    case RoleType.WEREWOLF:
    case RoleType.ACCOMPLICE:
      return Team.WEREWOLF;
    case RoleType.FOX:
      return Team.THIRD;
    default:
      return Team.VILLAGER;
  }
}

export function getRoleName(role: RoleType): string {
  const names: Record<RoleType, string> = {
    [RoleType.VILLAGER]: "市民",
    [RoleType.WEREWOLF]: "人狼",
    [RoleType.ACCOMPLICE]: "共犯者",
    [RoleType.FOX]: "妖狐",
    [RoleType.FORTUNE_TELLER]: "占い師",
    [RoleType.MEDIUM]: "霊媒師",
    [RoleType.KNIGHT]: "騎士",
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
    [RoleType.FOX]:
      "あなたは妖狐です。人狼に襲われても死にませんが、占いや投票で死亡します。両陣営の勝負がついたとき生き残っていれば単独勝利します。",
    [RoleType.FORTUNE_TELLER]:
      "あなたは占い師です。夜に一人を選んで占い、その陣営を確認できます。(共犯者は市民と表示)",
    [RoleType.MEDIUM]:
      "あなたは霊媒師です。夜に死亡したプレイヤーを一人選び、その陣営を確認できます。(共犯者は市民と表示)",
    [RoleType.KNIGHT]:
      "あなたは騎士です。夜に一人を選んで守護し、人狼の襲撃から守ります。",
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
