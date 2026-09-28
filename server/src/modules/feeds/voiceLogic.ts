// Pure overlay math for voice-text links. An overlay is Root's per-subject
// permission patch (ChannelOverlayPermission); a field that's absent means
// "inherit". No SDK imports, so the tests cover it offline.

export type Overlay = { [key: string]: boolean | undefined };

/** What a voice link grants on the text channel. */
export const GRANT: Overlay = {
  channelView: true,
  channelViewMessageHistory: true,
  channelCreateMessage: true,
};

/**
 * The fields to set for a member joining voice, given their current rule on
 * the text channel. Undefined means don't touch it: someone explicitly hid
 * the channel from them. An explicit "can't post" (a mute, a staff decision)
 * is kept, so joining voice never unmutes anyone.
 */
export function grantPatch(existing: Overlay | undefined): Overlay | undefined {
  if (existing?.channelView === false) return undefined;
  const patch: Overlay = { ...GRANT };
  if (existing?.channelCreateMessage === false) delete patch.channelCreateMessage;
  return patch;
}

/**
 * Takes the grant back out of the member's current rule. Only the fields the
 * grant set are put back to what they were before (or removed); anything
 * changed since, like a mute added while they were in voice, stays. Returns
 * undefined when nothing is left, meaning the rule should be deleted.
 */
export function stripGrant(current: Overlay, original: Overlay | null, patch: Overlay): Overlay | undefined {
  const next: Overlay = { ...current };
  for (const key of Object.keys(patch)) {
    // A field someone else changed after the grant is theirs now.
    if (current[key] !== patch[key]) continue;
    if (original && original[key] !== undefined) next[key] = original[key];
    else delete next[key];
  }
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  if (Object.keys(next).length === 0 && !original) return undefined;
  return next;
}
