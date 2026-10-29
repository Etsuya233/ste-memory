/** Compact local timestamp shared by list rows: 10/28 14:05, with the year when different. */
export function formatCompactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  const datePart = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === new Date().getFullYear()
    ? `${datePart} ${timePart}`
    : `${date.getFullYear()}/${datePart} ${timePart}`;
}
