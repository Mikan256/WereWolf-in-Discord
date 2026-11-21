# AGENTS.md

このリポジトリで作業するAIエージェント / 開発者向けのガイドです。

## プロジェクト概要

Discord上で人狼ゲームを遊ぶためのBot。以下の3モードを実装しています。

| モード | `GameMode` | 概要 |
| --- | --- | --- |
| 通常人狼 | `classic` | 複数日・昼夜・投票・夜アクションを行う長期戦 |
| ワンナイト人狼 | `oneten` | 1回の夜と投票で勝敗が決まる短期戦 |
| ギシンアンキ | `gishinanki` | 2人専用。情報収集と決断で勝敗が決まる |

- 言語: TypeScript (CommonJS / ES2020)
- 実行環境: Node.js 20+
- ライブラリ: `discord.js` v14、`dotenv`、`@aws-sdk/client-s3`
- 永続化: S3互換ストレージ（未設定時はメモリのみ）
- テスト: Node.js 標準の `node:test` + `assert/strict`
- CI: GitHub Actions (`.github/workflows/ci.yml`)

## よく使うコマンド

```bash
npm ci              # 依存関係のインストール
npm run typecheck   # 型チェックのみ (tsc --noEmit)
npm run build       # dist/ へビルド
npm test            # テストをビルドして実行
npm run dev         # ts-node で起動
npm start           # dist/index.js で起動
npm run deploy-commands  # スラッシュコマンド登録
```

### テスト

- テストは `test/*.test.ts` に配置する。
- `npm test` は `tsconfig.test.json` で `src/` と `test/` を `dist-test/` にコンパイルし、`node --test dist-test/test/*.test.js` を実行する。
- Discord API には接続しない。`test/helpers.ts` の `FakePersistence` と偽の `Client` を使う。
- ゲームロジックの private メソッドを検証する場合は、テスト内で `(manager as any).method(...)` を利用してよい。
- 新しい役職・ゲームモード・勝敗判定を追加したら、対応するテストも追加する。
- `dist-test/` は生成物なのでコミットしない。

## ディレクトリ構成

```text
src/
  index.ts                # Bot起動、Interaction / VoiceState イベント処理
  deploy-commands.ts      # スラッシュコマンド登録
  commands/
    setting.ts            # /setting（引数モード + 対話パネル）
    settingStatus.ts      # /setting-status
    start.ts              # /start
    stop.ts               # /stop
    skip.ts               # /skip
    end.ts                # /end
    help.ts               # /help
  game/
    types.ts              # 列挙型・インターフェース・役職定義
    roles.ts              # 陣営判定・占い結果・役職配布・シャッフル
    GameManager.ts        # ゲーム進行の本体（チャンネル、投票、夜アクション等）
  utils/
    env.ts                # 環境変数
    persistence.ts        # S3への設定永続化
test/
  helpers.ts              # テスト用のゲーム状態・偽Client/Persistence
  roles.test.ts
  game-manager.test.ts
  night-actions.test.ts
```

## アーキテクチャと重要な仕様

### 状態管理

- `GameManager` がギルドIDごとに `GameState` を `Map` で保持する。
- `GameState` はプレイヤー、役職、フェーズ、投票、夜アクション、タイマー、モード固有の状態を持つ。
- 永続化されるのは設定（ホスト、参加者、役職構成、会議時間、匿名投票、ゲームモード）のみ。試合中の状態は保存しない。
- メモリ上にゲームがない場合は、`ensureGame()` が永続化設定から復元する。

### フェーズ

- 通常人狼: `WAITING` → `DAY_DISCUSSION` → (`DAY_VOTING`) → `NIGHT` → ...
- ワンナイト: `WAITING` → `NIGHT` → `DAY_DISCUSSION` → `DAY_VOTING` → `FINISHED`
- ギシンアンキ: `WAITING` → `GISHIN_INFORMATION` → `GISHIN_DECISION` → `FINISHED`

### Discord操作の注意点

- コンポーネント操作は3秒以内に応答する必要がある。長い処理の前には `deferReply` / `deferUpdate` を呼ぶ。
- ゲーム中のタイマー（`meetingTimer`, `nightActionTimeout`）は `cleanupGame()` で必ず破棄する。
- `/stop` などでゲームが削除された後も、非同期処理が残っている場合がある。各フェーズの先頭で `this.games.get(game.guildId) !== game` を確認するパターンを維持する。
- メッセージは日本語。エフェメラル返信は `flags: 64` (`EPHEMERAL`) を使う。

### 権限・チャンネル

- 通常人狼: カテゴリ + ゲーム用テキスト / 観戦用テキスト / ゲーム用ボイス / 人狼用テキストを作成する。
- ワンナイト / ギシンアンキ: ゲーム用テキストチャンネルを1つだけ作成する。
- 観戦者は待機VCから参加し、観戦用テキストチャンネルの閲覧権限を得る。
- 死亡者はゲーム用テキストで発言できず、観戦用テキストを閲覧できる。
- 夜はゲーム用VCをサーバーミュートし、昼は解除する。チャンネル権限で `Speak` を拒否しないこと。

## コーディング規約

- 既存のスタイル（2スペース、ダブルクォート、セミコロンあり）に合わせる。
- 日本語のUI文言を維持する。
- 型は `strict` を前提とする。`any` は Discord.js のイベントオブジェクトやテストで必要な場合のみ。
- 新しい役職を追加する場合は以下を更新する:
  1. `RoleType` と `Team` (`src/game/types.ts`)
  2. `ROLE_DEFINITIONS` / モード別定義
  3. `getRoleName` / `getRoleDescription` / `getTeam` (`src/game/roles.ts`)
  4. `/setting` の役職選択肢 (`src/commands/setting.ts`)
  5. 夜アクションや勝敗判定 (`src/game/GameManager.ts`)
  6. `/help` とテスト
- 役職構成のバリデーションは `GameManager.setSetting()` と `startGame()` の両方に注意する。

## 環境変数

`.env.example` を参照。

- `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`
- `KOYEB_S3_*`: 設定永続化用。未設定でも起動可能（メモリのみ）。

`.env` や認証情報は絶対にコミットしない。

## CI

GitHub Actions で以下を実行する。

- Node.js 20 / 22 のマトリクス
- `npm ci`
- `npm run typecheck`
- `npm run build`
- `npm test`
- `docker build`

ローカルでCIと同じ確認をする場合:

```bash
npm ci && npm run typecheck && npm run build && npm test
docker build -t werewolf-in-discord:local .
```

## 既知の仕様差異

- ワンナイト人狼の同票時、READMEには「誰も追放されない」と記載があるが、実装は決選投票を行う。ゲームルールとしてどちらに合わせるかは未決定。変更する場合は `processOneNightResults` / `runOneNightRunoff` とテストを更新すること。
