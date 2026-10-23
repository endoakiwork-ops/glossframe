# スマホでの導入・運用（公開前の検証用）

ローカル実装を検証中です。公式画面・iPhone Safari・Android Chromeでの通し検証を進めるための検証用ブランチです。

[自分用のGlossFrameを作る](https://deploy.workers.cloudflare.com/?url=https://github.com/edoaki/glossframe/tree/mobile-setup-preview)

## 導入

1. ボタンからCloudflare公式画面へ進みます。CloudflareとGitHubのアカウントを用意し、ログイン・メール認証・連携許可を行います。
2. 保存先のGitHubアカウントとCloudflareアカウントを確認します。名前が重複する場合は新しい名前を選びます。
3. `INITIAL_OWNER_PASSWORD` に、このアプリだけの8〜200文字のパスワードを入力してパスワード管理アプリへ保存します。共通の初期値はありません。GitHubやCloudflareのログインパスワードを使い回さないでください。
4. ビルドは `npm run build`、デプロイは `npm run deploy` が既定です。D1・KV・Workers AIが表示されていることを確認して開始します。アカウント全体の使用量取得トークンは不要です。
5. 完了後のHTTPS URLを開き、手順3のパスワードでログインします。初回だけ所有者が登録され、以後はDBに保存されたパスワードで認証します。
6. OCRの準備を待ち、自分で撮影した画像の翻訳・単語保存・ログアウト・再ログインを試します。

公開時には実際の画面の名称を確認し、手順1〜5のスクショを共通説明サイトへ追加します。説明サイトは外部画面の進み具合を読み取らず、利用者自身が「次へ」を押します。保存する進捗は手順番号だけにし、パスワード、復旧キー、トークン、個人URLは保存しません。

## パスワードを忘れた場合

1. スマホでCloudflareにログインし、自分のWorkerの Settings → Variables and Secrets を開きます。
2. 型をSecretにし、名前を `OWNER_RECOVERY_TOKEN`、値をパスワード管理アプリで生成した新しい32〜200文字のランダムなキーにして、Deployします。初期パスワードの変更では復旧できません。
3. アプリのログイン画面で「パスワードを忘れた場合」を開き、同じ復旧キーと新しい8〜200文字のパスワードを入力します。
4. 新しいパスワードでログインします。学習データは保持され、既存の全セッションは失効します。
5. Cloudflareから `OWNER_RECOVERY_TOKEN` を削除してDeployします。削除前でも使用済みキーの再利用は拒否されます。次の復旧には必ず別のキーを作ります。

Cloudflare管理アカウント自体にログインできない場合は、Cloudflare側でアカウントを復旧してください。復旧キーは説明サイト・GitHub・スクショに記録しないでください。

## 更新

元リポジトリの更新はコピーへ自動配信されません。公式ボタンのコピーはforkとは限らないため、Sync forkを前提にしません。

1. アプリの設定からバックアップJSONをスマホへ保存します。画像ファイルはこのJSONに含まれません。必要な元画像も別途保管します。
2. 自分のGitHubリポジトリの Actions → Prepare app update → Run workflow を開きます。公開されたバージョンのタグ名・SHAを指定します（今回の検証では `mobile-setup-preview` を指定してください。`main` はB未対応です）。
3. 実行結果のリンクからPull Requestを作成し、変更内容とCheckの成功を確認してMergeします。アプリのコードを公式版へ揃えるため、独自のコード変更は上書きされます。Wrangler設定、Secrets、DBは更新ブランチの作成では変更しません。
4. CloudflareのBuildsで再デプロイの成功を確認します。自動ビルドを無効にしている場合は同じコミットのビルドを手動実行します。
5. ログイン、OCR、翻訳、単語帳を確認します。

GitHubでActionsが無効なら有効化が必要です。組織のポリシーで書き込みを禁止している場合、この更新方法は利用できません。設定・ワークフロー自体の変更が必要なリリースは、別途そのリリースの移行案内に従ってください。手動更新の公式UI操作は実機未検証です。

## 失敗・バックアップ・削除

- ビルド失敗：Buildsのログを確認して再実行します。OCRモデル取得時の通信障害やビルド枠超過もあり得ます。成功するまで以前のデプロイを利用します。
- 更新後の不具合：CloudflareのDeploymentsから前のバージョンに戻します。WorkerのロールバックではD1マイグレーションを戻せません。DB変更との互換性をリリース案内で確認してください。
- 保存データ：アプリのバックアップは学習データ用です。DB全体の復旧はCloudflare D1のTime Travel等を使います。DBを過去へ戻すとパスワードや使用済み復旧キーも巻き戻るため、古いSecretを残さず、新しい復旧キーで再設定してください。owner行を削除して初期化しないでください。
- 削除：必要なバックアップを保存し、WorkerのBindingsに表示された自分のD1・KV名を控えます。Workerと不要なD1・KVをそれぞれ削除し、GitHubのコピーも不要なら削除します。共有しているリソースは削除しないでください。Workerを消すだけで保存先も消えるとは限りません。

## 無料枠

2026-10-23に公式資料を確認しました。無制限に無料ではありません。Workers AIは日10,000 Neuronsの無料枠があり、Freeでは超過すると処理が失敗します。既定のQwen3 30BとGLM 4.7 Flashは現時点の有料支払方法必須モデル一覧に含まれていません。実アカウントでの利用可否と速度は未検証です。[Workers AI料金](https://developers.cloudflare.com/workers-ai/platform/pricing/)

ビルド時間、Workerリクエスト・CPU、D1の読み書き・容量、KVの読み書き・容量にもそれぞれ制限があります。画像保存はKVの容量を使い、OCRモデル取得には通信が必要です。AIの無料枠エラーと接続障害は別のエラーとして表示します。[Workers制限](https://developers.cloudflare.com/workers/platform/limits/)、[Buildsの枠](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)、[D1制限](https://developers.cloudflare.com/d1/platform/limits/)、[KV制限](https://developers.cloudflare.com/kv/platform/limits/)

## A担当への引き渡しと実機検証

共通サイト `glossframe-guide` のB用原稿はこの文書、ボタンURLは冒頭のリンクです。GitHub Pagesの構築・公開はAで扱います。実機で成立する前のスクショは作りません。

両OSで、アカウント作成・連携許可・名前衝突・Secret入力・デプロイ待ち・URL取得・再ログイン・復旧・更新を記録してください。D1/KV/AIが利用者のアカウントに作成され、コピーの設定に利用者のIDが書き込まれること、初回マイグレーションが成功することを確認します。画面・スクショからアカウント情報やSecretを除きます。
