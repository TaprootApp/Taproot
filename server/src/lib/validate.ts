// Input rules shared by the text commands and the GUI services. Pure: no SDK
// imports, so the tests can cover them.

export const PREFIX_RULE = "Pick 1 to 3 characters, no spaces or brackets.";

/** A command prefix: 1 to 3 characters, no whitespace or brackets. */
export function validPrefix(prefix: string | undefined): prefix is string {
  return Boolean(prefix) && prefix!.length <= 3 && !/[\s[\]()]/.test(prefix!);
}

/** Strips a scheme and path; undefined unless it looks like a domain. */
export function normalizeDomain(input: string | undefined): string | undefined {
  const domain = input?.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return domain && domain.includes(".") ? domain : undefined;
}
