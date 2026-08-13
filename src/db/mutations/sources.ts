import "server-only";
import { eq } from "drizzle-orm";
import { sources, sourceItems } from "@/db/schema";
import { withAuditedTransaction, logAdminAction } from "./shared";
import { createSourceSchema, createSourceItemSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { z } from "zod";

export async function createSource(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = createSourceSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const [source] = await tx
      .insert(sources)
      .values({
        name: data.name,
        sourceTypeId: data.sourceTypeId,
        homepageUrl: data.homepageUrl || undefined,
        notes: data.notes,
      })
      .returning();

    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "source",
      entityId: source.id,
      summary: `Created source "${source.name}"`,
    });

    return source;
  });
}

const updateSourceSchema = createSourceSchema.extend({ sourceId: z.coerce.number().int().positive() });

export async function updateSource(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = updateSourceSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const [updated] = await tx
      .update(sources)
      .set({
        name: data.name,
        sourceTypeId: data.sourceTypeId,
        homepageUrl: data.homepageUrl || undefined,
        notes: data.notes,
      })
      .where(eq(sources.id, data.sourceId))
      .returning();

    await logAdminAction(tx, admin, {
      action: "update",
      entityType: "source",
      entityId: data.sourceId,
      summary: `Updated source #${data.sourceId}`,
    });

    return updated;
  });
}

export async function createSourceItem(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = createSourceItemSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const [item] = await tx
      .insert(sourceItems)
      .values({
        sourceId: data.sourceId,
        itemTypeId: data.itemTypeId,
        url: data.url,
        canonicalUrl: data.canonicalUrl || undefined,
        title: data.title,
        author: data.author,
        publishedAt: data.publishedAt,
        excerpt: data.excerpt,
      })
      .returning();

    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "source_item",
      entityId: item.id,
      summary: `Created source item "${item.title ?? item.url}"`,
    });

    return item;
  });
}

const updateSourceItemSchema = createSourceItemSchema.extend({
  sourceItemId: z.coerce.number().int().positive(),
});

export async function updateSourceItem(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = updateSourceItemSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const [updated] = await tx
      .update(sourceItems)
      .set({
        sourceId: data.sourceId,
        itemTypeId: data.itemTypeId,
        url: data.url,
        canonicalUrl: data.canonicalUrl || undefined,
        title: data.title,
        author: data.author,
        publishedAt: data.publishedAt,
        excerpt: data.excerpt,
      })
      .where(eq(sourceItems.id, data.sourceItemId))
      .returning();

    await logAdminAction(tx, admin, {
      action: "update",
      entityType: "source_item",
      entityId: data.sourceItemId,
      summary: `Updated source item #${data.sourceItemId}`,
    });

    return updated;
  });
}
