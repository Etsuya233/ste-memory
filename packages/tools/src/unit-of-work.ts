export interface UnitOfWork {
  run<TResult>(operation: () => Promise<TResult>): Promise<TResult>;
}
