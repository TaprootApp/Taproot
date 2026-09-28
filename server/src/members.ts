import { rootServer, UserGuid } from "@rootsdk/server-app";
import { get, run } from "./db";
import { read } from "./lib/api";

// Nicknames for display in mod-log entries and goodbye messages. Root may not
// return a member who has already left, so the last known nickname is kept.

const memory = new Map<string, string>();

export async function nicknameOf(userId: UserGuid): Promise<string> {
  try {
    const member = await read("communityMembers.get", () => rootServer.community.communityMembers.get({ userId }));
    await rememberNickname(userId, member.nickname);
    return member.nickname;
  } catch {
    return (await lastKnownNickname(userId)) ?? "Unknown member";
  }
}

export async function rememberNickname(userId: string, nickname: string): Promise<void> {
  if (!nickname || memory.get(userId) === nickname) return;
  memory.set(userId, nickname);
  await run(
    "INSERT INTO member_names (user_id, nickname, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at",
    [userId, nickname, Date.now()],
  );
}

export async function lastKnownNickname(userId: string): Promise<string | undefined> {
  const cached = memory.get(userId);
  if (cached) return cached;
  const row = await get<{ nickname: string }>("SELECT nickname FROM member_names WHERE user_id = ?", [userId]);
  return row?.nickname;
}
