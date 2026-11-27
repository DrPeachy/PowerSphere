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
  sphereStyle?: string | null;
  centerGlyph?: string | null;
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

export interface ClockSettings {
  enabled: boolean;
  timezone: string;
}

export interface Bucket {
  id: string;
  name: string;
  icon?: string;
  items: ToolItem[];
}

export interface AppConfig {
  schemaVersion: number;
  autostart: boolean;
  gitBashPath?: string | null;
  anchor?: Anchor | null;
  style?: StyleSettings;
  clock?: ClockSettings;
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

export const TIMEZONES = [
  { id: "local", label: "跟随系统" },
  { id: "UTC", label: "UTC" },
  { id: "Asia/Shanghai", label: "北京 / 上海 (UTC+8)" },
  { id: "Asia/Hong_Kong", label: "香港 (UTC+8)" },
  { id: "Asia/Taipei", label: "台北 (UTC+8)" },
  { id: "Asia/Singapore", label: "新加坡 (UTC+8)" },
  { id: "Asia/Tokyo", label: "东京 (UTC+9)" },
  { id: "Asia/Seoul", label: "首尔 (UTC+9)" },
  { id: "Asia/Kolkata", label: "印度 (UTC+5:30)" },
  { id: "Asia/Dubai", label: "迪拜 (UTC+4)" },
  { id: "Europe/Moscow", label: "莫斯科 (UTC+3)" },
  { id: "Europe/Paris", label: "巴黎 / 柏林 (UTC+1/+2)" },
  { id: "Europe/London", label: "伦敦 (UTC+0/+1)" },
  { id: "America/Sao_Paulo", label: "圣保罗 (UTC-3)" },
  { id: "America/New_York", label: "纽约 (UTC-5/-4)" },
  { id: "America/Chicago", label: "芝加哥 (UTC-6/-5)" },
  { id: "America/Denver", label: "丹佛 (UTC-7/-6)" },
  { id: "America/Los_Angeles", label: "洛杉矶 (UTC-8/-7)" },
  { id: "Pacific/Auckland", label: "奥克兰 (UTC+12/+13)" },
  { id: "Australia/Sydney", label: "悉尼 (UTC+10/+11)" },
] as const;
