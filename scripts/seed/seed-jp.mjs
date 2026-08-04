// 日文版种子入口：node scripts/seed/seed-jp.mjs [--db <sqlite 文件路径>]
// 用法：pnpm seed:jp                    # 默认写入 data/ste-memory.sqlite
//       pnpm run seed:jp -- --db /path/to/custom.db
import { runSeed } from "./seed-lib.mjs";
import * as data from "./seed-data-jp.mjs";
runSeed(data);
