// Message formatting helpers. Pure: no SDK imports.

export function userMention(name: string, userId: string): string {
  return `[@${escapeLinkText(name)}](root://user/${userId})`;
}

export function roleMention(name: string, roleId: string): string {
  return `[@${escapeLinkText(name)}](root://role/${roleId})`;
}

export function channelMention(name: string, channelId: string): string {
  return `[#${escapeLinkText(name)}](root://channel/${channelId})`;
}

function escapeLinkText(text: string): string {
  return text.replace(/[\[\]]/g, "");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Root messages allow 10,001 characters; stay safely under. */
export const MAX_MESSAGE = 9500;

/**
 * Fills {placeholders} in admin-written templates (welcome messages, custom
 * commands). Unknown placeholders are left as typed.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z.]+)\}/gi, (whole, key: string) => vars[key.toLowerCase()] ?? whole);
}
