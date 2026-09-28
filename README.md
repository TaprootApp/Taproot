# Taproot 🌱

A Dyno-style moderation and utility App for [Root](https://rootapp.com). It covers moderation with numbered cases and a mod log, auto-mod with raid protection, an action log, custom commands and autoresponders, welcome and goodbye messages with autoroles, reminders and scheduled announcements, reaction or self-assignable roles, levels and an economy, giveaways, polls, a starboard, support tickets and forms, and YouTube, Reddit, Twitch and Kick feeds. Features that Dyno keeps for premium, such as auto purge, timed autoroles and voice text-channel links, are included for everyone. See [Differences from Dyno](#differences-from-dyno) for what Root doesn't allow.

You can run Taproot two ways, and both do the same things:

- **The Taproot channel.** Adding the App to a community gives it a channel with a full dashboard. Staff get moderation and settings pages. Everyone else gets their own self roles and reminders.
- **Text commands** in any channel Taproot can see. Every command starts with the prefix, which is `!` by default and can be changed with `!prefix` or on the General page. Type `!help`, or `!help <command>` for details on one command.

A change made in one place shows up in the other right away. For example, a `!warn` appears on the Cases page, and a prefix saved in the GUI works in chat immediately.

## Setup

1. In the [Root Developer Portal](https://dev.rootapp.com), create a project for Taproot. Copy its App ID into `"id"` in `root-manifest.json`.
2. In the portal, generate a dev token. Put it in `server/.env` as `DEV_TOKEN=...`. The token also chooses the community you test in: Root creates a `<project>-test` community for your first token.
3. Install and build. `npm run build` generates the networking code from the `.proto` files in `networking/src/`, then compiles the server and the client.
   ```sh
   npm install
   npm run build
   ```
4. Run the App locally, with each command in its own terminal:
   ```sh
   npm run server   # the App's server, connected to your test community
   npm run client   # the GUI on http://localhost:5173
   ```
   Root's DevBar at the top of the client lets you pick which member you're testing as. You can open several browser windows to test several members at once.
5. In Root, open Taproot's settings page and pick your **Admins** and **Moderators**. Optionally pick who is **Exempt from auto-mod**. Some members count as staff even if you skip this:
   - The owner is always an admin.
   - Roles with Full Control or Manage Community count as admins.
   - Roles that can kick or ban count as moderators.
6. Set up the mod log:
   - Create a private staff channel and give Taproot access to it.
   - Pick it on the **General** page, or run `!modlog #that-channel`.

Run the unit tests with `npm test`.

If you switch dev tokens or communities, delete `rootsdk.sqlite3`. Otherwise the dev host complains that the data belongs to a different community.

### Local testing notes

- **Permissions in the dev host.** Root's dev host (`@rootsdk/dev-tools` 0.21.3) sends the manifest's permission names (`kick`, `createMessage`) unchanged. Root's message expects prefixed names (`communityKick`, `channelCreateMessage`), so without a fix every permission is dropped. Bans, kicks and mutes would then fail with "no permission". To work around this, `npm run server` first runs `scripts/dev-manifest.js`, which writes a git-ignored `root-manifest.dev.json` with both spellings, and starts the dev host with that file. `root-manifest.json` itself stays as Root's schema expects, for packaging.
- **Ports.** The dev host uses ports 8080-8082 by default. To move it, set `ROOT_DEV_WS_PORT` and `ROOT_DEV_WS_UPDATE_PORT` in `server/.env`. The Vite dev server passes the same values to the client.
- **The dev bar's "Virtual User"** isn't a real member, so pages that look up your roles show errors. Pick a real member in the **Current User** menu.
- **Where the GUI runs.** Locally it runs in your browser only; Root's desktop client can't show a local App GUI yet. Text commands and auto-mod work in the desktop client as usual.

### Publishing

1. In the Developer Portal, generate an auth token for the App. Put it in `server/.env` as `AUTH_TOKEN=...`. It's separate from `DEV_TOKEN`.
2. Bump `"version"` in `root-manifest.json`. It must increase on every upload; Root refuses a version it already has.
3. Build, package and upload in one step:
   ```sh
   npm run upload
   ```
   This runs `npm run build`, then `rootsdk build package`, then `rootsdk upload package` with the token from `server/.env`. A successful upload ends with `App Push result: 0`.

## The Taproot channel

Everyone sees only the pages their level allows, and the server checks the level again on every request. Pages refresh by themselves when something changes, whether it came from the GUI, a text command, auto-mod or a timed job.

### You (everyone)
- **Me.** Turn self-assignable roles on or off, and see or cancel your own reminders. Cards for your AFK note, your highlight keywords, your level and rank, your wallet (collect daily, work, buy from the shop), your tickets (with an Open a ticket button) and the forms you've sent. Level and wallet cards show only when levels or the economy are on.
- **Forms.** Fill in the forms staff have published, such as applications or appeals.

### Moderation (moderators)
- **Overview.** Counts of cases in the last day and week, active mutes, active bans and auto-mod removals. Also shows the latest cases and lists of active mutes and bans, with Unmute and Unban buttons.
- **Cases.** The full case log, filtered by action or member, with paging. You can edit a case's reason and void warnings.
- **Members.** Search by name or user ID. A member's page shows their roles, staff level, warnings, mute and ban status and recent cases. It also has Warn, Mute, Unmute, Kick, Ban and Unban buttons. These follow the same rules as the commands: you can only act on members ranked below you, and never on the owner or bots. Cards for staff notes, temp roles and voice (mute, unmute, disconnect), and a **Change length** button on the Muted and Banned banners.
- **Temp roles.** Every role Taproot will take away later, with when, and a button to remove one early.
- **Tickets.** Open and closed tickets, the transcript viewer and a Close button. Admins can delete a record.
- **Submissions.** Form answers, filtered by form and status. Set each one to accepted, denied, closed or pending with a note. Admins can delete.

### Community
- **Custom commands** (moderators). Create, edit, rename and delete commands. The page previews the response live and shows placeholder help.
- **Announcements** (moderators). Post a message right away, schedule one for later (once, daily, weekly or monthly), and delete scheduled posts. Times are entered in your own time zone.
- **Reaction roles** (admins). Create panels, add or remove emoji → role pairs and delete panels. Roles with staff permissions can't be added.
- **Autoresponder** (moderators). Triggers (exact, contains, starts with or wildcard) with a reply, a reaction or both, per-trigger channels and cooldowns.
- **Giveaways** (moderators). Start, end, reroll or cancel giveaways, with entry counts and winners.
- **Polls** (moderators). Start polls and watch the results live.
- **Feeds** (admins). YouTube, Reddit, Twitch and Kick feeds with their status, last check, last post and last error, a template preview and a Test button. The Twitch client ID and secret are set here too; the secret is never shown again once saved.

### Engagement (everyone)
- **Leaderboard.** Levels and currency tabs, 25 per page. Admins can click a member to adjust them, or reset a whole board.

### Settings (admins)
- **General.** The command prefix, the mod log channel, and which roles are self-assignable.
- **Welcome.** Welcome and goodbye channels and messages, with a live preview, plus autoroles for new members.
- **Auto-mod.** The master switch and every rule's settings. This includes blocked words, allowed domains, mention, spam and caps limits, repeat-offender mutes and ignored channels.
- **Punishments.** Automatic mute, kick or ban when a member reaches a number of warnings.
- **Auto-mod** also has per-rule actions (delete, warn, mute, kick or ban), custom notices, log channels and exemptions, and a **More filters** section for invites, scam links, zalgo, emoji, walls of text, repeated characters, attachments and links from new members.
- **Channel rules.** Auto delete (by message type, or everything after a while), slowmode and scheduled auto purges.
- **Join protection.** Autoban by name pattern or account age, raid detection and settings, and Start/End raid buttons.
- **Action log.** The default log channel, an on/off switch and channel override for each event, ignored channels, and public ban and kick announcements with a live preview.
- **Mod tools.** Timed autoroles and optional push notifications to members who are warned, muted, kicked or banned.
- **Levels.** XP range and cooldown, the level-up message and where it goes, role rewards (stacked or highest only), role multipliers, and channels and roles that earn no XP.
- **Economy.** Currency name and symbol, daily, streak and work amounts, and the shop (role items with price and optional stock).
- **Starboard.** Channel, emoji, threshold, self-stars and ignored channels. Messages in ticket channels never reach the starboard; ignore other private channels (staff chat, say) so they aren't reposted where more people can see them.
- **Tickets.** The ticket channel group, staff roles, log channel, welcome message, a reaction panel and how long transcripts are kept.
- **Form builder.** Forms with short, paragraph and multiple-choice questions, a submission channel, a role restriction and one-per-member or unlimited answers. Banned members can't reach the community, so appeal forms only work for members who are muted or warned.
- **Voice links.** Voice channels linked to text channels that members can use while they're in voice.

## Commands

**M** = moderators, **A** = admins. Everything else is available to everyone.

### Moderation
| Command | Who | What it does |
|---|---|---|
| `warn @member <reason>` | M | Records a warning. Counts toward `warnpunish` thresholds. |
| `warnings @member` · `delwarn <case>` · `clearwarns @member` | M | View or void warnings. |
| `warnpunish <count> <mute\|kick\|ban\|none> [duration]` | A | Automatic action when a member reaches N warnings. |
| `mute @member [duration] [reason]` · `unmute @member` | M | Stops the member posting, reacting and talking. |
| `kick @member [reason]` | M | Removes the member. They can rejoin with an invite. |
| `ban @member [duration] [reason]` · `unban <user ID>` · `bans` | M | Bans with a duration are lifted by Root automatically. |
| `purge <1-200> [@member\|bots\|links]` | M | Bulk delete recent messages. Pinned messages are kept. |
| `lock [#channel] [duration] [reason]` · `unlock [#channel]` | M | Stops @everyone posting. With a duration it unlocks itself. |
| `modlogs @member` · `case <n>` · `reason <n> <text>` | M | Case history. |
| `modlog <#channel\|off>` | A | Where cases are posted. |

Durations look like `10m`, `2h`, `1d` or `1w2d`.

### Mod tools (moderators)
| Command | What it does |
|---|---|
| `note @member <text>` · `notes @member` · `delnote <n>` | Private staff notes. They aren't cases and never go to the mod log. |
| `duration <case> <duration\|perm>` | Change how long an active mute or temp ban has left, counted from now. A temp ban is lifted and re-applied, because Root can't edit a ban. |
| `temprole @member @role <duration>` · `temprole list` · `temprole remove <n>` | A role Taproot takes away again later. Only admins can hand out staff roles. |
| `vmute @member [reason]` · `vunmute @member` · `vkick @member [reason]` | Server-mute a member in voice (re-applied whenever they join voice, until `vunmute`), or disconnect them. |

Timed autoroles (roles given a while after someone joins) and optional push notifications to punished members are set on the **Mod tools** settings page.

### Auto-mod (admins)
Auto-mod is off until you run `automod on`. Running `automod` on its own shows the current setup.

| Rule | What it catches |
|---|---|
| **words** | Words on the blocked list, managed with `badword add/remove/list`. `spam*` also catches words that start with "spam". Common swaps like `j3rk` are matched too. |
| **links** | Any external link except allowed domains, managed with `allowlink add youtube.com`. |
| **mentions** | @All or @Here from non-staff, and more than N mentions in one message. |
| **spam** | Messages sent too fast, or the same message repeated. |
| **caps** | Mostly-capitals messages. Off by default. |
| **invites** | Invite links to other Root communities. Allow your own codes with `automodset invite add <code>`. |
| **scam** | Known scam and lookalike domains and phrases. Add more with `automodset scamdomain add <domain>`. No outside lookups are made. |
| **zalgo** | Text stacked with combining marks. |
| **emoji** | More than N emoji in one message. |
| **wall** | Walls of text (too many lines or characters). |
| **repeated** | The same character repeated many times. |
| **attachments** | More than N attachments in one message. |
| **newlinks** | Links from members who joined in the last N minutes. |

- Turn a single rule on or off with `automod <rule> on|off`.
- Skip a channel with `automod ignore #channel`.
- Tune the limits with `automodset` (see `help automodset`).
- Offending messages are deleted, and the member gets a notice that removes itself after a few seconds.
- Repeat offenders are muted: by default, 3 violations within 10 minutes means a 10-minute mute.
- Each rule can have its own action with `automod action <rule> <delete|warn|mute [duration]|kick|ban>`, its own notice with `automod response <rule> <text|off>`, a report channel with `automod log <rule> <#channel|off>` and exemptions with `automod exempt <rule> <#channel|@role>`.

| Command | Who | What it does |
|---|---|---|
| `slowmode [#channel] <seconds\|2m\|off>` | M | Messages sent too soon are deleted with a short notice. Staff are exempt. |
| `autodelete #channel <any\|images\|attachments\|links\|text\|commands>` · `autodelete #channel after <duration\|off>` · `autodelete #channel off` | A | Keep a channel to one kind of message, or delete every message after a while. Pinned messages are kept. |
| `autopurge add #channel every <hours>h` · `autopurge add #channel daily <HH:MM>` · `autopurge remove <id>` · `autopurge run <id>` | A | Purge a channel on a schedule (times in UTC). |
| `autoban on\|off` · `autoban name add\|remove <pattern>` · `autoban age <days\|off>` · `autoban action kick\|ban` · `autoban reason <text>` | A | Remove new members by name pattern (`*` wildcard) or account age. |
| `raid on [reason]` · `raid off` | M | Start or end raid mode: lock the chosen channels and slow joins. |
| `raid detect on\|off` · `raid set <joins> <seconds>` · `raid lock add\|remove #channel` · `raid throttle on\|off [joins] [minutes]` · `raid autoend <minutes\|off>` | A | Raid mode setup. |

### Custom commands
- `cc add <name> <response>`, `cc edit`, `cc remove` (staff).
- `cc list` and `cc show <name>` (everyone).
- Anyone can then type `!<name>`.
- Placeholders:
  - `{user}` mentions whoever ran the command, and `{user.name}` is their name.
  - `{target}` is the first member they mentioned.
  - `{args}` is any text after the command.
  - `{channel}` and `{server}` are the channel and community.

### Welcome (admins)
- `welcome channel #channel`, `welcome message <text>`, `welcome test`, `welcome off`.
- `goodbye …` uses the same subcommands. It only posts when members leave on their own, not for kicks or bans.
- `autorole add/remove @role` and `autorole list` set roles given to every new member.

### Reminders and announcements
- `remind <when> <message>` pings you in the channel later. `reminders` lists yours, and `reminders cancel <n>` cancels one.
- `announce #channel <message>` posts a message right away (moderators).
- `schedule #channel <when> [daily|weekly|monthly] <message>` posts later, once or on repeat. `schedule list` and `schedule remove <n>` manage them (moderators).
- `when` is a duration from now, or a UTC date and time like `2026-10-03 19:00`. Timing is accurate to about a minute.

### Roles
- **Reaction roles (admins).**
  1. `rr create #roles Pick your games` posts a panel.
  2. `rr add <panel> :emoji: @role [label]` adds a role to it.
  3. `rr remove`, `rr list` and `rr delete` manage panels.
- **Self roles.** Admins mark roles with `selfrole add @role`. Members see them with `roles`, and add or drop them with `iam <role>` and `iamnot <role>`.
- **Staff.** `role @member @role` gives the role, or takes it away if the member already has it (moderators).
- Roles with staff permissions are never self-assignable. Only admins can hand them out with `role`.

### Logging (admins)
- `logs channel <#channel|off>` picks the default log channel. Make it private.
- `logs on|off <events|group|all>` switches events; `logs events` lists them. Events: message deletes and edits; member joins, leaves, kicks, bans, unbans and role changes; roles and channels created, edited and deleted; voice joins and leaves (off by default).
- `logs route <events> <#channel|default>` sends some events to their own channel. `logs ignore #channel` stops logging a channel.
- `logs announce channel #channel`, `logs announce bans|kicks on|off`, `logs announce ban|kick <template>` and `logs announce test` post public ban and kick announcements. Placeholders: `{user.name}` `{user.id}` `{reason}` `{server}`.

### Info and utility (everyone)
- `whois [@member]` (also `userinfo`), `serverinfo`, `roleinfo <@role|name>`, `channelinfo [#channel]`, `avatar [@member]`, `membercount`. Lookups show names in bold and never ping. Members can only look up channels they can see.
- `afk [message]` marks you away. Anyone who mentions or replies to you gets your note; it clears when you next post.
- `highlight add|remove <keyword>`, `highlight list`, `highlight clear` (also `hl`, `highlights`). You get a push notification when a keyword is said in a channel you can see and haven't posted in for 5 minutes. Up to 25 keywords.
- **Fun:** `8ball <question>`, `coinflip` (also `flip`), `roll [NdM[+K]]`, `choose a | b | c`, `rps <rock|paper|scissors>`.

### Autoresponder (moderators)
- `ar add [mode] <trigger> | <response>` replies, and `ar react [mode] <trigger> | <:emoji:>` reacts (also `autoresponder`). Modes: `exact` (the default), `contains` (whole words), `starts` or `wildcard` (`*` for any text). Responses can use `{user}`, `{user.name}`, `{channel}` and `{server}`.
- `ar remove <n>`, `ar cooldown <n> <30s|5m|off>`, `ar channels <n> <#channel…|all>`, `ar list`.

### Levels
- `rank [@member]`, `levels [page]` and `levelrewards` (everyone).
- `levelrewards add <level> @role` · `levelrewards remove <level> [@role]` (admins).
- `xp give|take|set @member <n>` · `xp reset <@member|all>` (admins). Reward roles follow the new level.
- Levels are off until an admin turns them on in **Settings › Levels**.

### Economy
- `balance [@member]` (also `bal`), `daily`, `work`, `pay @member <amount|all>`, `rich [page]`, `shop`, `buy <number|name>` (everyone). `daily` builds a streak if claimed again within 48 hours; `work` pays once an hour.
- `shop add <price> @role [name]` · `shop remove <item>` · `eco give|take|set @member <n>` · `eco reset <@member|all>` (admins).
- The economy is off until an admin turns it on in **Settings › Economy**.

### Giveaways, polls and starboard
- `giveaway start #channel <duration> <winners> [@role] <prize>`, `giveaway end|cancel <id>`, `giveaway reroll <id> [count]`, `giveaway list` (moderators). Members enter by reacting with 🎉. Winners are mentioned and also get a push notification.
- `poll [#channel] [duration] <question> | <option> | <option> …` (2 to 10 options), `poll end <id>`, `poll list` (moderators). Anyone can vote with the number reactions. While a poll is open its message shows live results (a bar, percentage and count per option, plus the total), updated at most every 15 seconds; when it closes, the final results replace them.
- `starboard [on|off]`, `starboard channel <#channel|off>`, `starboard emoji <:emoji:>`, `starboard threshold <n>`, `starboard selfstar <on|off>`, `starboard remove <on|off>`, `starboard ignore #channel` (admins).

### Tickets
- `ticket open [topic]` opens a private channel with the staff (everyone). Members can also open one from a reaction panel or their Me page.
- `ticket close [reason]` (the opener or staff) saves a transcript to the log channel and deletes the channel.
- `ticket add|remove @member`, `ticket claim`, `ticket unclaim`, `ticket rename <name>` (staff, inside a ticket).

### Feeds (admins)
- `feed add <youtube|reddit|twitch|kick> <channel or link> #channel [@role]`, `feed remove <id>`, `feed list`, `feed test <id>`. Feeds are checked every 10 minutes by default (5 at the fastest). Only items published after the feed was added are posted. Twitch needs a client ID and secret from the Twitch developer console, entered on the **Feeds** page.
- `voicelink add #voice #text`, `voicelink remove #voice`, `voicelink list`. Members in the voice channel can see and post in the text channel; access goes away when they leave. A member who is muted when they join voice can read but not post there, until they rejoin voice after the mute ends.

## How it works on Root (and where it differs from Discord)

Root has no built-in mute and no bulk delete, and Apps can't send direct messages. So:

- **Mute** adds a member-specific "can't post" rule to each channel group the member can see. It also covers channels with their own permissions. If a rule was already there, Taproot saves it and puts it back exactly on unmute. Rules are only added where the member can already see the channel, because a rule on a private channel would reveal it to them.
- **Members whose roles have Full Control can't be muted.** Root won't let rules restrict them.
- **Lock** puts the same kind of rule on @everyone. If the channel shares its group's permissions, the whole group is locked, because Root ignores rules on such channels. Staff can still post only if they have Full Control or their own allow rule on the channel.
- **Purge** deletes one message at a time, within Root's limit of about 5 changes per second. Every write Taproot makes goes through one shared rate limiter.
- **Staff and exemptions are set on Root's settings page for the App**, because Root shows role and member pickers there. Everything else is set in the Taproot channel or with commands.
- **Warnings are posted in the channel.** Apps can't send direct messages. Admins can also turn on a generic push notification for warned, muted, kicked or banned members on the **Mod tools** page; it never includes the reason, because notifications show on lock screens.
- **Timed work survives restarts.** This covers unmutes, reminders and announcements. It all lives in SQLite with Root's job scheduler, and Taproot catches up on anything overdue at startup and once a day.
- **Taproot only sees channels it has access to.** Give it access to private channels you want auto-mod or purge to cover.

## Differences from Dyno

Root's App platform doesn't allow some things Dyno does on Discord, so Taproot works around them:

- **No direct messages.** Apps can't DM members. Where Dyno would DM (giveaway winners, closed tickets, form updates, highlights, punishment notices), Taproot sends a Root push notification instead. Those are short (a 50-character title and 150-character text) and show on lock screens, so they never include moderation reasons.
- **No buttons, menus, modals or embeds.** Chat messages are plain Markdown. Reactions do the interactive parts in chat (reaction roles, giveaways, polls, the ticket panel, the starboard), and the Taproot channel's GUI does the rest (forms, settings, applications).
- **No custom bot name or avatar.** Taproot always posts as itself; there's no per-community nickname, avatar or webhook-style "post as" feature.
- **No message links.** Starboard posts and logs link to the channel, not the exact message.
- **No inbound webhooks.** Feeds are polled (every 10 minutes by default) instead of pushed, so alerts can arrive a few minutes late.
- **No TikTok, Instagram or X feeds.** They have no public API Taproot can poll. Kick has no public API either; Taproot reads Kick's website endpoint, which Kick's bot protection may block. Twitch needs the community's own Twitch developer credentials.
- **Timers are accurate to about a minute.** Root's job scheduler has one-minute precision, so reminders, unmutes, temp roles, giveaways and polls fire within about a minute of the set time.
- **Slowmode, bulk delete and mute are emulated.** Root has none of them built in: slowmode deletes messages sent too soon, purge deletes one message at a time, and mute uses per-member channel rules.
- **Bans can't be edited.** `duration` on a temp ban lifts the ban and bans again, which Root may announce as a second ban.
- **Kicks and bans from outside Taproot have no reason.** Root's events don't carry one, so the action log shows "No reason given".
- **Appeals only work for members still in the community.** Banned members can't open the Taproot channel, so appeal forms cover mutes and warnings, not bans.
- **Raid join throttling** uses Root's community join throttle and needs the Manage Community permission (requested in the manifest).
- **Built-in commands take priority.** If a custom command created before an update has the same name as a new built-in command (for example `rank` or `poll`), the built-in one runs.

## Project layout

```
root-manifest.json     App ID, version, packaging, settings page and permissions
networking/src/        the client <-> server contract: taproot.proto for the core, one .proto per module
networking/gen/        generated from the .proto files by "npm run build" (don't edit)
server/
  src/
    main.ts            startup, event wiring and GUI services
    services/          the GUI's RPC services, auth guards and change broadcasts
    db.ts              SQLite connection and migrations
    settings.ts        per-community configuration
    permissions.ts     who counts as staff
    modlog.ts          cases and mod-log channel
    jobs.ts            job scheduler dispatch and catch-up
    commands/          prefix parsing, registry and router
    features/          one file per feature area, shared by commands and the GUI
    modules/           feature modules (logs, utility, automodplus, modtools, engagement,
                       events, support, feeds), each with its own tables, commands and GUI service
    lib/               rate-limited API calls, overlays, validation, time and text helpers
  test/                unit tests for the parts that don't need a Root connection
client/
  src/
    App.tsx            loads the session, then the shell
    shell/             sidebar navigation and page routing
    views/             one file per page (settings pages in views/settings)
    modules/           each feature module's pages and Me-page cards
    components/        shared UI kit
    lib/               hooks (session, RPC, broadcasts, lookups) and formatting
```

## License

Taproot is released under the [MIT License](LICENSE).
