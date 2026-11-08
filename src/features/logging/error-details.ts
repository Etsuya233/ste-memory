/** 在消息被转换为字符串前保留异常链；日志不复制导入正文或整份 HTTP 响应。 */
export function errorDetails(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined ? {} : { cause: errorDetails(error.cause) }),
  };
}
