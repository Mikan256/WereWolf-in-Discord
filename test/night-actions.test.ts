import test from "node:test";
import assert from "node:assert/strict";

import { GameMode, GamePhase, RoleType } from "../src/game/types";
import { addPlayer, createManager } from "./helpers";

function setupNightGame() {
  const { manager } = createManager();
  const game = manager.createGame("g-night", "host");
  game.participants = ["wolf1", "wolf2", "seer", "knight", "medium", "villager", "dead", "deadSeer"];
  addPlayer(game, "wolf1", RoleType.WEREWOLF);
  addPlayer(game, "wolf2", RoleType.WEREWOLF);
  addPlayer(game, "seer", RoleType.FORTUNE_TELLER);
  addPlayer(game, "knight", RoleType.KNIGHT);
  addPlayer(game, "medium", RoleType.MEDIUM);
  addPlayer(game, "villager", RoleType.VILLAGER);
  addPlayer(game, "dead", RoleType.VILLAGER, { isAlive: false });
  addPlayer(game, "deadSeer", RoleType.FORTUNE_TELLER, { isAlive: false });
  game.phase = GamePhase.NIGHT;
  return { manager, game };
}

test("getNightActionInfo rejects non-night phases and players without night abilities", () => {
  const { manager, game } = setupNightGame();

  game.phase = GamePhase.DAY_DISCUSSION;
  assert.match(manager.getNightActionInfo("g-night", "seer") as string, /現在夜ではありません/);
  game.phase = GamePhase.NIGHT;

  assert.match(manager.getNightActionInfo("g-night", "villager") as string, /能力がありません/);
  assert.match(manager.getNightActionInfo("g-night", "deadSeer") as string, /能力がありません/);
  assert.match(manager.getNightActionInfo("g-night", "unknown") as string, /能力がありません/);
});

test("getNightActionInfo builds the correct target lists", () => {
  const { manager } = setupNightGame();

  const wolf = manager.getNightActionInfo("g-night", "wolf1");
  assert.ok(typeof wolf !== "string");
  assert.equal(wolf.role, RoleType.WEREWOLF);
  assert.ok(!wolf.targets.includes("wolf1"), "werewolf must not target itself");
  assert.ok(wolf.targets.includes("wolf2"));
  assert.ok(!wolf.targets.includes("dead"), "dead players must not be targetable");

  const seer = manager.getNightActionInfo("g-night", "seer");
  assert.ok(typeof seer !== "string");
  assert.ok(seer.targets.includes("seer"));
  assert.ok(seer.targets.includes("wolf1"));
  assert.ok(!seer.targets.includes("dead"));

  const medium = manager.getNightActionInfo("g-night", "medium");
  assert.ok(typeof medium !== "string");
  assert.ok(medium.targets.includes("dead"), "medium can inspect dead players");
  assert.ok(medium.targets.includes("deadSeer"));
});

test("getNightActionInfo stops a role that has already acted", () => {
  const { manager, game } = setupNightGame();
  game.nightActionResult.push(`${RoleType.FORTUNE_TELLER}:seer:wolf1`);

  assert.match(manager.getNightActionInfo("g-night", "seer") as string, /すでにアクションは完了/);
});

test("recordNightAction protects the knight's target and blocks duplicate actions", () => {
  const { manager, game } = setupNightGame();

  manager.recordNightAction("g-night", "knight", "villager", RoleType.KNIGHT);
  assert.equal(game.players.get("villager")!.isProtected, true);

  const duplicate = manager.recordNightAction("g-night", "knight", "seer", RoleType.KNIGHT);
  assert.match(duplicate, /すでにアクションは完了/);
  assert.equal(game.players.get("seer")!.isProtected, false);
  assert.equal(game.nightActionResult.filter((a) => a.startsWith(`${RoleType.KNIGHT}:`)).length, 1);
});

test("recordNightAction lets a werewolf change its vote instead of adding a second one", () => {
  const { manager, game } = setupNightGame();

  manager.recordNightAction("g-night", "wolf1", "seer", RoleType.WEREWOLF);
  manager.recordNightAction("g-night", "wolf1", "villager", RoleType.WEREWOLF);

  const votes = game.nightActionResult.filter((a) => a.startsWith("werewolf:wolf1:"));
  assert.equal(votes.length, 1);
  assert.equal(votes[0], "werewolf:wolf1:villager");
});

test("recordNightAction returns fortune and medium results", () => {
  const { manager } = setupNightGame();

  const seerResult = manager.recordNightAction("g-night", "seer", "wolf1", RoleType.FORTUNE_TELLER);
  assert.match(seerResult, /人狼陣営/);

  const mediumResult = manager.recordNightAction("g-night", "medium", "dead", RoleType.MEDIUM);
  assert.match(mediumResult, /死亡/);
  assert.match(mediumResult, /市民陣営/);
});

test("getMyRole shares werewolf members with werewolves, fanatics and accomplices", () => {
  const { manager } = createManager();
  const game = manager.createGame("g-role", "host");
  game.participants = ["wolf1", "wolf2", "fanatic", "accomplice", "villager"];
  addPlayer(game, "wolf1", RoleType.WEREWOLF);
  addPlayer(game, "wolf2", RoleType.WEREWOLF);
  addPlayer(game, "fanatic", RoleType.FANATIC);
  addPlayer(game, "accomplice", RoleType.ACCOMPLICE);
  addPlayer(game, "villager", RoleType.VILLAGER);

  const wolfView = manager.getMyRole("g-role", "wolf1")!;
  assert.match(wolfView, /人狼/);
  assert.match(wolfView, /<@wolf2>/);
  assert.match(wolfView, /狂信者/);
  assert.match(wolfView, /<@fanatic>/);

  const fanaticView = manager.getMyRole("g-role", "fanatic")!;
  assert.match(fanaticView, /人狼メンバー/);
  assert.match(fanaticView, /<@wolf1>/);

  const accompliceView = manager.getMyRole("g-role", "accomplice")!;
  assert.match(accompliceView, /人狼メンバー/);
  assert.match(accompliceView, /<@wolf1>/);

  assert.equal(manager.getMyRole("g-role", "unknown"), null);
});

test("getMyRole uses one-night and gishin role definitions", () => {
  const { manager } = createManager();
  const game = manager.createGame("g-mode", "host");
  game.participants = ["p1"];
  addPlayer(game, "p1", RoleType.VILLAGER);

  game.settings.gameMode = GameMode.ONENIGHT;
  const oneNight = manager.getMyRole("g-mode", "p1")!;
  assert.match(oneNight, /市民/);
  assert.match(oneNight, /追放されたプレイヤーが人狼であること/);

  game.settings.gameMode = GameMode.GISHINANKI;
  addPlayer(game, "p1", RoleType.SURVIVOR);
  const gishin = manager.getMyRole("g-mode", "p1")!;
  assert.match(gishin, /生存者/);
  assert.match(gishin, /相手の決断/);
});

test("getGame and deleteGame manage the in-memory game map", () => {
  const { manager } = createManager();
  manager.createGame("g-lifecycle", "host");
  assert.ok(manager.getGame("g-lifecycle"));

  manager.deleteGame("g-lifecycle");
  assert.equal(manager.getGame("g-lifecycle"), undefined);
});
