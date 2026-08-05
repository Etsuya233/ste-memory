// datetime 字段统一契约：存储/API 使用 "YYYY-MM-DD HH:mm:ss"（无时区、固定宽度，
// 字典序比较即时间序比较）；输入控件 datetime-local 使用 "YYYY-MM-DDTHH:mm[:ss]"（T 分隔）。
// 存储值 -> 输入框值
export function storedToDatetimeLocal(value: string): string {
  return value.replace(" ", "T");
}

// 输入框值 -> 存储值；缺少秒时补 ":00"，非 datetime-local 格式原样返回
export function datetimeLocalToStored(value: string): string {
  if (!value.includes("T")) return value;
  const [datePart, timePart] = value.split("T");
  const time = timePart.length === 5 ? `${timePart}:00` : timePart;
  return `${datePart} ${time}`;
}
