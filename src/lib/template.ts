export interface PlaceholderSpec {
  name: string;
  kind: "text" | "file";
  recent?: string[];
}

const TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)(?::(file|text))?\}/g;

export function inferKind(name: string): "text" | "file" {
  return /apk|path|file|dir|folder|exe/i.test(name) ? "file" : "text";
}

export function parseTemplate(command: string): PlaceholderSpec[] {
  const found: PlaceholderSpec[] = [];
  const seen = new Set<string>();
  for (const match of command.matchAll(TOKEN)) {
    const name = match[1];
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const hint = match[2];
    found.push({
      name,
      kind: hint === "file" || hint === "text" ? hint : inferKind(name),
    });
  }
  return found;
}

export function mergePlaceholders(
  command: string,
  stored: PlaceholderSpec[] | undefined,
): PlaceholderSpec[] {
  return parseTemplate(command).map((slot) => {
    const previous = stored?.find((spec) => spec.name === slot.name);
    return {
      name: slot.name,
      kind: previous?.kind ?? slot.kind,
      recent: previous?.recent ?? [],
    };
  });
}

export function quoteForShell(shell: string, value: string, force: boolean): string {
  const needs = force || /[\s"']/.test(value);
  if (!needs) {
    return value;
  }
  if (shell === "git-bash") {
    return `'${value.replaceAll("'", "'\\''")}'`;
  }
  if (shell === "powershell") {
    return `"${value.replaceAll("`", "``").replaceAll('"', '`"')}"`;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function substituteCommand(
  template: string,
  values: Record<string, string>,
  specs: PlaceholderSpec[],
  shell: string,
): string {
  return template.replace(TOKEN, (raw, name: string, hint?: string) => {
    const value = values[name]?.trim() ?? "";
    if (!value) {
      return raw;
    }
    const spec = specs.find((entry) => entry.name === name);
    const kind = spec?.kind ?? (hint === "file" || hint === "text" ? hint : inferKind(name));
    return quoteForShell(shell, value, kind === "file");
  });
}
