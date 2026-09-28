# Privacy notes for Taproot 1.1.0

This is the input for updating the public privacy policy. It lists, per module, what new data Taproot 1.1.0 stores, how long it keeps it, and every outbound network request. It was checked against the table definitions (`CREATE TABLE` in `server/src/modules/**`) and the only `fetch()` call (`server/src/modules/feeds/sources.ts`).

All stored data lives in the App's SQLite database, which is kept per community on Root's App hosting. Module settings are JSON rows in the existing settings table under `module:<name>`. Unless a row says otherwise, data isn't deleted when a member leaves; it goes when staff delete it or the community removes the App.

## Outbound network requests

Only the **feeds** module contacts anything outside Root, and only for feeds an admin adds. No member data is sent. Every request carries the User-Agent `Taproot/1.1 (moderation app for Root communities; https://rootapp.com)` and times out after 15 seconds.

| Host | What for | What's sent |
|---|---|---|
| `www.youtube.com` | Upload RSS feed (`/feeds/videos.xml`), and the channel page once to turn an @handle or /c/ link into a channel ID | The channel ID or handle |
| `www.reddit.com` | `/r/<sub>/new.json`, with `/r/<sub>/new/.rss` as a fallback | The subreddit name |
| `id.twitch.tv` | App access token (`/oauth2/token`) | The client ID and secret the admin entered |
| `api.twitch.tv` | Helix stream and user lookups | The channel login, client ID and access token |
| `kick.com` | `/api/v2/channels/<slug>` | The channel slug |

Requests follow redirects, so YouTube may redirect to its consent pages. Everything else Taproot does goes through Root's own SDK, including push notifications (`notifications.send`).

## Push notifications (sent through Root, not stored)

Push notifications go to the member's devices and can show on lock screens. Taproot never puts moderation reasons in them.

| Module | When | Content |
|---|---|---|
| modtools | A member is warned, muted, kicked or banned. This is **off by default**, and each action is switched on separately. | Generic text with the action and community name. No reason. |
| utility | A member's highlight keyword is said | The keyword, channel name, author name and up to about 150 characters of the message |
| events | A member wins a giveaway, or enters one without the required role | The prize (shortened) and the role name |
| support | A member's ticket is closed | "Your ticket #N was closed" |
| support | A member's form submission is reviewed | A generic "form update" message, with no status or note |

## Per module

### logs (action log)
- **Stored:** settings only (`module:logs`): log channel IDs, event switches, per-event channel overrides, ignored channels, and announcement channel and templates. Kept until an admin changes them.
- **Memory only, never written to disk:**
  - The ID, channel, author ID and text (first 2,000 characters) of recent messages. This is capped at 5,000 messages or 24 hours, whichever comes first. It's used to show deleted and edited content, and is collected only while delete or edit logging is on. Ignored channels are left out, and it's cleared when that logging is turned off or Taproot restarts.
  - Role, channel and channel-group names and settings, and who is in each voice channel.
- **Posted to the log channel** (a staff channel the admin picks): deleted and edited message text, member names and IDs, and account age on join.
- Uses the existing `member_names` table for display names.

### utility
| Table | Data | Kept |
|---|---|---|
| `utility_afk` | User ID, AFK note (up to 200 characters), when it was set, and the ID of the message that set it | Until the member posts again or clears it |
| `utility_highlights` | User ID, keyword, created time | Until the member removes it |
| `utility_autoresponders` | Trigger, response, reaction, channel IDs, cooldown, use count, creator's user ID, created time | Until staff delete it |

In memory only, for 5 minutes or less: recent post times per channel, cooldowns, and cached member and access-rule lists.

### automodplus (auto-mod additions, channel rules, join protection)
| Table / setting | Data | Kept |
|---|---|---|
| `automodplus_expiring` | Message ID, channel ID, delete time (auto delete "after") | Until the message is deleted, at most 7 days. At most 20,000 are queued. |
| `automodplus_purges` | Channel, schedule, last run time and count, the admin who created it, created time | Until removed |
| `automodplus_raid` | Start and end times, reason, locked channels, the join throttle before the raid | Until the raid ends |
| `module:automodplus` | Rule settings, name patterns, scam domains, allowed invite codes | Until changed |

