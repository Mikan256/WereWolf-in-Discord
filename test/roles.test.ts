import test from "node:test";
import assert from "node:assert/strict";

import {
  distributeRoles,
  getFortuneResult,
  getRoleDescription,
  getRoleName,
  getTeam,
  isCountedAsVillager,
  isTrueWerewolf,
  shuffle,
} from "../src/game/roles";
import { RoleType, Team } from "../src/game/types";

test("getTeam returns the correct team for every role family", () => {
  for (const role of [
    RoleType.WEREWOLF,
    RoleType.ACCOMPLICE,
    RoleType.MADMAN,
    RoleType.FANATIC,
    RoleType.BLACK_CAT,
    RoleType.WEREWOLF_GISHIN,
  ]) {
    assert.equal(getTeam(role), Team.WEREWOLF, `${role} should be werewolf team`);
  }

  for (const role of [RoleType.FOX, RoleType.TERU_TERU, RoleType.GHOST]) {
    assert.equal(getTeam(role), Team.THIRD, `${role} should be third team`);
  }

  for (const role of [
    RoleType.VILLAGER,
    RoleType.FORTUNE_TELLER,
    RoleType.MEDIUM,
    RoleType.KNIGHT,
    RoleType.NEKOMATA,
    RoleType.ROBBER,
    RoleType.TROUBLEMAKER,
    RoleType.DRUNK,
    RoleType.INSOMNIAC,
    RoleType.HUNTER_ONENIGHT,
    RoleType.SURVIVOR,
    RoleType.FOOL,
  ]) {
    assert.equal(getTeam(role), Team.VILLAGER, `${role} should be villager team`);
  }
});

test("isTrueWerewolf only counts the real werewolves", () => {
  assert.equal(isTrueWerewolf(RoleType.WEREWOLF), true);
  assert.equal(isTrueWerewolf(RoleType.WEREWOLF_GISHIN), true);
  assert.equal(isTrueWerewolf(RoleType.ACCOMPLICE), false);
  assert.equal(isTrueWerewolf(RoleType.MADMAN), false);
  assert.equal(isTrueWerewolf(RoleType.BLACK_CAT), false);
});

test("isCountedAsVillager treats wolf-team helpers as villager-side headcount", () => {
  for (const role of [
    RoleType.ACCOMPLICE,
    RoleType.MADMAN,
    RoleType.FANATIC,
    RoleType.BLACK_CAT,
  ]) {
    assert.equal(isCountedAsVillager(role), true, `${role} should count as villager side`);
  }
  assert.equal(isCountedAsVillager(RoleType.WEREWOLF), false);
  assert.equal(isCountedAsVillager(RoleType.WEREWOLF_GISHIN), false);
  assert.equal(isCountedAsVillager(RoleType.VILLAGER), false);
  assert.equal(isCountedAsVillager(RoleType.FOX), false);
});

test("getFortuneResult hides only the accomplice", () => {
  assert.equal(getFortuneResult(RoleType.WEREWOLF), "人狼陣営");
  assert.equal(getFortuneResult(RoleType.MADMAN), "人狼陣営");
  assert.equal(getFortuneResult(RoleType.FANATIC), "人狼陣営");
  assert.equal(getFortuneResult(RoleType.BLACK_CAT), "人狼陣営");
  assert.equal(getFortuneResult(RoleType.ACCOMPLICE), "市民陣営");
  assert.equal(getFortuneResult(RoleType.VILLAGER), "市民陣営");
  assert.equal(getFortuneResult(RoleType.FOX), "第三陣営");
  assert.equal(getFortuneResult(RoleType.TERU_TERU), "第三陣営");
  assert.equal(getFortuneResult(RoleType.GHOST), "第三陣営");
});

test("all roles have a display name and description", () => {
  for (const role of Object.values(RoleType)) {
    assert.ok(getRoleName(role).length > 0, `missing name for ${role}`);
    assert.ok(getRoleDescription(role).length > 0, `missing description for ${role}`);
  }
});

test("shuffle keeps every element and does not mutate the input", () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const output = shuffle(input);
  assert.notEqual(output, input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...output].sort((a, b) => a - b), input);
  assert.deepEqual(shuffle([]), []);
});

test("distributeRoles assigns the requested roles and fills the rest with villagers", () => {
  const players = ["a", "b", "c", "d", "e"];
  const roles = distributeRoles(players, {
    [RoleType.WEREWOLF]: 1,
    [RoleType.FORTUNE_TELLER]: 1,
    [RoleType.KNIGHT]: 1,
  });

  assert.equal(roles.size, players.length);
  const values = [...roles.values()];
  assert.equal(values.filter((r) => r === RoleType.WEREWOLF).length, 1);
  assert.equal(values.filter((r) => r === RoleType.FORTUNE_TELLER).length, 1);
  assert.equal(values.filter((r) => r === RoleType.KNIGHT).length, 1);
  assert.equal(values.filter((r) => r === RoleType.VILLAGER).length, 2);
  for (const player of players) {
    assert.ok(roles.has(player), `missing role for ${player}`);
  }
});
