import "server-only";
import { eq } from "drizzle-orm";
import { topics } from "@/db/schema";
import { withAuditedTransaction, logAdminAction, isUniqueViolation } from "./shared";
import { createTopicSchema, slugSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { z } from "zod";

export class DuplicateTopicSlugError extends Error {
  constructor() {
    super("A topic with this slug already exists for this project.");
    this.name = "DuplicateTopicSlugError";
  }
}


export async function createTopic(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = createTopicSchema.parse(input);

  try {
    return await withAuditedTransaction(async (tx) => {
      const [topic] = await tx.insert(topics).values(data).returning();
      await logAdminAction(tx, admin, {
        action: "create",
        entityType: "topic",
        entityId: topic.id,
        summary: `Created topic "${topic.name}"`,
      });
      return topic;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateTopicSlugError();
    throw err;
  }
}

const renameTopicSchema = z.object({
  topicId: z.coerce.number().int().positive(),
  name: z.string().trim().min(2).max(200),
  slug: slugSchema,
  description: z.string().trim().max(2000).optional(),
});

export async function renameTopic(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = renameTopicSchema.parse(input);

  try {
    return await withAuditedTransaction(async (tx) => {
      const [updated] = await tx
        .update(topics)
        .set({ name: data.name, slug: data.slug, description: data.description })
        .where(eq(topics.id, data.topicId))
        .returning();
      await logAdminAction(tx, admin, {
        action: "update",
        entityType: "topic",
        entityId: data.topicId,
        summary: `Renamed topic #${data.topicId} to "${data.name}"`,
      });
      return updated;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateTopicSlugError();
    throw err;
  }
}
