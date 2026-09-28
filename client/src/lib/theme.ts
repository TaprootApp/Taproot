import { rootClient, RootClientThemeEvent } from "@rootsdk/client-app";
import type { RootThemeMode } from "@rootsdk/client-app";

// Root injects its --rootsdk-* color variables and swaps them on theme
// change, so the CSS needs nothing else. This mirrors the mode onto <html>
// as `color-scheme` (native controls, scrollbars) and `data-theme` (for the
// few rules that differ, like shadow strength).

function apply(mode: RootThemeMode): void {
  document.documentElement.style.colorScheme = mode;
  document.documentElement.dataset.theme = mode;
}

export function initTheme(): void {
  try {
    apply(rootClient.theme.getTheme());
    rootClient.theme.on(RootClientThemeEvent.ThemeUpdate, apply);
  } catch {
    // Outside Root (plain browser): fall back to the OS preference.
    apply(window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }
}
