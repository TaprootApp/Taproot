import { rootServer, UserGuid } from "@rootsdk/server-app";
import { read } from "../../lib/api";

// When members joined, for the new-member link gate. Joins seen live are
// recorded directly; anyone else is looked up once (joinedAt on the member)
// and cached. Only consulted for messages that contain a link.

const joined = new Map<string, number | null>();
const MAX_ENTRIES = 20_000;

export function noteJoin(userId: string, at = Date.now()): void {
  if (joined.size >= MAX_ENTRIES) joined.clear();
  joined.set(userId, at);
}

/** Milliseconds since the member joined, or undefined when Root doesn't say. */
export async function memberForMs(userId: UserGuid): Promise<number | undefined> {
  let at = joined.get(userId);
  if (at === undefined) {
    try {
      const member = await read("communityMembers.get", () => rootServer.community.communityMembers.get({ userId }));
      at = member.joinedAt ? new Date(member.joinedAt).getTime() : null;
    } catch {
      return undefined;
    }
    if (joined.size >= MAX_ENTRIES) joined.clear();
    joined.set(userId, at);
  }
  return at === null ? undefined : Date.now() - at;
}
