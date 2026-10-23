# 個人用Cloudflare環境

実際の設定はGit対象外のwrangler.jsoncに置きます。既存環境ではファイルを上書きせず、そのまま使ってください。

新しい環境だけ、wrangler.example.jsoncをコピーし、既存または作成したD1／KVのリソースIDを手元で設定します。例のゼロ埋めIDではデプロイできません。アカウントID、APIトークン、パスワードを公開ファイルに書かないでください。Wranglerの認証情報はリポジトリの外で管理されます。

```sh
npm ci
npx wrangler login
npm test
npm run build
npm run db:migrate
```

所有者未登録の場合のみ、次を対話端末で実行します。パスワードは非表示で入力し、ハッシュをDBへ保存します。既存所有者は上書きしません。

```sh
node scripts/bootstrap-owner.mjs --remote
```

本番ではOWNER_SETUP_DISABLED=trueを維持します。ブラウザで不特定の訪問者が所有者登録できるようにはしません。SESSION_DAYSは既定で30です。

```sh
npm run deploy
```

deployはビルド、本番マイグレーション、Workerの反映を行います。既存DBのバックアップと未適用マイグレーションを確認してから実行します。出力されたHTTPS URLを使い、パスワードログイン、OCR準備、撮影、段階翻訳、履歴まで確認してください。

パスワードを忘れた場合は、Cloudflare管理権限を持つ端末で次を実行します。既存の学習データは保持し、セッションを失効させます。

```sh
npm run password:reset
```

任意のアカウント全体の使用量取得にはCF_ACCOUNT_IDとCF_ANALYTICS_TOKENをWorkerの秘密として設定できます。設定しなくてもアプリ内の使用量表示を利用できます。トークンはGitやvarsへ保存せず、Wranglerのsecret管理を使います。

画像保存を有効にすると画像もKVへ送信します。OCR自体は端末内で実行し、翻訳AIには認識テキストと領域情報を送ります。

ソースをGitHubへpushすることとデプロイは別です。外部のWorkers Buildsなどを接続している場合は自動反映の設定を確認してください。公開Gitには本番リソースIDを含めません。
