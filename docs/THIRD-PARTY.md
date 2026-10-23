# 第三者コンポーネント

アプリのMITライセンスは、依存ライブラリ、モデル、辞書のライセンスを置き換えるものではありません。

- 英語語彙リスト：dictionary-enに含まれるHunspell／SCOWL辞書からscripts/build-ocr-lexicon.mjsで生成。元の通知をpublic/licenses/dictionary-en.txtに保持しています。
- OCR：ppu-paddle-ocrが提供するV5 English INT8モデルとonnxruntime-webを使用。バージョンはpackage-lock.jsonで固定し、モデルURLはパッケージの定義から取得します。モデルバイナリはGitに含めません。ppu-paddle-ocrの通知はpublic/licenses/ppu-paddle-ocr.txt、PaddleOCRの通知はpublic/licenses/paddleocr.txtに保持しています。
- ONNX Runtimeの通知はpublic/licenses/onnxruntime.txtに保持しています。
- ONNX Runtime、PaddleOCR、Tesseract.jsおよびその他のnpm依存物は、それぞれの配布元のライセンスに従います。ビルドで配信する資産についても、必要なライセンス通知を保持してください。
- 公開テストには第三者の漫画・ゲーム画像や、そのOCR抽出データを含めません。

依存ライブラリの著作権・連絡先表記は第三者のライセンス通知なので、個人環境の情報とは区別して保持します。
