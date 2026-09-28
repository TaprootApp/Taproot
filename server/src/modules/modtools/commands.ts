import { RootGuidType, RootGuidUtils, UserGuid } from "@rootsdk/server-app";
import { CommandContext, register, UsageError } from "../../commands/registry";
import { describeError } from "../../lib/api";
import { formatDuration, formatUtc, parseDuration } from "../../lib/time";
import { truncate, userMention } from "../../lib/text";
import { nicknameOf } from "../../members";
import { Level, listRoles } from "../../permissions";
import { changeDuration, DurationRefused } from "./durations";
import { MAX_NOTE, parseNewDuration } from "./logic";
import { addNote, deleteNote, notesFor } from "./notes";
import { activeTempRoles, endTempRole, giveTempRole, TempRoleRefused } from "./tempRoles";
import { voiceKick, voiceMute, VoiceRefused, voiceUnmute } from "./voice";

const CATEGORY = "Mod tools";

/** A member mention, or a raw user ID for people who left. */
function takeUser(ctx: CommandContext): UserGuid {
  const mention = ctx.args.mention("user");
  if (mention?.id) return mention.id as UserGuid;
  const next = ctx.args.peek();
  if (next?.kind === "word") {
    try {
      if (RootGuidUtils.toRootGuidType(next.text) === RootGuidType.Person) {
        ctx.args.next();
        return next.text as UserGuid;
      }
    } catch {
      // Not an ID.
    }
  }
  throw new UsageError("Mention the member first.");
}

/** Runs an action whose refusals (rank, bad input, Root errors) become a ❌ reply. */
async function refusable(ctx: CommandContext, op: () => Promise<string | void>): Promise<void> {
  try {
    const text = await op();
    if (text) await ctx.reply(text);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    const known = err instanceof TempRoleRefused || err instanceof VoiceRefused || err instanceof DurationRefused;
    await ctx.reply(`❌ ${known ? (err as Error).message : describeError(err)}`);
  }
}

