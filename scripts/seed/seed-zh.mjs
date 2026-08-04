// 中文版种子入口：node scripts/seed/seed-zh.mjs [--db <sqlite 文件路径>]
// 用法：pnpm seed:zh                    # 默认写入 data/ste-memory.sqlite
//       pnpm run seed:zh -- --db /path/to/custom.db
import { runSeed } from "./seed-lib.mjs";
import * as data from "./seed-data-zh.mjs";
runSeed(data);
