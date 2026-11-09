/** 一次前台生成的身份；同次递归沿用对象，切聊与新的生成分配新对象。 */
export interface GenerationIdentity {
  readonly id: number;
  readonly chatIdentity: string | undefined;
}
