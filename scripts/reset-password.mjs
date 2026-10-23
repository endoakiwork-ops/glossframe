#!/usr/bin/env node
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { ownerQuery } from "./owner-db.mjs";
import readline from "node:readline";

const isRemote = process.argv.includes("--remote");


function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const stdin = process.stdin;

    process.stdout.write(question);

    let password = "";
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    const onData = (chunk) => {
      const char = chunk.toString();
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.removeListener("data", onData);
        if (stdin.setRawMode) stdin.setRawMode(wasRaw);
        process.stdout.write("\n");
        rl.close();
        resolve(password);
      } else if (char === "\u0003") {
        // Ctrl+C
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "\u007f" || char === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
      } else {
        password += char;
      }
    };

    stdin.on("data", onData);
  });
}

function checkOwnerExists() {
  try {
    const parsed = ownerQuery('SELECT count(*) as count FROM owner WHERE id = 1;', isRemote);
    const count = parsed[0]?.results?.[0]?.count ?? 0;
    return Number(count) > 0;
  } catch (err) {
    throw new Error(`DB所有者確認に失敗しました: ${err.message}`);
  }
}

async function main() {
  console.log(`=== GlossFrame パスワード再設定 (${isRemote ? "本番 (remote)" : "ローカル (local)"}) ===`);
  console.log("既存の単語帳や翻訳履歴はすべて保持されます。\n");

  if (!process.stdin.isTTY) throw new Error("パスワードは対話端末で入力してください。");
  const exists = checkOwnerExists();
  if (!exists) {
    console.error("エラー: 所有者レコードが見つかりません。先に scripts/bootstrap-owner.mjs を実行してください。");
    process.exit(1);
  }

  const pass1 = await promptHidden("新しく設定するパスワード (8文字以上): ");
  if (pass1.length < 8) {
    console.error("エラー: パスワードは8文字以上にしてください。");
    process.exit(1);
  }

  const pass2 = await promptHidden("確認のためもう一度入力してください: ");
  if (pass1 !== pass2) {
    console.error("エラー: 確認用パスワードが一致しません。");
    process.exit(1);
  }

  const saltBytes = randomBytes(16);
  const salt = saltBytes.toString("base64");
  const iterations = 100_000;
  const hash = pbkdf2Sync(pass1, saltBytes, iterations, 32, "sha256").toString("base64");
  const now = Date.now();

  const updateSql = `UPDATE owner SET password_hash = '${hash}', salt = '${salt}', iterations = ${iterations}, updated_at = ${now} WHERE id = 1; DELETE FROM sessions;`;

  ownerQuery(updateSql, isRemote);
  console.log("\nパスワードの再設定が完了しました。古いセッションはクリアされました。");
  console.log("新しいパスワードでアプリにログインできます。");
}

main().catch((err) => {
  console.error("エラーが発生しました:", err.message);
  process.exit(1);
});
