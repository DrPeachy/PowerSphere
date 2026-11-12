export interface Anchor {
  x: number;
  y: number;
}

export interface PlaceholderSpec {
  name: string;
  kind: "text" | "file";
  recent?: string[];
}

export interface StyleSettings {
  snapInset: number;
  gap: number;
  sphereSize: number;
  animationMs: number;
  unfocusedOpacity: number;
}

export interface ToolItem {
  id: string;
  label: string;
  type: string;
  target?: string;
  shell?: string;
  cwd?: string;
  command?: string;
  args?: string;
  icon?: string;
  placeholders?: PlaceholderSpec[];
}

export interface Bucket {
  id: string;
  name: string;
  items: ToolItem[];
}

export interface AppConfig {
  schemaVersion: number;
  autostart: boolean;
  gitBashPath?: string | null;
  anchor?: Anchor | null;
  style?: StyleSettings;
  buckets: Bucket[];
}

export interface AppSnapshot {
  config: AppConfig;
  warning: string | null;
  configPath: string;
  gitBashDetected: string | null;
  gitBashError: string | null;
}

export type NewTool =
  | { type: "open-path"; label: string; target: string; icon?: string }
  | {
      type: "command";
      label: string;
      shell: string;
      cwd?: string;
      command: string;
      icon?: string;
      placeholders?: PlaceholderSpec[];
    }
  | {
      type: "bat";
      label: string;
      target: string;
      cwd?: string;
      args?: string;
      icon?: string;
    };

export interface RunOutput {
  message: string;
  pid: number | null;
}

export const SHELLS = [
  { id: "git-bash", label: "Git Bash" },
  { id: "powershell", label: "PowerShell" },
  { id: "cmd", label: "CMD" },
] as const;
