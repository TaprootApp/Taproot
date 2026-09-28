import { rootServer, ChannelGuid, Client, ErrorCodeType, WellKnownRootGuids } from "@rootsdk/server-app";
import { SupportServiceBase } from "@taproot/gen-server";
import {
  SupportAvailableFormList,
  SupportCloseTicketRequest,
  SupportForm,
  SupportFormList,
  SupportIdRequest,
  SupportListSubmissionsRequest,
  SupportListTicketsRequest,
  SupportOpenTicketRequest,
  SupportPostPanelRequest,
  SupportQuestionType,
  SupportReviewRequest,
  SupportSubmission,
  SupportSubmissionList,
  SupportSubmissionStatus,
  SupportSubmitRequest,
  SupportTicket,
  SupportTicketConfig,
  SupportTicketIdRequest,
  SupportTicketList,
  SupportTicketSettings,
  SupportTicketStatus,
  SupportTranscript,
  SupportTranscriptMode,
} from "@taproot/gen-shared";
import { resolveEmojiText } from "../../features/roles";
import { emojiAsTyped } from "../../features/emoji";
import { errorCode, read } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { Level, listRoles, memberRoleIds } from "../../permissions";
import { act, invalid, notFound, requireLevel } from "../../services/auth";
import { onChange } from "../../services/changes";
import { config, TranscriptMode, updateConfig } from "./config";
import * as forms from "./forms";
import { FORM_LIMITS, QuestionType, SubmissionStatus, validateAnswers, validateForm } from "./logic";
import * as tickets from "./tickets";

// GUI service for tickets and forms. Every handler checks the caller's level
// first and validates input here; the feature functions are shared with the
// "ticket" command, so the rules and side effects are the same.

// --- Lookups ---------------------------------------------------------------------------

const channelNames = new Map<string, { at: number; name: string }>();

async function channelName(channelId: string | null | undefined): Promise<string> {
  if (!channelId) return "";
  const cached = channelNames.get(channelId);
  if (cached && Date.now() - cached.at < 60_000) return cached.name;
  try {
    const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
    channelNames.set(channelId, { at: Date.now(), name: channel.name });
    return channel.name;
  } catch {
    return "unknown channel";
  }
}

/** Checks a channel from the GUI exists. */
async function requireChannel(channelId: string): Promise<void> {
  try {
    await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
  } catch (err) {
    const code = errorCode(err);
    if (code === ErrorCodeType.NotFound || code === ErrorCodeType.RequestValidationFailed) invalid("That channel doesn't exist anymore.");
    await act(() => Promise.reject(err));
  }
}

function page(offset: number, limit: number): { offset: number; limit: number } {
  return {
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 25,
  };
}

// --- Conversions -------------------------------------------------------------------------

function toWireTicket(t: tickets.TicketSummary | tickets.Ticket): SupportTicket {
  return {
    id: t.id,
    channelId: t.channel_id,
    channelName: t.channel_name,
    openerId: t.opener_id,
    openerName: t.opener_name,
    topic: t.topic,
    status: t.status === "open" ? SupportTicketStatus.OPEN : SupportTicketStatus.CLOSED,
    claimedById: t.claimed_by_id ?? "",
    claimedByName: t.claimed_by_name ?? "",
    openedAtMs: t.opened_at,
    closedAtMs: t.closed_at ?? 0,
    closedByName: t.closed_by_name ?? "",
    closeReason: t.close_reason ?? "",
    hasTranscript: "has_transcript" in t ? Boolean(t.has_transcript) : t.transcript !== null,
    messageCount: t.message_count,
  };
}

const MODE_TO_WIRE: Record<TranscriptMode, SupportTranscriptMode> = {
  full: SupportTranscriptMode.FULL,
  summary: SupportTranscriptMode.SUMMARY,
  off: SupportTranscriptMode.OFF,
};

async function ticketSettings(): Promise<SupportTicketSettings> {
  const t = config().tickets;
  const groups = await read("channelGroups.list", () => rootServer.community.channelGroups.list());
  return {
    config: {
      enabled: t.enabled,
      channelGroupId: t.channelGroupId ?? "",
      staffRoleIds: [...t.staffRoleIds],
      maxOpen: t.maxOpen,
      transcriptChannelId: t.logChannelId ?? undefined,
      transcriptMode: MODE_TO_WIRE[t.transcriptMode],
      welcomeMessage: t.welcomeMessage,
      pingStaff: t.pingStaff,
      transcriptRetentionDays: t.retentionDays,
      panelChannelId: t.panel.messageId ? t.panel.channelId ?? "" : "",
      panelEmoji: emojiAsTyped(t.panel.emoji),
    },
    channelGroups: groups.map((g) => ({ id: g.id, name: g.name })),
    panelChannelName: t.panel.messageId ? await channelName(t.panel.channelId) : "",
  };
}

