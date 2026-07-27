# 首个实验只使用 SQLite

首个实验以单用户、本地运行和快速复现为目标，只实现 SQLite 持久化。Core Memory 与 HTTP Adapter Source Store 分别通过连接 URL 配置，可以指向同一个 SQLite 文件或两个文件，并允许使用不同数据访问依赖；即使共享文件也保持表所有权分离。PostgreSQL 和迁移支持等到服务化或并发需求出现后再引入。
