import type { Component } from "svelte";
import Archive from "@lucide/svelte/icons/archive";
import Book from "@lucide/svelte/icons/book";
import Box from "@lucide/svelte/icons/box";
import Bug from "@lucide/svelte/icons/bug";
import Clipboard from "@lucide/svelte/icons/clipboard";
import Cloud from "@lucide/svelte/icons/cloud";
import Code from "@lucide/svelte/icons/code";
import Command from "@lucide/svelte/icons/command";
import Cpu from "@lucide/svelte/icons/cpu";
import Database from "@lucide/svelte/icons/database";
import Download from "@lucide/svelte/icons/download";
import File from "@lucide/svelte/icons/file";
import FileCode from "@lucide/svelte/icons/file-code";
import Folder from "@lucide/svelte/icons/folder";
import FolderOpen from "@lucide/svelte/icons/folder-open";
import Gamepad2 from "@lucide/svelte/icons/gamepad-2";
import GitBranch from "@lucide/svelte/icons/git-branch";
import GitMerge from "@lucide/svelte/icons/git-merge";
import Globe from "@lucide/svelte/icons/globe";
import Hammer from "@lucide/svelte/icons/hammer";
import Image from "@lucide/svelte/icons/image";
import Layers from "@lucide/svelte/icons/layers";
import Link from "@lucide/svelte/icons/link";
import List from "@lucide/svelte/icons/list";
import Music from "@lucide/svelte/icons/music";
import Package from "@lucide/svelte/icons/package";
import Play from "@lucide/svelte/icons/play";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import Rocket from "@lucide/svelte/icons/rocket";
import Search from "@lucide/svelte/icons/search";
import Server from "@lucide/svelte/icons/server";
import Settings from "@lucide/svelte/icons/settings";
import Smartphone from "@lucide/svelte/icons/smartphone";
import Star from "@lucide/svelte/icons/star";
import Terminal from "@lucide/svelte/icons/terminal";
import Trash from "@lucide/svelte/icons/trash";
import Upload from "@lucide/svelte/icons/upload";
import Wrench from "@lucide/svelte/icons/wrench";
import Zap from "@lucide/svelte/icons/zap";
import { mark } from "./layout";

export type SphereIcon = Component<{ strokeWidth?: number; size?: number | string }>;

export const SPHERE_ICONS = {
  folder: Folder,
  file: File,
  terminal: Terminal,
  "git-branch": GitBranch,
  "git-merge": GitMerge,
  smartphone: Smartphone,
  globe: Globe,
  link: Link,
  code: Code,
  wrench: Wrench,
  settings: Settings,
  play: Play,
  package: Package,
  database: Database,
  bug: Bug,
  "gamepad-2": Gamepad2,
  music: Music,
  image: Image,
  search: Search,
  download: Download,
  upload: Upload,
  "refresh-cw": RefreshCw,
  trash: Trash,
  star: Star,
  zap: Zap,
  box: Box,
  cpu: Cpu,
  server: Server,
  cloud: Cloud,
  book: Book,
  clipboard: Clipboard,
  list: List,
  layers: Layers,
  command: Command,
  hammer: Hammer,
  rocket: Rocket,
  archive: Archive,
  "folder-open": FolderOpen,
  "file-code": FileCode,
} as const satisfies Record<string, SphereIcon>;

export type SphereIconName = keyof typeof SPHERE_ICONS;

const RULES: Array<[RegExp, SphereIconName]> = [
  [/wwise|\.bnk\b|\.bank\b|音频|音乐/, "music"],
  [/\badb\b|\.apk\b|\bapk\b|android|安卓/, "smartphone"],
  [/git[\s-]*merge|合并/, "git-merge"],
  [/branch|分支/, "git-branch"],
  [/\bgit\b/, "git-branch"],
  [/\.bat\b|\.cmd\b|powershell|git-bash|\bbash\b|cmd\.exe|\bcmd\b|终端|批处理/, "terminal"],
  [/https?:\/\/|www\./, "globe"],
  [/\.(png|jpe?g|gif|webp|svg|ico)\b|图片|图像/, "image"],
  [/\.(js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|cs|cpp|c|h|html|css|json|xml|lua|toml)\b/, "file-code"],
  [/\.(zip|7z|rar|tar|gz)\b|压缩|归档/, "archive"],
  [/database|postgres|sqlite|mongo|\bsql\b|数据库/, "database"],
  [/\bbug\b|缺陷/, "bug"],
  [/gamepad|steam|游戏/, "gamepad-2"],
  [/download|下载/, "download"],
  [/upload|上传/, "upload"],
  [/search|查找|搜索/, "search"],
  [/trash|delete|删除/, "trash"],
  [/star|收藏/, "star"],
  [/refresh|同步|刷新/, "refresh-cw"],
  [/rocket|deploy|发布/, "rocket"],
  [/hammer|构建/, "hammer"],
  [/package|\bnpm\b|\bpnpm\b|\bpip\b/, "package"],
  [/\bcpu\b|芯片/, "cpu"],
  [/server|服务器/, "server"],
  [/cloud|云盘|云/, "cloud"],
  [/clipboard|剪贴板/, "clipboard"],
  [/\blist\b|清单/, "list"],
  [/layers|图层/, "layers"],
  [/settings|设置|配置/, "settings"],
  [/wrench|工具/, "wrench"],
  [/\bzap\b|闪电/, "zap"],
  [/\bplay\b|播放/, "play"],
  [/folder-open|打开文件夹/, "folder-open"],
  [/\blink\b|链接/, "link"],
  [/\bcode\b|代码/, "code"],
  [/command|命令/, "command"],
  [/\bbox\b|盒子/, "box"],
  [/book|文档|\.pdf\b|readme/, "book"],
];

export function isIconName(name: string): name is SphereIconName {
  return Object.prototype.hasOwnProperty.call(SPHERE_ICONS, name);
}

export function suggestIcon(text: string): SphereIconName | null {
  const hay = text.toLowerCase();
  for (const [pattern, name] of RULES) {
    if (pattern.test(hay)) {
      return name;
    }
  }
  if (looksLikeDirectory(text)) {
    return "folder";
  }
  if (looksLikeFile(text)) {
    return "file";
  }
  return null;
}

export function resolveSphereMark(
  stored: string | undefined,
  hint: string,
  label: string,
): { icon: SphereIcon | null; text: string } {
  const chosen = stored?.trim() ?? "";
  if (chosen && isIconName(chosen)) {
    return { icon: SPHERE_ICONS[chosen], text: "" };
  }
  if (chosen) {
    return { icon: null, text: chosen };
  }
  const suggested = suggestIcon(hint);
  if (suggested) {
    return { icon: SPHERE_ICONS[suggested], text: "" };
  }
  return { icon: null, text: mark(label) };
}

function pathTokens(text: string): string[] {
  return text.split(/\s+/).filter((token) => /[\\/]/.test(token) || /^[a-z]:/i.test(token));
}

function fileBase(token: string): string {
  return token.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

function looksLikeDirectory(text: string): boolean {
  return pathTokens(text).some((token) => {
    const base = fileBase(token);
    return base.length > 0 && !base.includes("%") && !/\.[a-z0-9]{1,8}$/i.test(base);
  });
}

function looksLikeFile(text: string): boolean {
  return pathTokens(text).some((token) => /\.[a-z0-9]{1,8}$/i.test(fileBase(token)));
}
