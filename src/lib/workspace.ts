import type { ColorSchemes } from "./colorSchemes";
import type { FontSettings } from "./fonts";
import type { Language } from "./i18n";
import type { Preferences } from "./preferences";
import type { Project, ThemePreference } from "./types";

export interface WorkspaceSnapshot {
  language?: Language;
  projects: Project[];
  activeProjectId: string | null;
  theme: ThemePreference;
  preferences: Preferences;
  colorSchemes: ColorSchemes;
  fonts: FontSettings;
}
