/** Joins class names, skipping falsy ones: cx(styles.a, active && styles.b). */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
