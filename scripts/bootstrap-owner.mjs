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

function checkExistingOwner() {
  try {
    const parsed = ownerQuery('SELECT count(*) as count FROM owner;', isRemote);
    const count = parsed[0]?.results?.[0]?.count ?? 0;
    return Number(count);
  } catch (err) {
    throw new Error(`DB所有者確認に失敗しました: ${err.message}`);
  }
}

async function main() {
  console.log(`=== GlossFrame 所有者初期登録 (${isRemote ? "本番 (remote)" : "ローカル (local)"}) ===`);
  console.log("既存の所有者がいない場合のみ登録できます。\n");

  if (!process.stdin.isTTY) throw new Error("パスワードは対話端末で入力してください。");
  const existingCount = checkExistingOwner();
  if (existingCount > 0) {
    console.error("エラー: 既に所有者が登録されています。既存の所有者を上書きすることはできません。");
    process.exit(1);
  }

  const pass1 = await promptHidden("初期登録するパスワード (8文字以上): ");
  if (pass1.length < 8) {
    console.error("エラー: パスワードは8文字以上にしてください。");
    process.exit(1);
  }

  const pass2 = await promptHidden("確認のためもう一度入力してください: ");
  if (pass1 !== pass2) {
    console.error("エラー: 確認用パスワードが一致しません。");
    process.exit(1);
  }

  const existingCountDoubleCheck = checkExistingOwner();
  if (existingCountDoubleCheck > 0) {
    console.error("エラー: 既に所有者が登録されています。処理を中止します。");
    process.exit(1);
  }

  const saltBytes = randomBytes(16);
  const salt = saltBytes.toString("base64");
  const iterations = 100_000;
  const hash = pbkdf2Sync(pass1, Buffer.from(salt, "base64"), iterations, 32, "sha256").toString("base64");
  const now = Date.now();

  const insertSql = `INSERT INTO owner (id, password_hash, salt, iterations, created_at, updated_at) VALUES (1, '${hash}', '${salt}', ${iterations}, ${now}, ${now});`;

  ownerQuery(insertSql, isRemote);
  console.log("\n所有者の初期登録が完了しました。");
}

main().catch((err) => {
  console.error("エラーが発生しました:", err.message);
  process.exit(1);
});
