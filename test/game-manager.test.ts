import test from "node:test";
import assert from "node:assert/strict";

import { GameMode, GamePhase, RoleType } from "../src/game/types";
import { PersistedSettings } from "../src/utils/persistence";
import { createManager, makeGameState, makeSettings } from "./helpers";

const persistedClassic: PersistedSettings = {
  hostUserId: "host",
  participants: ["a", "b", "c", "d"],
  roleDistribution: { [RoleType.WEREWOLF]: 1, [RoleType.FORTUNE_TELLER]: 1 },
  meetingTimeMinutes: 5,
  anonymousVoting: false,
  gameMode: GameMode.CLASSIC,
};

test("setSetting saves the configuration and persists it", async () => {
  const { manager, persistence } = createManager();

  const result = await manager.setSetting(
    "g-save",
    "host",
    ["a", "b", "c", "d"],
    { [RoleType.WEREWOLF]: 1, [RoleType.VILLAGER]: 3 },
    5,
    false,
    GameMode.CLASSIC,
  );

  assert.match(result, /^設定が完了/);
  const game = manager.getGame("g-save");
  assert.ok(game);
  assert.equal(game.phase, GamePhase.WAITING);
  assert.deepEqual(game.participants, ["a", "b", "c", "d"]);
  assert.equal(game.settings.meetingTimeMinutes, 5);
  assert.equal(game.settings.anonymousVoting, false);

  const saved = persistence.getSettings("g-save");
  assert.ok(saved);
  assert.equal(saved.hostUserId, "host");
  assert.equal(saved.meetingTimeMinutes, 5);
  assert.equal(saved.anonymousVoting, false);
  assert.equal(saved.gameMode, GameMode.CLASSIC);
  assert.deepEqual(saved.participants, ["a", "b", "c", "d"]);
});

test("setSetting rejects a game without any werewolf", async () => {
  const { manager } = createManager();
  const result = await manager.setSetting(
    "g-no-wolf",
    "host",
    ["a", "b", "c", "d"],
    { [RoleType.FORTUNE_TELLER]: 1 },
    3,
    true,
    GameMode.CLASSIC,
  );
  assert.match(result, /人狼を1人以上/);
});

test("setSetting rejects more classic roles than participants", async () => {
  const { manager } = createManager();
  const result = await manager.setSetting(
    "g-too-many",
    "host",
    ["a", "b", "c", "d"],
    { [RoleType.WEREWOLF]: 2, [RoleType.FORTUNE_TELLER]: 2, [RoleType.KNIGHT]: 1 },
    3,
    true,
    GameMode.CLASSIC,
  );
  assert.match(result, /役職数の合計が多い/);
});

test("setSetting rejects more one-night cards than participants + 3", async () => {
  const { manager } = createManager();
  const result = await manager.setSetting(
    "g-oneten-many",
    "host",
    ["a", "b", "c"],
    {
      [RoleType.WEREWOLF]: 2,
      [RoleType.FORTUNE_TELLER]: 2,
      [RoleType.ROBBER]: 2,
      [RoleType.TROUBLEMAKER]: 1,
    },
    3,
    true,
    GameMode.ONENIGHT,
  );
  assert.match(result, /役職数の合計が多すぎます/);
});

test("setSetting requires exactly two players for gishin anki", async () => {
  const { manager } = createManager();
  const result = await manager.setSetting(
    "g-gishin",
    "host",
    ["a", "b", "c"],
    {},
    3,
    true,
    GameMode.GISHINANKI,
  );
  assert.match(result, /2人専用/);
});

test("setSetting is host-only and cannot change a running game", async () => {
  const { manager } = createManager();
  const first = await manager.setSetting(
    "g-host",
    "host",
    ["a", "b", "c", "d"],
    { [RoleType.WEREWOLF]: 1 },
    3,
    true,
    GameMode.CLASSIC,
  );
  assert.match(first, /^設定が完了/);

  const intruder = await manager.setSetting(
    "g-host",
    "intruder",
    ["a", "b", "c", "d"],
    { [RoleType.WEREWOLF]: 1 },
    3,
    true,
    GameMode.CLASSIC,
  );
  assert.match(intruder, /ホストのみ/);

  const game = manager.getGame("g-host")!;
  game.phase = GamePhase.DAY_DISCUSSION;

  const running = await manager.setSetting(
    "g-host",
    "host",
    ["a", "b", "c", "d"],
    { [RoleType.WEREWOLF]: 1 },
    3,
    true,
    GameMode.CLASSIC,
  );
  assert.match(running, /ゲームが進行中/);
});