- The auto-mod settings themselves stay in the existing settings row.
- Autobans, automatic actions, auto purges and raid locks each create an ordinary mod-log case. Raid locks also use the existing `locks` table.
- A rule's optional log channel receives up to 300 characters of the removed message. That text is posted there only and not stored.
- In memory only: recent join times and slowmode timestamps.

### modtools
| Table | Data | Kept |
|---|---|---|
| `modtools_notes` | Member ID, note text, author ID and name, time | Until a moderator deletes it |
| `modtools_temp_roles` | Member ID, role ID and name, end time, who gave it (ID and name), created time | Until the role is taken back |
| `modtools_pending_roles` | Member ID, role ID, due time (timed autoroles) | Until the role is given or the member leaves |
| `modtools_voice_mutes` | Member ID, moderator ID, time | Until `vunmute` |
| `modtools_state` | The time of the latest member join handled | Overwritten on each join |
| `modtools_lock_timers` (created by the core lock command) | Channel ID, target, end time | Until unlocked |
| `module:modtools` | Timed autorole rules and notification switches | Until changed |

### engagement (levels and economy)
| Table | Data | Kept |
|---|---|---|
| `engagement_xp` | User ID, total XP, time of last XP | Until an admin resets it or the App is removed. It isn't deleted when the member leaves. |
| `engagement_wallets` | User ID, balance, daily streak, last daily and last work times | Same as above |
| `engagement_shop` | Admin-made items: name, description, role ID, price, stock | Until removed |
| `module:engagement` | Level and economy settings | Until changed |

Display names are cached in memory for 10 minutes, using the existing `member_names` table. Both features are off by default; nothing is recorded until an admin turns them on.

### events (giveaways, polls, starboard)
| Table | Data | Kept |
|---|---|---|
| `events_giveaways` | Channel, message ID, prize, winner count, required role, host ID, times, state, winner IDs | Until the App is removed. Deleted if the giveaway message is deleted before it ends. |
| `events_giveaway_entries` | Giveaway ID, member ID, entry time | Until the App is removed. Removed when the member takes their reaction back. |
| `events_polls` | Channel, message ID, question, options, creator ID, times | Until the App is removed |
| `events_poll_reactions` | Poll ID, member ID, option, reaction time | Until the App is removed. Removed when the reaction is removed. |
| `events_starboard` | Original message and channel IDs, author ID, starboard post ID and channel, star count, blocked flag, times | Until the original is deleted or the App is removed |
| `module:events` | Starboard settings | Until changed |

Starboard posts repost the message text (with mentions turned into plain names) in the starboard channel.

### support (tickets and forms)
| Table / setting | Data | Kept |
|---|---|---|
| `support_tickets` | Channel ID and name, opener ID and name, topic, claimer ID and name, times, who closed it and why, message count | Until an admin deletes the record |
| `support_tickets.transcript` | Plain-text transcript: message text, author names and attachment file names (up to the newest 3,000 messages) | Cleared after the retention period (**90 days by default**; 0 keeps them forever). Also posted to the ticket log channel. |
| `support_forms` | Form definitions: title, description, questions, channel, role, options | Until deleted |
| `support_submissions` | Form ID and title, member ID and name, answers, status, staff note, reviewer name, the channel and message it was posted to, times | Until staff delete it or delete the form |
| `module:support` | Ticket and form settings, and Taproot's own member ID | Until changed |

Half-opened tickets left by a restart are deleted after 10 minutes.

### feeds (social feeds and voice links)
| Table / setting | Data | Kept |
|---|---|---|
| `feeds_feeds` | Source type, ID and name, target channel, role to ping, template, who added it, timestamps, last error, failure count, and up to 200 recently seen item IDs or the last stream ID | Until the feed is removed |
| `feeds_voice_links` | Voice and text channel IDs, who created the link, created time | Until removed |
| `feeds_voice_grants` | Member ID, text channel ID, the access given, the member's previous access rule on that channel | While the member is in voice, or until a pending mute ends |
| `module:feeds` | Poll interval, Twitch client ID and client secret | Until an admin removes them. The secret is never logged or sent back to the GUI. |

The Twitch access token is kept in memory only. The outbound requests are listed at the top.