const QTYPE_TO_WIRE: Record<QuestionType, SupportQuestionType> = {
  short: SupportQuestionType.SHORT,
  long: SupportQuestionType.LONG,
  choice: SupportQuestionType.CHOICE,
};

function qtypeFromWire(type: SupportQuestionType): QuestionType | undefined {
  return (Object.keys(QTYPE_TO_WIRE) as QuestionType[]).find((k) => QTYPE_TO_WIRE[k] === type);
}

const STATUS_TO_WIRE: Record<SubmissionStatus, SupportSubmissionStatus> = {
  pending: SupportSubmissionStatus.PENDING,
  accepted: SupportSubmissionStatus.ACCEPTED,
  denied: SupportSubmissionStatus.DENIED,
  closed: SupportSubmissionStatus.CLOSED,
};

function statusFromWire(status: SupportSubmissionStatus): SubmissionStatus | undefined {
  return (Object.keys(STATUS_TO_WIRE) as SubmissionStatus[]).find((k) => STATUS_TO_WIRE[k] === status);
}

function toWireQuestions(form: forms.Form) {
  return form.questions.map((q) => ({ id: q.id, label: q.label, type: QTYPE_TO_WIRE[q.type], required: q.required, choices: [...q.choices] }));
}

async function formList(): Promise<SupportFormList> {
  const [list, counts] = await Promise.all([forms.listForms(), forms.formCounts()]);
  return {
    forms: await Promise.all(
      list.map(async (f) => ({
        id: f.id,
        title: f.title,
        description: f.description,
        questions: toWireQuestions(f),
        channelId: f.channel_id ?? undefined,
        channelName: await channelName(f.channel_id),
        roleId: f.role_id ?? "",
        onePerMember: f.one_per_member,
        enabled: f.enabled,
        submissionCount: counts.get(f.id)?.total ?? 0,
        pendingCount: counts.get(f.id)?.pending ?? 0,
      })),
    ),
  };
}

function toWireSubmission(s: forms.Submission): SupportSubmission {
  return {
    id: s.id,
    formId: s.form_id,
    formTitle: s.form_title,
    userId: s.user_id,
    userName: s.user_name,
    answers: s.answers.map((a) => ({ label: a.label, value: a.value })),
    status: STATUS_TO_WIRE[s.status] ?? SupportSubmissionStatus.PENDING,
    note: s.note,
    reviewerName: s.reviewer_name,
    createdAtMs: s.created_at,
    updatedAtMs: s.updated_at,
  };
}

async function myTickets(userId: string): Promise<SupportTicketList> {
  const rows = await tickets.listMyTickets(userId);
  const t = config().tickets;
  return { tickets: rows.map(toWireTicket), total: rows.length, ticketsEnabled: t.enabled && !!t.channelGroupId };
}

// --- Service ------------------------------------------------------------------------------

class SupportService extends SupportServiceBase {
  // Tickets (moderator+).

  async listTickets(request: SupportListTicketsRequest, client: Client): Promise<SupportTicketList> {
    await requireLevel(client, Level.Moderator);
    const status =
      request.status === SupportTicketStatus.OPEN ? "open" : request.status === SupportTicketStatus.CLOSED ? "closed" : undefined;
    const { offset, limit } = page(request.offset, request.limit);
    const { rows, total } = await tickets.listTickets(status, offset, limit);
    return { tickets: rows.map(toWireTicket), total, ticketsEnabled: false };
  }

  async getTranscript(request: SupportTicketIdRequest, client: Client): Promise<SupportTranscript> {
    await requireLevel(client, Level.Moderator);
    const ticket = (await tickets.ticketById(request.id)) ?? notFound("That ticket doesn't exist anymore.");
    if (ticket.transcript === null) notFound("This ticket has no saved transcript.");
    return { ticketId: ticket.id, text: ticket.transcript };
  }

  async closeTicket(request: SupportCloseTicketRequest, client: Client): Promise<SupportTicket> {
    await requireLevel(client, Level.Moderator);
    const ticket = (await tickets.ticketById(request.id)) ?? notFound("That ticket doesn't exist anymore.");
    if (ticket.status !== "open") invalid("That ticket is already closed.");
    const { problem } = await act(() => tickets.closeTicket(ticket, client.userId, request.reason ?? ""));
    if (problem) invalid(problem);
    return toWireTicket((await tickets.ticketById(ticket.id))!);
  }

  async deleteTicket(request: SupportTicketIdRequest, client: Client): Promise<SupportTicketList> {
    await requireLevel(client, Level.Admin);
    if (!(await tickets.deleteTicketRecord(request.id))) notFound("No closed ticket with that number.");
    const { rows, total } = await tickets.listTickets("closed", 0, 25);
    return { tickets: rows.map(toWireTicket), total, ticketsEnabled: false };
  }

