<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-GATEWAY-INDUSTRIAL banner" width="100%">
</p>

# 🌐 HYDRA-UMC-GATEWAY-INDUSTRIAL

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | <a href="README_ita.md">🇮🇹 Italiano</a> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | 🇯🇵 <b>日本語</b> | <a href="README_por.md">🇵🇹 Português</a></p>

### 🏭 工場標準向けのインダストリー 4.0 相互運用性ブリッジ

<p align="center">
  <img src="https://img.shields.io/badge/Licencia-GPL%203.0--or--later-blue.svg" alt="GPL 3.0 or later">
  <img src="https://img.shields.io/badge/Standard-Industry%204.0-blue.svg" alt="Industry 4.0">
  <img src="https://img.shields.io/badge/Security-TLS%2FmTLS%20%E4%BB%BB%E6%84%8F%E3%83%BB%E6%97%A2%E5%AE%9A%E3%81%A7%E7%84%A1%E5%8A%B9-orange.svg" alt="セキュリティ：TLS と相互 TLS は任意で、既定では無効">
  <img src="https://img.shields.io/badge/Protocols-OPC--UA%20%2F%20MQTT%20%2F%20MTConnect-orange.svg" alt="Protocols">
</p>

---

> **安全性とセキュリティの現状:** このエコシステムは認証された安全システムではありません。ハードウェアの E-STOP 経路、ファームウェアが強制する制限やインターロック、検証済みの動作コマンドはまだありません。ファームウェアイメージは CRC32 と共有鍵の HMAC-SHA256 で検査しており、非対称署名ではありません。TLS と相互 TLS は任意で、既定では無効です。独自基板はまだ実装も試験もされていません。ここに書かれた内容を人の安全のために頼る前に、[セキュリティベースライン](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)と[脅威モデル](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)をお読みください。

## 📋 ひと目で

| | |
|---|---|
| バージョン | `0.1.6` |
| 成熟度 | 機能する |
| 技術 | Node.js / Express / real TCP/HTTP reachability probes |
| 対象 | HYDRA-UMC セルの Raspberry Pi CM5 |
| 実機での確認 | まだです：このバージョンについて実機での動作記録はありません |

## 🚦 プロジェクトの状況

各行はこのリポジトリの一部分で、信号は今日どこまで進んでいるかを示します。計画ではなく、リポジトリが示せるもの（テスト、ビルド、実行）に基づいて書かれています。

🟢 完了・検証済み · 🟡 動作する（既知の制限あり） · 🟠 一部のみ、または未検証 · 🔴 未実装または動作しない

| 領域 | 状態 | ここでの意味 |
|---|---|---|
| ソフトウェア | 🟡 | 主な目的では動作します。足りない点は上の正直さの確認に書かれています |
| テスト | 🟠 | このリポジトリのテスト件数はまだ記録されていません |
| 実機 | 🔴 | まだです：このバージョンについて実機での動作記録はありません |
| ドキュメント | 🟢 | 8 言語の README。変更のたびにマニフェストと照合されます |

## 1. 🛠️ 技術概要

**HYDRA-UMC-GATEWAY-INDUSTRIAL** は、HYDRA-UMC エコシステムと外部の
産業標準との間の通信ブリッジです。マイクロファクトリーがサード
パーティの PLC、SCADA システム、クラウドベースの IIoT プラットフォーム
と相互作用することを可能にします。

現在は、OPC-UA サーバー、MQTT ブローカー、MTConnect アダプターの前に立つ
単一のステータス画面であり、それぞれが稼働して応答するかを確認し、許可リストにある
コマンドを受け付けますが、その唯一の効果は対象に到達できるかの確認です。内部の
ロボット状態をそれらのアドレス空間へ変換することは計画中で、Hydra スウォームが
生産工場で孤立した島にならないようにするためのものです。

