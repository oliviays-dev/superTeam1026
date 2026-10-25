export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function shortId(value: string): string {
  return value.slice(0, 8);
}