  // Tickets (members, their own).

  async openTicket(request: SupportOpenTicketRequest, client: Client): Promise<SupportTicket> {
    await requireLevel(client, Level.Member);
    if ((request.topic ?? "").length > 1000) invalid("Keep the topic short.");
    const result = await act(() => tickets.openTicket(client.userId, request.topic ?? ""));
    if ("problem" in result) invalid(result.problem);
    return toWireTicket(result.ticket);
  }

  async listMyTickets(client: Client): Promise<SupportTicketList> {
    await requireLevel(client, Level.Member);
    return myTickets(client.userId);
  }

  // Ticket settings (admin).

  async getTicketSettings(client: Client): Promise<SupportTicketSettings> {
    await requireLevel(client, Level.Admin);
    return act(ticketSettings);
  }

  async saveTicketConfig(request: SupportTicketConfig, client: Client): Promise<SupportTicketSettings> {
    await requireLevel(client, Level.Admin);
    const groups = await act(() => read("channelGroups.list", () => rootServer.community.channelGroups.list()));
    const groupId = request.channelGroupId || null;
    if (groupId && !groups.some((g) => g.id === groupId)) invalid("That channel group doesn't exist anymore.");
    if (request.enabled && !groupId) invalid("Pick the channel group tickets are created in.");
    const roles = await act(listRoles);
    const staff = [...new Set(request.staffRoleIds)];
    for (const id of staff) {
      if (id === WellKnownRootGuids.CommunityRoles.EveryoneRole) invalid("@everyone can't be a ticket staff role: every ticket would be public.");
      if (!roles.some((r) => r.id === id)) invalid("One of the staff roles doesn't exist anymore.");
    }
    if (staff.length > 20) invalid("Pick up to 20 staff roles.");
    if (!Number.isInteger(request.maxOpen) || request.maxOpen < 1 || request.maxOpen > 10) invalid("Open tickets per member must be 1 to 10.");
    const logChannel = request.transcriptChannelId || null;
    if (logChannel) await requireChannel(logChannel);
    const mode = (Object.keys(MODE_TO_WIRE) as TranscriptMode[]).find((k) => MODE_TO_WIRE[k] === request.transcriptMode);
    if (!mode) invalid("Pick how transcripts are posted.");
    if (request.welcomeMessage.length > 2000) invalid("The welcome message can be up to 2,000 characters.");
    const days = request.transcriptRetentionDays;
    if (!Number.isInteger(days) || days < 0 || days > 3650) invalid("Keep transcripts for 0 (forever) to 3,650 days.");
    await act(() =>
      updateConfig((c) => {
        c.tickets = {
          ...c.tickets,
          enabled: request.enabled,
          channelGroupId: groupId,
          staffRoleIds: staff,
          maxOpen: request.maxOpen,
          logChannelId: logChannel,
          transcriptMode: mode,
          welcomeMessage: request.welcomeMessage.trim(),
          pingStaff: request.pingStaff,
          retentionDays: days,
        };
      }),
    );
    return act(ticketSettings);
  }

  async postTicketPanel(request: SupportPostPanelRequest, client: Client): Promise<SupportTicketSettings> {
    await requireLevel(client, Level.Admin);
    if (!request.channelId) invalid("Pick a channel for the panel.");
    const title = request.title.trim() || "Need help?";
    if (title.length > 100) invalid("The title can be up to 100 characters.");
    const description = request.description.trim();
    if (description.length > 1000) invalid("The description can be up to 1,000 characters.");
    await requireChannel(request.channelId);
    const shortcode = (await act(() => resolveEmojiText((request.emoji || ":ticket:").trim()))) ?? invalid("Write the emoji as a :shortcode:, like :ticket:.");
    await act(() => tickets.postPanel(request.channelId, title, description, shortcode));
    return act(ticketSettings);
  }

  async removeTicketPanel(client: Client): Promise<SupportTicketSettings> {
    await requireLevel(client, Level.Admin);
    await act(tickets.removePanel);
    return act(ticketSettings);
  }

  // Form builder (admin).

  async listForms(client: Client): Promise<SupportFormList> {
    await requireLevel(client, Level.Admin);
    return act(formList);
  }

