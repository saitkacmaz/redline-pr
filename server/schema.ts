import { z } from 'zod';
import type { LoadTarget, PostRepliesRequest, SpecDocument, SyncRequest } from '../shared/types.js';

const CodeAnchorSchema = z.object({
  file: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  hunk: z.string(),
});

const MarginCommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  clauseId: z.string(),
  replyDraft: z.string().optional(),
  status: z.enum(['open', 'resolved', 'pushed_back']),
});

const SpecDocumentSchema: z.ZodType<SpecDocument> = z.object({
  id: z.string(),
  prTitle: z.string(),
  prNumber: z.number().optional(),
  branch: z.string(),
  baseBranch: z.string(),
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      clauses: z.array(
        z.object({
          id: z.string(),
          originalText: z.string(),
          currentText: z.string(),
          anchors: z.array(CodeAnchorSchema),
          riskFlag: z.string().optional(),
        }),
      ),
    }),
  ),
  comments: z.array(MarginCommentSchema),
});

export const SyncRequestSchema: z.ZodType<SyncRequest> = z.object({
  doc: SpecDocumentSchema,
  mode: z.enum(['run', 'export']),
});

export const PlanRequestSchema = z.object({ doc: SpecDocumentSchema });

export const PostRepliesSchema: z.ZodType<PostRepliesRequest> = z.object({
  doc: SpecDocumentSchema,
  commentIds: z.array(z.string()),
});

const LoadTargetSchema: z.ZodType<LoadTarget> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('auto') }),
  z.object({ kind: z.literal('local') }),
  z.object({ kind: z.literal('current') }),
  z.object({ kind: z.literal('pr'), number: z.number().int().positive() }),
]);

export const LoadRequestSchema = z.object({ target: LoadTargetSchema });
