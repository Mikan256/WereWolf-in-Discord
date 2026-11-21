import { GameManager } from "../src/game/GameManager";
import { getTeam } from "../src/game/roles";
import {
  GameMode,
  GamePhase,
  GameSettings,
  GameState,
  RoleType,
} from "../src/game/types";
import { PersistedSettings } from "../src/utils/persistence";

/** テスト用のS3代替。ネットワークに触れずメモリ上で設定を保持する。 */
export class FakePersistence {
  readonly data = new Map<string, PersistedSettings>();

  constructor(initial: Record<string, PersistedSettings> = {}) {
    for (const [guildId, settings] of Object.entries(initial)) {
      this.data.set(guildId, settings);
    }
  }

  getSettings(guildId: string): PersistedSettings | undefined {
    return this.data.get(guildId);
  }

  async setSettings(guildId: string, settings: PersistedSettings): Promise<void> {
    this.data.set(guildId, settings);
  }

  async deleteSettings(guildId: string): Promise<void> {
    this.data.delete(guildId);
  }
}

export function createManager(initial?: Record<string, PersistedSettings>) {
  const persistence = new FakePersistence(initial);
  const client = { guilds: { cache: new Map() } };
  const manager = new GameManager(client as any, persistence as any);
  return { manager, persistence };
}

export function makeSettings(overrides: Partial<GameSettings> = {}): GameSettings {
  return {
    gameMode: GameMode.CLASSIC,
    meetingTimeMinutes: 3,
    roleDistribution: {},
    anonymousVoting: true,
    ...overrides,
  };
}

export function makeGameState(overrides: Partial<GameState> = {}): GameState {
  return {
    guildId: "guild-1",
    hostUserId: "host",
    phase: GamePhase.WAITING,
    settings: makeSettings(),
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
    centerRoles: [],
    nightActionStep: 0,
    originalRoles: new Map(),
    gishinDeck: [],
    gishinHands: new Map(),
    gishinActionTokens: new Map(),
    gishinDecisions: new Map(),
    gishinReady: [],
    gishinRequestPending: null,
    gishinExchanges: false,
    ...overrides,
  };
}

export function addPlayer(
  game: GameState,
  userId: string,
  role: RoleType,
  options: { isAlive?: boolean } = {},
): void {
  game.players.set(userId, {
    userId,
    role,
    team: getTeam(role),
    isAlive: options.isAlive ?? true,
    isProtected: false,
  });
}