  async saveForm(request: SupportForm, client: Client): Promise<SupportFormList> {
    await requireLevel(client, Level.Admin);
    if (request.id && !(await forms.formById(request.id))) notFound("That form doesn't exist anymore.");
    const checked = validateForm({
      title: request.title ?? "",
      description: request.description ?? "",
      questions: (request.questions ?? []).map((q) => ({
        id: q.id,
        label: q.label ?? "",
        type: qtypeFromWire(q.type),
        required: q.required,
        choices: q.choices ?? [],
      })),
    });
    if ("problem" in checked) invalid(checked.problem);
    const channelId = request.channelId || null;
    if (channelId) await requireChannel(channelId);
    const roleId = request.roleId || null;
    if (roleId && !(await act(listRoles)).some((r) => r.id === roleId)) invalid("That role doesn't exist anymore.");
    await forms.saveForm(request.id, {
      ...checked.form,
      channel_id: channelId,
      role_id: roleId === WellKnownRootGuids.CommunityRoles.EveryoneRole ? null : roleId,
      one_per_member: request.onePerMember,
      enabled: request.enabled,
    });
    return act(formList);
  }

  async deleteForm(request: SupportIdRequest, client: Client): Promise<SupportFormList> {
    await requireLevel(client, Level.Admin);
    if (!(await forms.deleteForm(request.id))) notFound("That form doesn't exist anymore.");
    return act(formList);
  }

  // Forms (members).

  async listAvailableForms(client: Client): Promise<SupportAvailableFormList> {
    await requireLevel(client, Level.Member);
    const [list, roleIds] = await Promise.all([forms.listForms(), act(() => memberRoleIds(client.userId))]);
    const out: SupportAvailableFormList["forms"] = [];
    for (const f of list) {
      // Closed forms, and role-restricted ones the member can't use, are hidden.
      if (!f.enabled || (f.role_id && !roleIds.includes(f.role_id as never))) continue;
      const blocked = await act(() => forms.submitBlocker(f, client.userId));
      out.push({ id: f.id, title: f.title, description: f.description, questions: toWireQuestions(f), blockedReason: blocked ?? "" });
    }
    return { forms: out };
  }

  async submitForm(request: SupportSubmitRequest, client: Client): Promise<SupportSubmission> {
    await requireLevel(client, Level.Member);
    const form = (await forms.formById(request.formId)) ?? notFound("That form doesn't exist anymore.");
    const blocked = await act(() => forms.submitBlocker(form, client.userId));
    if (blocked) invalid(blocked);
    if ((request.answers ?? []).length > FORM_LIMITS.questions * 2) invalid("Too many answers.");
    const checked = validateAnswers(
      form.questions,
      (request.answers ?? []).map((a) => ({ questionId: a.questionId ?? "", value: a.value ?? "" })),
    );
    if ("problem" in checked) invalid(checked.problem);
    return toWireSubmission(await act(() => forms.createSubmission(form, client.userId, checked.answers)));
  }

  async listMySubmissions(client: Client): Promise<SupportSubmissionList> {
    await requireLevel(client, Level.Member);
    const rows = await forms.listMySubmissions(client.userId);
    return { submissions: rows.map(toWireSubmission), total: rows.length };
  }

  // Submissions (moderator+).

  async listSubmissions(request: SupportListSubmissionsRequest, client: Client): Promise<SupportSubmissionList> {
    await requireLevel(client, Level.Moderator);
    const status = request.status === SupportSubmissionStatus.UNSPECIFIED ? undefined : statusFromWire(request.status);
    const { offset, limit } = page(request.offset, request.limit);
    const { rows, total } = await forms.listSubmissions(request.formId || 0, status, offset, limit);
    return { submissions: rows.map(toWireSubmission), total };
  }

  async reviewSubmission(request: SupportReviewRequest, client: Client): Promise<SupportSubmission> {
    await requireLevel(client, Level.Moderator);
    const s = (await forms.submissionById(request.id)) ?? notFound("That submission doesn't exist anymore.");
    const status = statusFromWire(request.status) ?? invalid("Pick a status.");
    const note = (request.note ?? "").trim();
    if (note.length > 1000) invalid("The note can be up to 1,000 characters.");
    return toWireSubmission(await act(() => forms.reviewSubmission(s, status, note, client.userId)));
  }

  async deleteSubmission(request: SupportIdRequest, client: Client): Promise<SupportSubmissionList> {
    await requireLevel(client, Level.Admin);
    if (!(await act(() => forms.deleteSubmission(request.id)))) notFound("That submission doesn't exist anymore.");
    const { rows, total } = await forms.listSubmissions(0, undefined, 0, 25);
    return { submissions: rows.map(toWireSubmission), total };
  }
}

export const supportService = new SupportService();

// Clients refetch on any support change; the payload is only the area name,
// and every read is re-checked on the server. Bursts are coalesced per area.
const pending = new Set<string>();
onChange((area) => {
  if (!area.startsWith("support:") || pending.has(area)) return;
  pending.add(area);
  setTimeout(() => {
    pending.delete(area);
    try {
      supportService.broadcastSupportChanged({ area }, "all");
    } catch (err) {
      log("warn", "support broadcast failed", { error: errMessage(err) });
    }
  }, 300);
});