export function registerCommands(): void {
  register(
    {
      name: "note",
      category: CATEGORY,
      level: Level.Moderator,
      usage: "@member <text>",
      description: "Add a private staff note about a member. Notes aren't cases and members never see them.",
      async run(ctx) {
        const target = takeUser(ctx);
        const text = ctx.args.rest();
        if (!text) throw new UsageError("Write the note after the member.");
        if (text.length > MAX_NOTE) throw new UsageError(`Notes can be at most ${MAX_NOTE} characters.`);
        const note = await addNote(target, ctx.authorId, text);
        await ctx.reply(`📝 Note #${note.id} added for **${await nicknameOf(target)}**.`);
      },
    },
    {
      name: "notes",
      category: CATEGORY,
      level: Level.Moderator,
      usage: "@member",
      description: "List the staff notes on a member.",
      async run(ctx) {
        const target = takeUser(ctx);
        const notes = await notesFor(target, 20);
        const name = await nicknameOf(target);
        if (notes.length === 0) return ctx.reply(`No notes on **${name}**.`);
        const lines = notes.map((n) => `**#${n.id}** ${truncate(n.text, 300)} · by ${n.author_name} · ${formatUtc(n.created_at)}`);
        await ctx.reply([`📝 **Notes on ${name}** (${notes.length === 20 ? "latest 20" : notes.length})`, ...lines].join("\n"));
      },
    },
    {
      name: "delnote",
      category: CATEGORY,
      level: Level.Moderator,
      usage: "<note number>",
      description: "Delete a staff note.",
      async run(ctx) {
        const id = Number(ctx.args.word());
        if (!Number.isInteger(id)) throw new UsageError("Give the note number (see `notes @member`).");
        const note = await deleteNote(id);
        await ctx.reply(note ? `🗑️ Note #${id} deleted.` : "❌ No note with that number.");
      },
    },
    {
      name: "duration",
      category: CATEGORY,
      level: Level.Moderator,
      usage: "<case number> <duration | perm>",
      description: "Change how long an active mute or temp ban has left, counted from now.",
      details: [
        "`duration 12 2h` makes case #12's mute end in two hours. `duration 12 perm` removes the end.",
        "Root can't edit a ban, so Taproot lifts and re-places it with the same reason; Root posts its usual ban notice again.",
      ],
      async run(ctx) {
        const id = Number(ctx.args.word());
        const text = ctx.args.word();
        if (!Number.isInteger(id) || !text) throw new UsageError();
        const ms = parseNewDuration(text, parseDuration);
        if (ms === undefined) throw new UsageError("Durations look like `30m`, `2h`, `1d` or `perm`.");
        await refusable(ctx, async () => `⏱️ ${await changeDuration(ctx.authorId, id, ms)}`);
      },
    },
    {
      name: "temprole",
      category: CATEGORY,
      level: Level.Moderator,
      usage: "@member @role <duration> · list · remove <number>",
      description: "Give a member a role that Taproot takes away again after the duration.",
      details: [
        "`temprole @Sam @Event 3d` · `temprole list` shows active temp roles · `temprole remove 4` ends one now.",
        "Running it again for the same member and role changes when it ends. Only admins can hand out staff roles.",
      ],
      async run(ctx) {
        const sub = ctx.args.peek();
        if (sub?.kind === "word" && sub.text.toLowerCase() === "list") {
          const rows = await activeTempRoles();
          if (rows.length === 0) return ctx.reply("No active temp roles.");
          const lines = await Promise.all(
            rows.slice(0, 30).map(async (r) => `**#${r.id}** ${await nicknameOf(r.user_id as UserGuid)} · **${r.role_name}** · ends ${formatUtc(r.expires_at)}`),
          );
          return ctx.reply([`⏳ **Active temp roles (${rows.length})**`, ...lines].join("\n"));
        }
        if (sub?.kind === "word" && sub.text.toLowerCase() === "remove") {
          ctx.args.next();
          const id = Number(ctx.args.word());
          if (!Number.isInteger(id)) throw new UsageError("Give the temp role number (see `temprole list`).");
          return refusable(ctx, async () => {
            const row = await endTempRole(id, ctx.authorId);
            return row ? `⌛ Took **${row.role_name}** back early.` : "❌ No active temp role with that number.";
          });
        }
        const target = takeUser(ctx);
        const roleToken = ctx.args.mention("role");
        if (!roleToken?.id) throw new UsageError("Mention the role after the member.");
        const role = (await listRoles()).find((r) => r.id === roleToken.id);
        if (!role) throw new UsageError("I couldn't find that role.");
        const durationText = ctx.args.word();
        const ms = durationText ? parseDuration(durationText) : undefined;
        if (!ms) throw new UsageError("Give a duration like `1h`, `3d` or `2w`.");
        await refusable(ctx, async () => {
          const result = await giveTempRole({ actorId: ctx.authorId, actorLevel: ctx.level, userId: target, roleId: role.id, durationMs: ms });
          const who = userMention(result.name, target);
          return result.extended
            ? `⏳ ${who} keeps **${role.name}** for ${formatDuration(ms)} more (temp role #${result.row.id}).`
            : `⏳ Gave ${who} **${role.name}** for ${formatDuration(ms)} (temp role #${result.row.id}).`;
        });
      },
    },
    {
      name: "vmute",
      category: CATEGORY,
      level: Level.Moderator,
      usage: "@member [reason]",
      description: "Server-mute a member in voice. They stay muted in every voice channel until vunmute.",
      async run(ctx) {
        const target = takeUser(ctx);
        const reason = ctx.args.rest();
        await refusable(ctx, async () => `🎙️ ${await voiceMute(ctx.authorId, target, reason)}`);
      },
    },
    {
      name: "vunmute",
      category: CATEGORY,
      level: Level.Moderator,
      usage: "@member",
      description: "Lift a voice mute.",
      async run(ctx) {
        const target = takeUser(ctx);
        await refusable(ctx, async () => `🎙️ ${await voiceUnmute(ctx.authorId, target)}`);
      },
    },
    {
      name: "vkick",
      category: CATEGORY,
      level: Level.Moderator,
      usage: "@member [reason]",
      description: "Disconnect a member from the voice channel they're in.",
      async run(ctx) {
        const target = takeUser(ctx);
        const reason = ctx.args.rest();
        await refusable(ctx, async () => `🎙️ ${await voiceKick(ctx.authorId, target, reason)}`);
      },
    },
  );
}
