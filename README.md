# GlossFrame

スマホのブラウザで画像から英語を読み取り、日本語訳・文法解説・単語学習を表示する個人用Webアプリです。

- OCR：ブラウザ内のPaddleOCR。初回約24 MBのモデル／実行エンジンを取得し、キャッシュを再利用します。
- 翻訳：Cloudflare Workers AI。原文→速報訳→補正済み訳の順に同じ領域へ表示します。
- 保存：Cloudflare D1／KV。所有者パスワードでAPIを保護します。
- PWA：ホーム画面への追加は任意です。Cloudflare AIを使う処理には通信が必要です。

## 開発

Node.js 22以上を使用します。

```sh
npm ci
cp wrangler.local.example.jsonc wrangler.local.jsonc
npm run dev:local:offline
```

http://127.0.0.1:5173 を開き、ローカル専用パスワードで初期設定します。オフラインモードでも、モデル未取得なら最初のダウンロードに通信が必要です。AIは無効なので翻訳はエラーになります。

実Workers AIを使う場合はWranglerでログインし、`npm run dev:local` を実行します。D1／KVはローカル、AIだけリモートです。

```sh
npm test
npm run build
npm run check:public
```

`npm run test:smoke` は自作の画像と独立したローカルDBで、実ブラウザのOCR・認証・キャッシュ・翻訳・履歴を確認します。実AIを使う場合は `npm run test:smoke -- --ai`。詳しくは [開発と検証](docs/DEVELOPMENT.md) を参照してください。

## ディレクトリ

| 場所 | 内容 |
|---|---|
| src/client | React画面、カメラ、端末内OCR |
| src/shared | 型、OCR配置、学習・翻訳ロジック |
| src/worker | 認証、Cloudflare API、AI処理 |
| migrations | D1の追加マイグレーション |
| public | アイコン、第三者ライセンス、生成されたモデル |
| scripts | 開発・モデル準備・所有者管理・検証 |
| tests | 自作データによる回帰テスト |
| docs | 開発・運用・公開範囲の説明 |

実際のデプロイ設定、秘密情報、個人の画像、検証記録はGitに含めません。モデルバイナリもビルド前に取得します。私用の旧資料がある環境では `.private/` に保管し、公開ソースから切り離します。

## 運用・ライセンス

- [デプロイと所有者認証](docs/DEPLOYMENT.md)
- [公開前の確認と私用データ](docs/PUBLICATION.md)
- アプリのコードは [MIT](LICENSE)。第三者の辞書等は [ライセンス一覧](docs/THIRD-PARTY.md) に従います。
- ブラウザのキャッシュ保持やAIの速度・正確性は保証されません。スマホ実機での速度は機種・画像・回線によって変わります。

## スマホ導入の検証版

[別のCloudflareアカウントへ導入する](https://deploy.workers.cloudflare.com/?url=https://github.com/edoaki/glossframe/tree/mobile-setup-preview)

公式ボタンの実環境検証用ブランチです。[手順](docs/MOBILE-DEPLOYMENT.md)を参照してください。
