import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseSillyTavernJsonl } from "../../sillytavern-jsonl/parser.ts";
import type { MemorySpaceManager } from "../../../../application/ports/memory-space.ts";
import type { SourceParseError } from "../../../../application/ports/source-chat.ts";

class InvalidChatFileError extends Error {
  readonly errors: readonly SourceParseError[];

  constructor(message: string, errors: readonly SourceParseError[] = []) {
    super(message);
    this.errors = errors;
  }
}

interface IdParams {
  readonly id: string;
}

interface RenameBody {
  readonly name?: unknown;
}

async function readCreateRequest(request: FastifyRequest) {
  let name: string | undefined;
  let file: { filename: string; content: string } | undefined;
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname === "file") {
        file = { filename: part.filename, content: (await part.toBuffer()).toString("utf8") };
      } else {
        part.file.resume();
      }
    } else if (part.fieldname === "name" && typeof part.value === "string") {
      name = part.value;
    }
  }
  return { name, file };
}

export function registerMemorySpaceRoutes(
  server: FastifyInstance,
  memorySpaces: MemorySpaceManager,
): void {
  server.get("/memory-spaces", async () => memorySpaces.list());

  server.post("/memory-spaces", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ message: "创建记忆空间必须上传 JSONL 文件" });
    }
    const { name, file } = await readCreateRequest(request);
    if (!file) return reply.code(400).send({ message: "创建记忆空间必须上传 JSONL 文件" });
    if (!name?.trim()) return reply.code(400).send({ message: "记忆空间名称不能为空" });
    try {
      if (!file.filename.toLowerCase().endsWith(".jsonl")) {
        throw new InvalidChatFileError("必须上传 .jsonl 文件");
      }
      const chat = parseSillyTavernJsonl(file.content);
      if (chat.messages.length === 0) {
        throw new InvalidChatFileError("文件中没有可导入的聊天消息", chat.errors);
      }
      return reply.code(201).send(await memorySpaces.create({ name, chat }));
    } catch (error) {
      if (error instanceof InvalidChatFileError) {
        return reply.code(422).send({ message: error.message, errors: error.errors });
      }
      throw error;
    }
  });

  server.patch<{ Params: IdParams; Body: RenameBody }>(
    "/memory-spaces/:id",
    async (request, reply) => {
      if (typeof request.body?.name !== "string") {
        return reply.code(400).send({ message: "记忆空间名称不能为空" });
      }
      const result = await memorySpaces.rename(
        request.params.id as MemorySpaceId,
        request.body.name,
      );
      return result ?? reply.code(404).send({ message: "记忆空间不存在" });
    },
  );

  server.delete<{ Params: IdParams }>("/memory-spaces/:id", async (request, reply) => {
    if (!(await memorySpaces.delete(request.params.id as MemorySpaceId))) {
      return reply.code(404).send({ message: "记忆空间不存在" });
    }
    return reply.code(204).send();
  });

  server.get<{ Params: IdParams }>("/memory-spaces/:id/messages", async (request, reply) => {
    const messages = await memorySpaces.messages(request.params.id as MemorySpaceId);
    return messages ?? reply.code(404).send({ message: "记忆空间不存在" });
  });

  server.get<{ Params: IdParams }>("/memory-spaces/:id/parse-errors", async (request, reply) => {
    const errors = await memorySpaces.errors(request.params.id as MemorySpaceId);
    return errors ?? reply.code(404).send({ message: "记忆空间不存在" });
  });
}