test("loadSettings prefers the in-memory game and falls back to persistence", async () => {
  const { manager } = createManager({ "g-load": persistedClassic });

  const loaded = manager.loadSettings("g-load");
  assert.ok(loaded);
  assert.equal(loaded.settings.meetingTimeMinutes, 5);
  assert.equal(loaded.settings.anonymousVoting, false);

  await manager.setSetting(
    "g-load",
    "host",
    ["a", "b", "c", "d"],
    { [RoleType.WEREWOLF]: 2 },
    9,
    true,
    GameMode.CLASSIC,
  );

  const loadedAfter = manager.loadSettings("g-load");
  assert.ok(loadedAfter);
  assert.equal(loadedAfter.settings.meetingTimeMinutes, 9);
  assert.equal(loadedAfter.settings.anonymousVoting, true);
});

test("a new manager can restore persisted settings and start the game", async () => {
  const { manager } = createManager({ "g-restart": persistedClassic });

  // 設定は永続化データから復元され、ギルド取得まで進む
  const result = await manager.startGame("g-restart", "host");
  assert.match(result, /ギルドが見つかりません/);
  assert.doesNotMatch(result, /設定が行われていません/);
});

test("getSettingStatus is host-only and shows the saved configuration", async () => {
  const { manager } = createManager({ "g-status": persistedClassic });

  const hostView = manager.getSettingStatus("g-status", "host");
  assert.match(hostView, /現在の設定/);
  assert.match(hostView, /通常人狼/);
  assert.match(hostView, /参加者: 4人/);

  const otherView = manager.getSettingStatus("g-status", "other");
  assert.match(otherView, /ホストのみ/);
});

test("normal werewolf help excludes one-night and gishin roles", () => {
  const { manager } = createManager();
  const help = manager.getHelp(null, "classic_roles");

  for (const name of ["生存者", "人間不信", "幽霊", "愚者", "怪盗", "皮なめし職人"]) {
    assert.ok(!help.includes(name), `classic help should not include ${name}`);
  }
  assert.ok(help.includes("人狼"));
  assert.ok(help.includes("占い師"));
});

test("one-night help lists the one-night roles", () => {
  const { manager } = createManager();
  const help = manager.getHelp(null, "oneten_roles");
  for (const name of ["怪盗", "トラブルメーカー", "酔っ払い", "失眠症", "皮なめし職人"]) {
    assert.ok(help.includes(name), `one-night help should include ${name}`);
  }
});

test("prepareOneNightRoles deals every player a card and leaves three in the center", () => {
  const { manager } = createManager();
  const players = ["a", "b", "c", "d", "e"];

  for (let i = 0; i < 100; i++) {
    const game = makeGameState({
      participants: players,
      settings: makeSettings({
        gameMode: GameMode.ONENIGHT,
        roleDistribution: {
          [RoleType.WEREWOLF]: 1,
          [RoleType.FORTUNE_TELLER]: 1,
        },
      }),
    });

    (manager as any).prepareOneNightRoles(game);

    assert.equal(game.players.size, players.length);
    assert.equal(game.centerRoles.length, 3);

    const allCards = [...[...game.players.values()].map((p) => p.role), ...game.centerRoles];
    assert.equal(allCards.length, players.length + 3);
    assert.equal(allCards.filter((r) => r === RoleType.WEREWOLF).length, 1);
    assert.equal(allCards.filter((r) => r === RoleType.FORTUNE_TELLER).length, 1);
    assert.ok(allCards.every((r) => Boolean(r)));
  }
});

test("prepareGishinAnkiRoles builds the 7-card deck and initializes tokens", () => {
  const { manager } = createManager();
  const game = makeGameState({
    participants: ["a", "b"],
    settings: makeSettings({ gameMode: GameMode.GISHINANKI }),
  });

  (manager as any).prepareGishinAnkiRoles(game);

  assert.equal(game.players.size, 2);
  assert.equal(game.gishinDeck.length, 5);

  const allCards = [...[...game.players.values()].map((p) => p.role), ...game.gishinDeck];
  assert.equal(allCards.filter((r) => r === RoleType.SURVIVOR).length, 3);
  assert.equal(allCards.filter((r) => r === RoleType.MISANTHROPIST).length, 2);
  assert.equal(allCards.filter((r) => r === RoleType.WEREWOLF_GISHIN).length, 2);

  for (const pid of ["a", "b"]) {
    assert.deepEqual(game.gishinHands.get(pid), []);
    assert.equal(game.gishinActionTokens.get(pid), 2);
  }
});

