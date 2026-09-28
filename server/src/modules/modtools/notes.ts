import { UserGuid } from "@rootsdk/server-app";
import { all, get, run } from "../../db";
import { nicknameOf } from "../../members";
import { MAX_NOTE } from "./logic";
import { changed } from "./store";

// Moderator notes (Dyno's "notes"): private context about a member that isn't
// a case. They never reach the mod log channel or the member.

export interface NoteRow {
  id: number;
  user_id: string;
  text: string;
  author_id: string;
  author_name: string;
  created_at: number;
}

export async function addNote(userId: string, authorId: UserGuid, text: string): Promise<NoteRow> {
  const body = text.trim().slice(0, MAX_NOTE);
  const { lastID } = await run(
    "INSERT INTO modtools_notes (user_id, text, author_id, author_name, created_at) VALUES (?, ?, ?, ?, ?)",
    [userId, body, authorId, await nicknameOf(authorId), Date.now()],
  );
  changed("notes");
  return (await get<NoteRow>("SELECT * FROM modtools_notes WHERE id = ?", [lastID]))!;
}

/** Newest first. */
export async function notesFor(userId: string, limit = 50): Promise<NoteRow[]> {
  return all<NoteRow>("SELECT * FROM modtools_notes WHERE user_id = ? ORDER BY id DESC LIMIT ?", [userId, limit]);
}

/** Returns the deleted note, or undefined if there was none. */
export async function deleteNote(id: number): Promise<NoteRow | undefined> {
  const note = await get<NoteRow>("SELECT * FROM modtools_notes WHERE id = ?", [id]);
  if (!note) return undefined;
  await run("DELETE FROM modtools_notes WHERE id = ?", [id]);
  changed("notes");
  return note;
}
