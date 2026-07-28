# 首个实验只使用 SQLite

首个实验以单用户、本地运行和快速复现为目标，只实现 SQLite 持久化。API App 使用 Kysely 与 better-sqlite3 管理唯一的应用数据库，`DATABASE_URL` 指向该文件；记忆定义、记录历史和 HTTP Source Store 通过模块命名保持逻辑所有权。API 显式执行 Kysely 迁移，并在连接建立时启用 SQLite 外键。

创建记忆空间时，一个异步 Unit of Work 覆盖空间、系统表、字段、显示策略、来源聊天、消息和解析错误。数据库上下文通过 AsyncLocalStorage 向所有持久化 Adapter 提供当前事务执行器。同一数据库中的嵌套 Unit of Work 加入已有事务，不建立 savepoint；内层异常被外层捕获后，外层仍可继续并决定最终提交。PostgreSQL、跨数据库事务和向量数据库组合等到出现实际需求后再设计。