test("startGame rejects a persisted game that has no werewolf", async () => {
  const { manager } = createManager();
  const game = manager.createGame("g-start-nowolf", "host");
  game.participants = ["a", "b", "c", "d"];
  game.settings.roleDistribution = { [RoleType.FORTUNE_TELLER]: 1 };

  const result = await manager.startGame("g-start-nowolf", "host");
  assert.match(result, /人狼が設定されていません/);
});

test("startGame is host-only and rejects an already started game", async () => {
  const { manager } = createManager();
  const game = manager.createGame("g-start", "host");
  game.participants = ["a", "b", "c", "d"];
  game.settings.roleDistribution = { [RoleType.WEREWOLF]: 1 };

  const notHost = await manager.startGame("g-start", "someone");
  assert.match(notHost, /ホストのみ/);

  game.phase = GamePhase.DAY_DISCUSSION;
  const alreadyStarted = await manager.startGame("g-start", "host");
  assert.match(alreadyStarted, /すでにゲームが開始されています/);
});

test("calculateGishinAnkiWinner follows the decision matrix", () => {
  const { manager } = createManager();
  const calc = (manager as any).calculateGishinAnkiWinner.bind(manager) as (
    role1: RoleType,
    dec1: string,
    role2: RoleType,
    dec2: string,
  ) => { winner1: "win" | "lose"; winner2: "win" | "lose"; reason: string };

  const humanHumanStay = calc(RoleType.SURVIVOR, "留まる", RoleType.MISANTHROPIST, "留まる");
  assert.deepEqual([humanHumanStay.winner1, humanHumanStay.winner2], ["win", "win"]);

  const humanHumanLeave = calc(RoleType.SURVIVOR, "立ち去る", RoleType.MISANTHROPIST, "留まる");
  assert.deepEqual([humanHumanLeave.winner1, humanHumanLeave.winner2], ["lose", "lose"]);

  const wolfWolfSpare = calc(RoleType.WEREWOLF_GISHIN, "見逃す", RoleType.WEREWOLF_GISHIN, "見逃す");
  assert.deepEqual([wolfWolfSpare.winner1, wolfWolfSpare.winner2], ["win", "win"]);

  const wolfWolfEat = calc(RoleType.WEREWOLF_GISHIN, "喰らう", RoleType.WEREWOLF_GISHIN, "見逃す");
  assert.deepEqual([wolfWolfEat.winner1, wolfWolfEat.winner2], ["lose", "lose"]);

  // 人間が立ち去る → 人間の勝利
  const humanLeaves = calc(RoleType.SURVIVOR, "立ち去る", RoleType.WEREWOLF_GISHIN, "喰らう");
  assert.deepEqual([humanLeaves.winner1, humanLeaves.winner2], ["win", "lose"]);

  // 人狼が見逃す → 人間の勝利
  const wolfSpares = calc(RoleType.SURVIVOR, "留まる", RoleType.WEREWOLF_GISHIN, "見逃す");
  assert.deepEqual([wolfSpares.winner1, wolfSpares.winner2], ["win", "lose"]);

  // 人間が留まり、人狼が喰らう → 人狼の勝利
  const wolfEats = calc(RoleType.SURVIVOR, "留まる", RoleType.WEREWOLF_GISHIN, "喰らう");
  assert.deepEqual([wolfEats.winner1, wolfEats.winner2], ["lose", "win"]);

  // 幽霊: 相手が人間で立ち去る → 幽霊の勝利
  const ghostWins = calc(RoleType.GHOST, "留まる", RoleType.SURVIVOR, "立ち去る");
  assert.deepEqual([ghostWins.winner1, ghostWins.winner2], ["win", "lose"]);

  // 幽霊: 相手が人間で留まる → 幽霊の敗北
  const ghostLoses = calc(RoleType.GHOST, "留まる", RoleType.SURVIVOR, "留まる");
  assert.deepEqual([ghostLoses.winner1, ghostLoses.winner2], ["lose", "win"]);

  // 幽霊: 相手が人狼で喰らう → 幽霊の勝利
  const ghostVsWolf = calc(RoleType.GHOST, "留まる", RoleType.WEREWOLF_GISHIN, "喰らう");
  assert.deepEqual([ghostVsWolf.winner1, ghostVsWolf.winner2], ["win", "lose"]);
});
