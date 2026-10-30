export function formatEvent(group, event) {
  const name = group.split("/").at(-1);
  const time = new Date(event.timestamp).toISOString().slice(11, 23);
  return `${time}  ${name}  ${(event.message ?? "").trimEnd()}`;
}