### 主な機能：
* 🌐 **マルチスタンダード対応：** 統合された OPC-UA、MQTT、MTConnect インターフェース。
* 🛡️ **産業用セキュリティ：** このゲートウェイ自身の HTTP API 上で動作する実際の TLS 1.2+ - 実際の証明書ファイル（`TLS_CERT_PATH`/`TLS_KEY_PATH`）によるオプトイン方式。`TLS_CLIENT_CA_PATH` を追加すると実際の相互 TLS になり、その CA が署名した証明書を提示できない呼び出し元は TLS ハンドシェイク自体が拒否されます - 詳細は [`docs/API.md`](docs/API.md#security-tls--mutual-tls) を参照。
* 🔬 **より深い確認と任意の制御:** `GATEWAY_PROBE_MODE=protocol` は `GET /status` が TCP 接続を開くだけでなく各プロトコルで話すようにします(OPC UA の Hello が承認され、MQTT の CONNECT に応答があり、MTConnect の `/probe` がデバイス文書である必要があります)。`GATEWAY_STRICT_TARGETS=1` は対象が NodeId またはエージェントのパスであることを確認します。`GATEWAY_REQUIRE_TLS_FOR_AUTH=1` は別のマシンからの平文 HTTP での資格情報を拒否します。`GATEWAY_CERT_ALLOWED_CN` は検証済みクライアント証明書がトークンなしでコマンドを出せるようにします。`GATEWAY_METRICS=1` は `GET /metrics` を提供します。すべての応答にセキュリティヘッダーが付き、停止時に監査ログをきれいに閉じます。ヘッダー以外はすべて既定で無効です。 *(実装済み)*
* 🔄 **状態マッピング：** Hydra 内部の JSON 状態を標準化された産業用アドレス空間へリアルタイムに変換。 *（計画中：現在のゲートウェイは 3 つのサービスの到達性を集約するだけで、データの変換は行いません）*
* ⚡ **高信頼性：** 24 時間 365 日の産業用稼働に最適化された専用の軽量ブリッジ。
* 🚦 **実装済み v0 —— コマンドアローリスト + バックプレッシャー：** `POST /command` は、プロトコルごとのデフォルト拒否アローリスト、上限付きの同時実行制限、実際のタイムアウトによって保護されています——今日実際に強制されている内容の詳細は下記「正直な現状確認」を参照してください。
* 🔐 **コマンドごとの呼び出し元認証：** `POST /command` はオプションの `GATEWAY_JWT_SECRET` にも対応しています——設定すると、すべてのリクエストに有効な `Authorization: Bearer <token>`（HS256、アルゴリズムは明示的に固定）が必要になり、なければアローリストに到達する前に拒否されます。mTLS とは独立しています：これは「誰がコマンドを発行したか」を識別し、mTLS（設定されている場合）は TLS ピアを識別します。
* 🎫 **プロトコルと操作ごとのスコープ：** トークンは `scope` に許可される操作（`mqtt:publish`、`opc-ua:read`、`mtconnect:read`、`<プロトコル>:*`、`*`）を示す必要があります。コマンドのスコープを持たない有効なトークンは 403 で拒否されます。`GATEWAY_REQUIRE_SCOPES=0` は有効なトークンをすべて受け入れ、`GATEWAY_CERT_SCOPES` は一覧にあるクライアント証明書にスコープを与えます。compose ファイルは MQTT ブローカーを TLS のみで公開します（`MQTT_TLS_DIR`）。*(実装済み)*
* 🧱 **本番ポリシーと正直な結果：** ゲートウェイは、どの環境でも（compose は `NODE_ENV=production` を設定します）、本物の `GATEWAY_JWT_SECRET`（32 文字以上、例の値でないもの）がないと起動を拒否します（`GATEWAY_ALLOW_ANONYMOUS=1` は、意図的にオープンなラボ用ゲートウェイであることを示します）。デフォルトの executor は子サービスを疎通確認するだけなので、`accepted` ではなく結果 `probe_only`（何も実行されていない）として `501` を返します。MQTT の `publish` はゲートウェイ自身の名前空間（`hydra/gateway/#`、または `GATEWAY_MQTT_PUBLISH_TOPICS`）にのみ送れ、ブリッジのコマンドトピック（`hydra/bridges/...`）や `$SYS` には決して送れません。`GATEWAY_BIND_HOST` でバインドするインターフェースを選べます。トークンには `exp` と `sub`（`GATEWAY_JWT_AUDIENCE` を設定した場合は `aud` も）が必要で、`GATEWAY_BIND_HOST` で指定しない限り 127.0.0.1 で待ち受けます。*（実装済み）*

**正直な現状確認 —— 今日実際に動くもの：** `POST /command { protocol, operation, target }` は実際に動作します——操作はそのプロトコルのアローリストに明示的に登録されている必要があり（そうでなければ `403`——v0 では読み取り/publish 系の操作のみを許可し、稼働中の PLC の状態を変更しうる操作は許可されていません）、上限を超える数のコマンドが同時に実行されることはなく（超えると `429`）、時間内に完了しなかったコマンドは無期限に保留されるのではなくタイムアウトとして報告されます（`504`）。デフォルトの実行経路は本プロジェクト自身の実際の到達可能性プローブを再利用しています——3 つの子サービスのいずれもまだ実際のコマンド API を公開していないため、実際のプロトコルレベルの書き込みにはまだ至っていないことを正直に示しています。実際に出荷済みの内容は `CHANGELOG.md` を参照してください。

---

## 2. 🔄 ゲートウェイアーキテクチャ

```mermaid
flowchart LR
    INTERNAL["HYDRA-UMC Ecosystem (Internal API)"] --> GATEWAY["HYDRA-GATEWAY-INDUSTRIAL"]
    GATEWAY --> OPC["OPC-UA Server (PLCs)"]
    GATEWAY --> MQTT["MQTT Broker (IIoT / Cloud)"]
    GATEWAY --> MT["MTConnect Adapter (SCADA)"]
    OPC --> EXT["Factory Network"]
    MQTT --> EXT
    MT --> EXT
```

---

## 3. 🧱 アーキテクチャと設計上の決定

* **本プロジェクトが 3 つの子プロジェクトの統合親プロジェクトであり、対等な関係ではない理由。** HYDRA-UMC-OPCUA-SERVER、HYDRA-UMC-MQTT-BROKER、HYDRA-UMC-MTCONNECT-ADAPTER はすべて*同一*の基盤となる HYDRA-UMC-SERVER の状態を 3 つの異なる産業用プロトコルに変換します——共有されるルーティング/認証ロジックの所有権を一か所に集約することで、同一状態に対する 3 つの独立した、互いに一貫しない変換を避けられます。
* **すべてを行う単一のゲートウェイではなく、3 つの独立したプロトコルアダプターである理由。** OPC-UA、MQTT、MTConnect は構造的に異なります（アドレス空間 対 パブリッシュ/サブスクライブトピック 対 XML デバイス/エージェントストリーム）——プロトコルごとに 1 つのプロセスを持つことで、遅延している/壊れている MQTT クライアントが OPC-UA クライアントに影響を与えることは決してなく、それぞれをデプロイごとに独立して有効/無効にできます。
* **エントリポイントが今日は身元/バージョンのみを表示し、ヘルスチェックリスナーが起動した後で終了しない理由。** 足場（アンダミアヘ、スキャフォールディング）段階にあります：このプロセスが起動し稼働し続けることを証明すること（このエコシステムの他の多くの Node スケルトンとは異なり、単に実行して終了するだけではないこと）が、実際のプロトコル変換ロジックに先立ちます。実際のゲートウェイは、その性質上、長時間稼働するサービスだからです。
* **エコシステムの他の部分との関係。** 産業用ゲートウェイ ファミリーの統合親プロジェクトです——HYDRA-UMC-SERVER 自身の状態を、このエコシステム自身の REST/WebSocket API ではなく OPC-UA、MQTT、MTConnect を話す工場フロアのシステム（MES/SCADA/ヒストリアン）に公開します。
* **`GET /health` は独立した高速な生存確認エンドポイントです——`GET /status` はもうこの用途には使われません。** `/status` は本物の詳細診断であり、到達不能な子サービス 1 つにつき正当に ~2 秒かかることがあります。これに直接向けると、HYDRA-UMC-SERVER 自身のエコシステム全体ステータススキャナー（`/api/ecosystem/status`、1 回のプローブに ~800ms しか予算を割かない）は、ゲートウェイ自体のプロセスは健全であっても、子サービスが到達不能なだけでこのゲートウェイを DOWN と報告していました。`/health` は子サービスへのプローブを一切行わず `{ gateway, version, status: "ok" }` を返し、`hydra-umc.project.json` 自身の `service.health_path` も `/status` ではなくここを指しています。
* **`GET /status` はリクエストごとに実際のライブチェックを行います。** `src/probes.ts` は各子サービスに対して OPC-UA/MQTT には実際の TCP 接続を、MTConnect には実際の HTTP `GET` リクエストを行います——各子サービスの `reachable`/`latencyMs`/`error`、および集計された `allReachable` はリクエスト時点で計算され、静的またはキャッシュされたリストから返されるものではありません。エンドツーエンドで検証済み: 3 つの実際の子サービスをすべて起動したところ `/status` は全て到達可能と報告し、その後 1 つを実際に停止させたところ、次の `/status` 呼び出しはその子サービスのみを正しく到達不能と判定し、実際の `ECONNREFUSED` エラーを返しました。各子サービスのホスト/ポート/URL は環境変数で設定可能で、デフォルトは `docker-compose.yml` が既に使用しているサービス名と同じです。
* **`POST /command` のアローリストがデフォルト許可ではなくデフォルト拒否である理由。** 受け取った任意の操作文字列を転送する産業用ゲートウェイは、子サービスが実際の書き込みパスを公開した瞬間にリスクとなります——「明示的にリストされていない限り何も許可しない」から始めることで、危険な操作（OPC-UA ノードの書き込み、MQTT の retained 設定の publish）を追加することは、常に後で意図的にレビュー可能な決定となり、今日の偶発的なデフォルトには決してなりません。
* **`CommandDispatcher.dispatch()` において、認可がバックプレッシャーより先にチェックされる理由。** 認可されていないコマンドは、ゲートウェイが現在どれだけ忙しいかに関わらず、常に同じ方法で拒否されなければなりません——もし容量を先にチェックしていたら、許可されていない操作が、たまたま枠が空いていたために「accepted」としてすり抜けたり、たまたま空いていなかったために「単に忙しいだけ」として読み取られたりすることがあり、本来純粋に認可のみに基づくべき判断を通じてゲートウェイの負荷に関するタイミング情報が漏れてしまいます。
* **デフォルトのコマンド実行器が、常に成功するスタブではなく到達可能性プローブを再利用する理由。** `src/probes.ts` はすでに「この子サービスは実際にそこにあるか」という問いに実際に答えています——それを再利用することで、`POST /command` は停止している子サービスに対して正直に失敗し（`502 downstream_unreachable`）、決して到達しえなかったコマンドに対して `accepted` を報告することがなくなります。

---

## 📂 リポジトリ構成

```text
HYDRA-UMC-GATEWAY-INDUSTRIAL/
├── src/
│   ├── probes.ts        # 各子サービスに対する実際の TCP/HTTP 到達可能性チェック
│   ├── command.ts        # 実際の CommandDispatcher：アローリスト + バックプレッシャー + タイムアウト
│   ├── version.ts        # package.json から読み取る実際のパッケージバージョン(実行時)
│   ├── server.ts         # Express アプリ：GET /status、POST /command
│   ├── audit.ts          # すべての POST /command の不変な監査証跡 (誰が何を要求し、何が起きたか)
│   ├── auth.ts           # 各コマンドの呼び出し元の認証
│   ├── rateLimit.ts      # POST /command のレート制限
│   ├── targets.ts        # コマンドの対象がプロトコルごとに備えるべき形式 (OPC UA NodeId、MTConnect パス、MQTT トピック)
│   ├── tls.ts            # TLS と相互 TLS の設定
│   └── metrics.ts        # Prometheus メトリクス (GET /metrics は GATEWAY_METRICS=1 のときだけ存在)
├── tests/               # 実際の vitest スイート（probes、プロトコルプローブ、server、command、認証、監査、レート制限、TLS、オプション）
├── docs/               # ドキュメントとマッピングリファレンス
├── dist/               # コンパイル出力（npm run build）
├── images/             # メディアと図表
├── scripts/            # ユーティリティスクリプト（bump-version.mjs）
├── tools/
│   ├── build_test.py    # バージョンを増やさないビルドチェック
│   ├── ci_validate.py   # CI が使用するマニフェスト/CHANGELOG/ドキュメント検証
│   ├── verify_compose.py # docker-compose.yml と Dockerfile の静的検査 (Docker 不要)
│   ├── _doc_policy.py   # ファミリー共通のドキュメント規則 (HYDRA-UMC-SDK のコピーで、同期を維持)
│   ├── _readme_parity.py # 8つの README が同じ構造であることの検査 (HYDRA-UMC-SDK のコピーで、同期を維持)
│   └── hydra_project_tool.py # すべてのリポジトリで共通のコマンド: validate、test、ci、version、status、bump
├── bump_manifest_version.py # hydra-umc.project.json のバージョンを package.json と同期(--sync)
├── .env.example         # 環境変数テンプレート
├── build.sh/.bat        # バージョンを増加させ、その後 npm run build を実行
├── build-test.sh/.bat   # バージョンを増やさないビルドチェック
├── dev.sh/.bat           # ビルドステップなしでソースから直接サーバーを実行
├── Dockerfile           # 本サービス自身のコンテナイメージ
├── docker-compose.yml   # 本ゲートウェイとその 3 つの子プロジェクトを一緒に起動
└── README.md
```

純粋なネットワークサービスであり、独自の専用ハードウェアを持ちません
——`hardware/`、`firmware/`、`os/` は元のプロジェクトテンプレートから
省略されており、リポジトリ構造ポリシーに従っています。

---

## 🐳 3 つの子ブリッジの統合

これは単なるドキュメントではなく、実際の統合リポジトリです——
`docker-compose.yml` は、4 つのリポジトリが兄弟フォルダとしてチェック
アウトされていること（このエコシステムの GitHub 組織が既に使用している
レイアウト）を前提として、本ゲートウェイをその 3 つの子プロジェクト
（**HYDRA-UMC-OPCUA-SERVER**、**HYDRA-UMC-MQTT-BROKER**、
**HYDRA-UMC-MTCONNECT-ADAPTER**）とともに 1 つの Docker ネットワーク
として起動します：

compose には `GATEWAY_JWT_SECRET`、`MQTT_AUTH_JSON`、`MQTT_ACL_JSON` を含む `.env` が必要です（`.env.example` 参照）。本番のゲートウェイとブローカーは、オープンな状態では起動しません。

```bash
docker compose up --build
```

これにより、各サービスが単独でそれぞれ既にバインドしているのと同じ
ポートで、4 つのサービスすべてが起動します：本ゲートウェイは `8000`、
OPC-UA は `4840`、MQTT は `1883`、MTConnect は `5000` です。
`GET http://localhost:8000/status` は、本ゲートウェイ自身のバージョン
と、それが到達を期待している子プロジェクトを報告します。

---

## 🛠️ 開発環境

### 必要条件
- [Node.js](https://nodejs.org/)（v20 以上を推奨）
- npm

### インストール
```bash
npm install
```

### 開発モード
`tsx` を使用して集約サーバーを直接実行します（バンドラーなし）：
- **Windows：** `dev.bat` をダブルクリックするか、`npm run dev` を実行
- **Linux/Mac：** `./dev.sh` または `npm run dev` を実行

### プロダクションビルド
esbuild を使用してサーバーを単一のデプロイ可能なファイルにバンドル
します：
- **Windows：** `build.bat` をダブルクリックするか、`npm run build` を実行
- **Linux/Mac：** `./build.sh` または `npm run build` を実行

その後、次のコマンドで起動します：
```bash
npm start
```

サーバーは `0.0.0.0:8000` でリッスンします——`GET /health` は子サービスへ
のプローブを行わない高速な生存確認です（`hydra-umc.project.json` 自身の
`service.health_path` はここを指します）。一方 `GET /status` は本物の詳細
診断で、本ゲートウェイ自身のバージョンと、それがフロントに立っている各子
ブリッジの名前/プロトコル/エンドポイント/到達可能性を報告します。

実際の例 —— 稼働していない子サービスに対するアローリスト内のコマンド、
認可されていない操作、および不正な形式のリクエスト：

```bash
curl -X POST http://localhost:8000/command -H "Content-Type: application/json" \
  -d '{"protocol":"OPC-UA","operation":"read","target":"ns=2;s=Line1.Status"}'
# 502 {"status":"downstream_unreachable","reason":"TCP connect to opcua-server:4840 timed out after 2000ms"}

curl -X POST http://localhost:8000/command -H "Content-Type: application/json" \
  -d '{"protocol":"OPC-UA","operation":"write","target":"ns=2;s=Line1.SetPoint"}'
# 403 {"status":"rejected_unauthorized","reason":"operation \"write\" is not allowlisted for OPC-UA"}

curl -X POST http://localhost:8000/command -H "Content-Type: application/json" -d '{"protocol":"OPC-UA"}'
# 400 {"error":"protocol, operation and target are required strings"}
```

### バージョン管理
`npm run build` はサーバーをバンドルするだけでバージョンを変更せず、`python tools/hydra_project_tool.py bump` が（`bump_manifest_version.py` 経由で）上げます——10 進法の「オドメーター」方式：bump のたびに patch を +1 し、9 を超えると minor に繰り上がり（minor が 9 を
超えると major に繰り上がる）、2 桁のセグメントに到達することはあり
ません（`0.0.9` -> `0.1.0`、`0.0.10` にはなりません）。

---

## 🚀 ロードマップ
* **フェーズ 1：** 高速データ交換とレガシープロトコルブリッジングのための OPC-UA パブリッシュ/サブスクライブ実装。
* **フェーズ 2：** 大量の IoT デバイス管理と高い並行性のための MQTT Broker クラスター。
* **フェーズ 3：** マルチベンダーの CNC および PLC 機械統合のための MTConnect アダプターサポート。
* **フェーズ 4：** 産業用ゲートウェイ の完全な ISO-27001 サイバーセキュリティ準拠と Profinet ソフトウェアアダプターサポート。

---

## 🔗 関連プロジェクト

本プロジェクトは、同じ作者(JuanenRac / Electro Hobby 3D)による HYDRA-UMC ロボティクスエコシステムの一部です。リクエストが実はこの中のどれかについてのものである可能性があるため、知っておく価値があります。

**子プロジェクト** —— いずれも、本ゲートウェイが中継する先のプロトコルアダプターです
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** — 実際のバイナリプロトコルクライアントセッションで検証された、実際の OPC-UA アドレス空間。
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — クライアント単位のオプション認証とトピック ACL を備えた、実際の MQTT ブローカー。
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — 縮退モード出力を備えた、実際の MTConnect `/probe` および `/current` XML エンドポイント。

**直接関連**
- **[HYDRA-UMC-SERVER](https://github.com/JuanenRac/HYDRA-UMC-SERVER)** — すべての制御クライアントが実際に通信する、本物のヘッドレスバックエンド(REST/WebSocket)。本ゲートウェイが公開する状態の出所。

**エコシステムの他のプロジェクト**

*コアハードウェア&プラットフォーム*
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — ロボットアームのマザーボードの設計——CM5 ホスト + デュアルコア STM32H745、CAN-OTA/SPI-OTA 経由で最大 8 本のツールアームを統括することを目指す(ファームウェアは初期段階で、実装済みの基板はまだない)。
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — CM5 向けの再現可能な Raspberry Pi OS プロダクト層——読み取り専用エージェント、検証済み設定/プロファイル、WiFi 初回接続プロビジョニング。
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — すべてのブリッジが自身のコマンドを検証する共有 JSON-Schema 契約とソフトウェアのジョブゲート境界(認証済みの安全機能ではない)。
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — 外部マシン用コネクタのための宣言的アダプターマニフェストのレジストリとバリデーター。SDK 自身の契約という発想を外部マシンにまで拡張し、産業用ゲートウェイ系のプロジェクトを置き換えることはありません。

*コアバックエンド&クライアント*
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — リアルタイムのマルチロボット 3D 可視化を備えたウェブ制御ダッシュボード。
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — 複数サーバーを同時に扱えるデスクトップ（PySide6）群制御コマンドセンター。
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — 生体認証ログインとペアリングされた Wear OS コンパニオンを備えたネイティブ Android 制御アプリ。
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — リアルタイム WebSocket 同期を備えた iOS/iPadOS 制御アプリ(Flutter)。
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — 本体搭載の 7 インチ DSI タッチスクリーン向けネイティブタッチ UI、CM5 自体に組み込み。
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — 完成したモデルを STUDIO 自身のカタログへ送信するデスクトップ用グラフィカル URDF 作成/編集ツール。
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — HYDRA-UMC-EDITOR-URDF も編集する同じモデルカタログ内で、実在するパーツを変換/置換/削除/追加するデスクトップ STL モデルエディタ。
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — VDA 5050 MQTT パブリッシャーによる AGV/AMR フリートの調整境界(エミュレートしたフリートに対してのみテスト済み)。
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — GRBL ステータス/制御バイトへのアクセスを持つ、CNC セルの高レベルコーディネーター(エミュレーターに対してのみテスト済み)。
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — Boston Dynamics Spot コマンド送信機能を持つ、脚型/ヒューマノイドドロイドの調整境界(エミュレーターに対してのみテスト済み)。
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — キー/筐体/インターロックの GPIO 信号 3 系統を読み取るレーザーセルのコーディネーター(模擬チップに対してのみテスト済み。レーザーの武装や発射はできない)。
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — OpenPnP ピックアンドプレースの基板フローを安全に統括する高レベルコーディネーター。
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — 実際にゲート制御されたジョブコマンドを持つ、Moonraker/Klipper 3D プリンター向けの安全な調整境界。
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — 遅延インポートの rclpy ROS 2 トランスポートを持つコーディネーター(ROS 2 環境ではまだ実行していない)。
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — MAVLink コマンド送信機能を持つ、カメラ搭載 UAV の調整境界(エミュレーターに対してのみテスト済み)。

*URTC ツールプラットフォーム*
- **[URTC](https://github.com/JuanenRac/URTC)** — 物理的な Universal Robot Tool Controller 基板向けファームウェア、CAN バス経由の 25 以上のツールプロファイル。
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — URTC 基板用のデスクトップ GUI 書き込みツール、CAN-OTA およびフルチップ SWD/JTAG。
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — URTC 基板向けのデスクトップ CAN バスライブ診断ツール、ツールプロファイルごとに 1 パネル。
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — Web Serial API を使ったブラウザベースの URTC-TESTER の代替、ローカルインストール不要。
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** — URTC の CAN バスの前に置くゲートウェイ：許可する識別子のリスト、レート制限、セッション鍵。コンピューター上でテスト済みで、実際のバスではまだ試していません。

*ビジョン AI ノード(Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — Hailo-8 ビジョンパイプラインの統合ハブ、段階ごとの実際のハードウェア準備状況チェック付き。
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — Hailo アーキテクチャ/チェックサムによる安全読み込み検証を備えた、実際のコンパイル済みモデルレジストリ。
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — 実際の HailoRT 統合境界を持つ、実際の GStreamer パイプライン + MediaMTX 設定生成器。
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — ゾーン状態を条件に承認する Position-Based Visual Servoing 補正則。カメラによる姿勢推定はまだない。
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — ファイルから物体位置を受け取る、ゾーン侵入・キャリブレーション鮮度・E-STOP 要求の v0 ロジック。検出器は接続されておらず、物理 E-STOP もまだ配線されていない。

*コグニティブ AI ノード(Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — Hailo-10 コグニティブパイプライン(LLM/VLA/音声オーケストレーション)の統合ハブ。
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — Vision-Language-Action モデル向けの、実際のアクショントークンのエンコード/デコードと軌道生成。
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — 確認ゲート付きの限定的な Watch リレーを備えた、実際の音声フロントエンド(VAD + 意図解析)。
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — MCU エラーコードに対する、実際のルールベースのタスク分解と意味的エラー復旧。
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — このエコシステム自身の Markdown ドキュメントに対する、標準ライブラリのみの実際の TF-IDF 文書検索。
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — エコシステム自身のための、ローカルでポリシーゲート付きのAIメンテナンス技術者 — 観察、診断し、修正を提案する;最上位の2つのリスクレベルは意図的にまだ実装されていない。

*オーケストレーション&スウォーム*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — 実際の gRPC/Protobuf ヘルスレポート契約とミッションステートマシンを持つ統合ハブ。
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — 実際の HTTP API 上に構築された、優先度ベースの実際のジョブキュー(重複排除付き)。
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — リトライ/バックオフとアイデンティティ不一致検出を備えた、実際の gRPC ベースのフリートヘルスウォッチドッグ。
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — 実際の障害物/ワークスペース衝突検証を備えた、実際の RRT ベースの 3D 経路プランナー。
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — 複数セルの収束についてプロパティテストされた、実際の CRDT LWW-Element-Map 状態同期。

*デジタルツイン&シミュレーション*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — 実際のバージョン互換性同期契約を持つ、デジタルツインエンジンの統合ハブ。
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — シミュレーションと実機の間にソフトウェアの衝突インターロックを備えたハードウェア・イン・ザ・ループのルーター(実機なしでテスト済み)。
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — 実際の URDF サブセットに対する、実際の順運動学と関節限界検証。
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — YOLO/COCO アノテーションのエクスポート機能を持つ、実際のプロシージャル 2D シーンジェネレーター。

*データ&分析*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — 実際の取り込み/クエリ HTTP API を備えた、実際の sqlite3 ベースの時系列ストア。
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — ドリフト監視を備えた、実際の FFT + 統計ベースラインによる異常検知器。
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — DATALAKE の履歴に対する実際の OEE/稼働率計算、再現可能な CSV エクスポート付き。
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — シーケンス重複排除機能を備えた、DATALAKE への実際の CAN/WebSocket 取り込みパイプライン。

*補完ツール&エコシステム運用*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — 誠実な統計フォールバックを備えた、DATALAKE/ANOMALY-DETECTOR 上のスマートサマリーと異常ハイライトパネル。
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — 実際の安定した終了コード契約を持つフリート CLI、HYDRA-UMC-SERVER 自身の API の本物のライブクライアント。
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — 触覚アラートのパターンとペアリング済みスマートフォンへの音声リレーを備えた WearOS コンパニオンアプリ(物理的なウォッチではまだ実行していない)。
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — 実際の工具 ID デコードと Smart Idle 予熱ロジックを備えた、基板搭載ラック用ファームウェア。
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — サーマル/RGB 検査ツールヘッド向けの、ファームウェアと実際の Python ビジョンコンパニオン。
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — このエコシステム内のすべてのリポジトリを検出・クローン・更新する、管理用デスクトップツール。
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — エコシステムの最新バージョンをプリロードした、書き込み可能なCM5イメージを構築するWindows/Linuxデスクトップツール。Raspberry Pi Imager方式の初回起動Wi-Fi/ユーザー/SSH設定を備える。
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — 保守インシデントコーディネーター: 低権限のエッジ役割がサニタイズされたインベントリ/ヘルスのスナップショットを収集し、コントロールプレーン役割がそれを読み取り専用でレンダリングして AI プロバイダーに診断の提案を依頼します - パッチを適用することも、何かをデプロイすることも決してありません。
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — 再現可能な開発ホスト（Raspberry Pi 5 / CM5）。エコシステムのソースコードを保管し、永続キューのもとで境界の明確なビルド/テストタスクを実行する。運用中の CM5 とは明確に異なる、開発専用の役割。


---

## 📚 ドキュメント & コミュニティ

- **[docs/API.md](docs/API.md)** —— 実際の HTTP API リファレンス: 高速な生存確認 `GET /health`、`GET /status` レスポンスの各フィールド、`POST /command` の `403`/`429`/`504`/`502` の境界、および各設定用環境変数を、`src/server.ts`/`src/probes.ts` から直接まとめたもの。
- **[CONTRIBUTING.md](CONTRIBUTING.md)** —— プルリクエストのための技術スタックとコーディング指針。
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** —— このコミュニティで期待される行動規範。
- **[SECURITY.md](SECURITY.md)** —— 脆弱性の報告方法と、このプロジェクトの実際のセキュリティ重点領域。
- **[SUPPORT.md](SUPPORT.md)** —— 質問の投稿先とバグの報告先。
- **[LICENSE.md](LICENSE.md)** —— このプロジェクト自身のライセンス。

## 👤 作者
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 ライセンス
GPL-3.0-or-later —— 詳細は LICENSE を参照してください。
