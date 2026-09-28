import { rootServer, ChannelGuid, MessageGuid, UserGuid } from "@rootsdk/server-app";
import { CommandContext, register, UsageError } from "../../commands/registry";
import { write } from "../../lib/api";
import { channelMention, userMention } from "../../lib/text";
import { nicknameOf } from "../../members";
import { reply } from "../../messaging";
import { Level } from "../../permissions";
import { config } from "./config";
import { sanitizeChannelName } from "./logic";
import {
  addToTicket,
  closeTicket,
  isTicketStaff,
  learnSelf,
  openTicket,
  openTicketInChannel,
  removeFromTicket,
  renameTicket,
  setClaim,
  Ticket,
} from "./tickets";

// "ticket" and its subcommands. Everything but "open" runs inside a ticket
// channel and acts on that ticket.

async function requireTicket(ctx: CommandContext): Promise<Ticket> {
  const ticket = await openTicketInChannel(ctx.channelId);
  if (!ticket) throw new UsageError("Run this inside an open ticket channel.");
  return ticket;
}

async function requireStaff(ctx: CommandContext): Promise<void> {
  if (!(await isTicketStaff(ctx.authorId))) throw new UsageError("Only staff can do that in a ticket.");
}

async function open(ctx: CommandContext): Promise<void> {
  // Reply first: it tells the member something is happening, and Taproot
  // learns its own member ID from it before creating the channel.
  const notice = await reply(ctx.channelId, ctx.messageId, "🎫 Opening your ticket…");
  await learnSelf(notice);
  const result = await openTicket(ctx.authorId, ctx.args.rest());
  const text =
    "problem" in result
      ? `🎫 ${result.problem}`
      : `🎫 Your ticket is open: ${channelMention(result.ticket.channel_name, result.ticket.channel_id)}`;
  await write("channelMessages.edit", () =>
    rootServer.community.channelMessages.edit({ channelId: ctx.channelId as ChannelGuid, id: notice.id as MessageGuid, content: text }),
  ).catch(() => ctx.reply(text));
}

async function close(ctx: CommandContext): Promise<void> {
  const ticket = await requireTicket(ctx);
  if (ticket.opener_id !== ctx.authorId) await requireStaff(ctx);
  await ctx.reply("🔒 Closing this ticket and saving the transcript…");
  const { problem } = await closeTicket(ticket, ctx.authorId, ctx.args.rest());
  if (problem) await ctx.reply(`⚠️ ${problem}`);
}

async function addOrRemove(ctx: CommandContext, add: boolean): Promise<void> {
  const ticket = await requireTicket(ctx);
  await requireStaff(ctx);
  const target = ctx.args.mention("user");
  if (!target?.id) throw new UsageError("Mention the member.");
  const userId = target.id as UserGuid;
  const name = await nicknameOf(userId);
  if (add) {
    await addToTicket(ticket, userId);
    return ctx.reply(`➕ Added ${userMention(name, userId)} to this ticket.`);
  }
  if (userId === ticket.opener_id) throw new UsageError("The member who opened the ticket can't be removed. Close it instead.");
  if (!(await removeFromTicket(ticket, userId))) {
    return ctx.reply(`**${name}** wasn't added to this ticket individually (staff see it through their roles).`);
  }
  await ctx.reply(`➖ Removed **${name}** from this ticket.`);
}

async function claim(ctx: CommandContext, claiming: boolean): Promise<void> {
  const ticket = await requireTicket(ctx);
  await requireStaff(ctx);
  if (!claiming) {
    if (!ticket.claimed_by_id) return ctx.reply("This ticket isn't claimed.");
    await setClaim(ticket, null);
    return ctx.reply(`🙌 **${ticket.claimed_by_name}** is no longer handling this ticket.`);
  }
  if (ticket.claimed_by_id === ctx.authorId) return ctx.reply("You've already claimed this ticket.");
  await setClaim(ticket, ctx.authorId);
  const name = await nicknameOf(ctx.authorId);
  await ctx.reply(`🙋 **${name}** is handling this ticket${ticket.claimed_by_name ? ` (was ${ticket.claimed_by_name})` : ""}.`);
}

async function rename(ctx: CommandContext): Promise<void> {
  const ticket = await requireTicket(ctx);
  await requireStaff(ctx);
  const raw = ctx.args.rest();
  if (!raw) throw new UsageError("Give the new name.");
  const name = sanitizeChannelName(raw);
  if (!name) throw new UsageError("Channel names need at least one letter or number.");
  await renameTicket(ticket, name);
  await ctx.reply(`✏️ Renamed this ticket to **${name}**.`);
}

export function registerTicketCommands(): void {
  register({
    name: "ticket",
    category: "Tickets",
    level: Level.Member,
    usage: "open [topic] | close [reason] | add @member | remove @member | claim | unclaim | rename <name>",
    description: "Private support tickets with the staff.",
    details: [
      "`ticket open [topic]` makes a private channel only you and the staff can see.",
      "Inside a ticket: `ticket close [reason]` (the opener or staff) saves a transcript and deletes the channel.",
      "Staff only, inside a ticket: `ticket add @member`, `ticket remove @member`, `ticket claim`, `ticket unclaim`, `ticket rename <name>`.",
      "Admins set tickets up on the Tickets settings page in the Taproot channel.",
    ],
    async run(ctx) {
      const action = ctx.args.word();
      switch (action) {
        case "open":
        case "new":
          return open(ctx);
        case "close":
          return close(ctx);
        case "add":
          return addOrRemove(ctx, true);
        case "remove":
          return addOrRemove(ctx, false);
        case "claim":
          return claim(ctx, true);
        case "unclaim":
          return claim(ctx, false);
        case "rename":
          return rename(ctx);
        default:
          if (!config().tickets.enabled) return ctx.reply("🎫 Tickets are turned off in this community.");
          throw new UsageError();
      }
    },
  });
}
