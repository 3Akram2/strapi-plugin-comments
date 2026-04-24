import { z } from 'zod';

// .passthrough() — `mentions` and `tags` are relations populated on demand and
// Zod's default `.object()` strips unknown keys. Without passthrough the
// validator silently drops them from every response even when they were
// populated by the service layer.
export const dbBaseCommentSchema = z.object({
  id: z.number(),
  documentId: z.string().nullable(),
  content: z.string(),
  blocked: z.boolean().nullable(),
  blockedThread: z.boolean().nullable(),
  blockReason: z.string().nullable(),
  isAdminComment: z.boolean().nullable(),
  removed: z.boolean().nullable(),
  approvalStatus: z.string().nullable(),
  related: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  authorId: z.string().nullable(),
  authorDocumentId: z.string().nullable(),
  authorName: z.string().nullable(),
  authorUsername: z.string().nullable(),
  authorEmail: z.string().email().nullable(),
  authorAvatar: z.string().nullable(),
  authorUser: z.union([z.string(), z.object({ id: z.number(), email: z.string().email() }).passthrough()]).optional().nullable(),
  locale: z.string().nullable(),
  reactionsCount: z.number().int().min(0).nullable(),
  mentions: z.array(z.any()).optional(),
  tags: z.array(z.any()).optional(),
}).passthrough();
