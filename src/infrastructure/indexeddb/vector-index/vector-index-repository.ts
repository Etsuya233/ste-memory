import type {
  RecordVector,
  VectorIndexRepository,
  VectorScope,
  VectorSuppression,
  VectorTask,
} from "../../../features/vector-index/types.ts";
import type { SteMemoryDatabase } from "../database.ts";

function inScope(row: VectorScope, scope: VectorScope): boolean {
  return (
    row.memorySpaceId === scope.memorySpaceId &&
    (scope.tableId === undefined || row.tableId === scope.tableId) &&
    (scope.recordId === undefined || row.recordId === scope.recordId)
  );
}

export class DexieVectorIndexRepository implements VectorIndexRepository {
  private readonly db: SteMemoryDatabase;
  constructor(db: SteMemoryDatabase) {
    this.db = db;
  }

  async saveTask(task: VectorTask): Promise<void> {
    await this.db.vectorTasks.put(task);
    if (task.status === "queued" || task.status === "running") return;
    const terminal = (await this.db.vectorTasks.toArray()).filter(
      (row) => row.status !== "queued" && row.status !== "running",
    );
    if (terminal.length <= 1000) return;
    terminal.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    await this.db.vectorTasks.bulkDelete(terminal.slice(1000).map((row) => row.id));
  }
  async getTask(id: string): Promise<VectorTask | undefined> {
    return this.db.vectorTasks.get(id);
  }
  async listTasks(): Promise<VectorTask[]> {
    return this.db.vectorTasks.toArray();
  }
  async deleteTasks(scope: VectorScope): Promise<void> {
    const rows = await this.db.vectorTasks
      .where("memorySpaceId")
      .equals(scope.memorySpaceId)
      .toArray();
    await this.db.vectorTasks.bulkDelete(
      rows.filter((row) => inScope(row, scope)).map((row) => row.id),
    );
  }
  async saveVector(vector: RecordVector): Promise<void> {
    await this.db.recordVectors.put(vector);
  }
  async getVector(id: string): Promise<RecordVector | undefined> {
    return this.db.recordVectors.get(id);
  }
  async deleteVector(id: string): Promise<void> {
    await this.db.recordVectors.delete(id);
  }
  async listVectors(scope: VectorScope): Promise<RecordVector[]> {
    if (scope.tableId !== undefined && scope.recordId !== undefined)
      return this.db.recordVectors
        .where("[memorySpaceId+tableId+recordId]")
        .equals([scope.memorySpaceId, scope.tableId, scope.recordId])
        .toArray();
    if (scope.tableId !== undefined)
      return this.db.recordVectors
        .where("[memorySpaceId+tableId]")
        .equals([scope.memorySpaceId, scope.tableId])
        .toArray();
    const rows = this.db.recordVectors.where("memorySpaceId").equals(scope.memorySpaceId);
    return scope.recordId !== undefined
      ? rows.filter((row) => row.recordId === scope.recordId).toArray()
      : rows.toArray();
  }
  async deleteVectors(scope: VectorScope): Promise<void> {
    const rows = await this.listVectors(scope);
    await this.db.recordVectors.bulkDelete(rows.map((row) => row.id));
  }
  async saveSuppression(suppression: VectorSuppression): Promise<void> {
    await this.db.vectorSuppressions.put(suppression);
  }
  async getSuppression(id: string): Promise<VectorSuppression | undefined> {
    return this.db.vectorSuppressions.get(id);
  }
  async deleteSuppression(id: string): Promise<void> {
    await this.db.vectorSuppressions.delete(id);
  }
  async listSuppressions(): Promise<VectorSuppression[]> {
    return this.db.vectorSuppressions.toArray();
  }
  async deleteSuppressions(scope: VectorScope): Promise<void> {
    const rows = await this.db.vectorSuppressions
      .where("memorySpaceId")
      .equals(scope.memorySpaceId)
      .toArray();
    await this.db.vectorSuppressions.bulkDelete(
      rows
        .filter((row) => {
          const [, tableId, recordId] = row.id.split("\u0000");
          return (
            (scope.tableId === undefined || tableId === scope.tableId) &&
            (scope.recordId === undefined || recordId === scope.recordId)
          );
        })
        .map((row) => row.id),
    );
  }
}
