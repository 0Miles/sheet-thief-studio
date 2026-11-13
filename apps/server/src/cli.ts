// The server's command line, run on the server itself (`pnpm --filter @studio/server cli …`):
//   migrate                                    bring the database up to the latest schema
//   create-admin <username> <display name>     create an admin; the password is read from stdin
// A password is never an argument: arguments end up in the shell history and the process list.
import type { Readable, Writable } from "node:stream";

import type { Sequelize } from "sequelize";
import { ZodError } from "zod";

import { createAccount, UsernameTaken } from "./accounts";
import { readConfig } from "./config";
import { connectDatabase } from "./db/database";
import { migrate } from "./db/migrate";

export interface CliIo {
  /** A terminal is prompted without echo; anything else is read up to its first line break. */
  stdin: Readable & { isTTY?: boolean; setRawMode?(mode: boolean): unknown };
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
}

const USAGE = `用法：
  cli migrate
  cli create-admin <帳號名稱> <顯示名稱>    密碼從標準輸入讀取
`;

/** Run one command; resolves to the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === "migrate" && rest.length === 0) {
    return withDatabase(io, async (sequelize) => {
      const ran = await migrate(sequelize);
      io.stdout.write(ran.length === 0 ? "資料庫已是最新。\n" : `已執行遷移：${ran.join("、")}\n`);
      return 0;
    });
  }
  if (command === "create-admin" && rest.length === 2) {
    const [username, displayName] = rest as [string, string];
    return withDatabase(io, async () => {
      const password = await readPassword(io);
      if (password === null) return 1;
      try {
        // The admin chose the password: no forced change at the first login (ADR 0004).
        await createAccount({ username, displayName, password, isAdmin: true, mustChangePassword: false });
      } catch (error) {
        if (error instanceof UsernameTaken) return fail(io, `帳號名稱 ${username} 已經有人使用。`);
        if (error instanceof ZodError) return fail(io, describe(error));
        throw error;
      }
      io.stdout.write(`已建立管理者 ${username}。\n`);
      return 0;
    });
  }
  io.stderr.write(USAGE);
  return 2;
}

/** Run with a connection bound to the models (src/db/models.ts), closed afterwards. */
async function withDatabase(io: CliIo, run: (sequelize: Sequelize) => Promise<number>): Promise<number> {
  const sequelize = connectDatabase(readConfig(io.env).databaseUrl);
  try {
    return await run(sequelize);
  } finally {
    await sequelize.close();
  }
}

function fail(io: CliIo, message: string): number {
  io.stderr.write(`${message}\n`);
  return 1;
}

const RULES: Record<string, string> = {
  username: "帳號名稱只能用小寫英數、- 與 _，長度 3–32。",
  displayName: "顯示名稱長度要在 1–50 字元。",
  password: "密碼長度要在 10–256 字元。",
};

function describe(error: ZodError): string {
  return [...new Set(error.issues.map((issue) => RULES[String(issue.path[0])]))].join("\n");
}

async function readPassword(io: CliIo): Promise<string | null> {
  if (!io.stdin.isTTY) return firstLine(io.stdin);
  const password = await promptHidden(io, "密碼：");
  const again = await promptHidden(io, "再輸入一次：");
  if (password !== again) {
    fail(io, "兩次輸入的密碼不一樣。");
    return null;
  }
  return password;
}

async function firstLine(stream: Readable): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
    if (/\r?\n/.test(text)) break;
  }
  return text.split(/\r?\n/)[0] ?? "";
}

/** Ask on the terminal without showing what is typed. */
function promptHidden(io: CliIo, question: string): Promise<string> {
  const { stdin, stdout } = io;
  stdout.write(question);
  stdin.setRawMode?.(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let typed = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          resolve(typed);
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        typed = char === "\u007f" || char === "\b" ? [...typed].slice(0, -1).join("") : typed + char;
      }
    };
    stdin.on("data", onData);
  });
}
