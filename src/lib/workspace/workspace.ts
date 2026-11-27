import type { ColorSchemes } from "../settings/colorSchemes";
import type { FontSettings } from "../settings/fonts";
import type { Language } from "../i18n";
import type { Preferences } from "../settings/preferences";
import type { Project, ThemePreference } from "../types";

export interface WorkspaceSnapshot {
  language?: Language;
  projects: Project[];
  activeProjectId: string | null;
  theme: ThemePreference;
  preferences: Preferences;
  colorSchemes: ColorSchemes;
  fonts: FontSettings;
}
