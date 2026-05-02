import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Attachment, AttachmentKind, Uuid } from "@switchyard/shared";
import { requireAuth } from "../auth.js";
import { errorResponses, okJson, createdJson, noContent, stub, z } from "./_helpers.js";

const tag = "Attachments";
const idOrKey = z.string().min(1);

// Multipart form schema — documented for OpenAPI; Hono parses the body itself.
const MultipartUpload = z.object({
  file: z.any(), // binary
  kind: AttachmentKind,
  comment_id: Uuid.optional(),
  transcript: z.string().optional(),
});

const upload = createRoute({
  method: "post", path: "/v1/tickets/{idOrKey}/attachments", tags: [tag],
  summary: "Upload an attachment to a ticket (or a comment via comment_id form field)",
  request: {
    params: z.object({ idOrKey }),
    body: {
      content: {
        "multipart/form-data": { schema: MultipartUpload },
      },
    },
  },
  responses: { ...createdJson(Attachment), ...errorResponses },
});

const download = createRoute({
  method: "get", path: "/v1/attachments/{id}", tags: [tag],
  summary: "Download an attachment file (token-guarded; streams the bytes)",
  request: { params: z.object({ id: Uuid }) },
  responses: {
    200: {
      description: "file bytes",
      content: { "application/octet-stream": { schema: z.any() } },
    },
    ...errorResponses,
  },
});

const remove = createRoute({
  method: "delete", path: "/v1/attachments/{id}", tags: [tag], summary: "Delete an attachment",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

const meta = createRoute({
  method: "get", path: "/v1/attachments/{id}/meta", tags: [tag],
  summary: "Get attachment metadata (no file bytes)",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(Attachment), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/attachments/*", requireAuth);
  app.openapi(upload, stub);
  app.openapi(download, stub);
  app.openapi(remove, stub);
  app.openapi(meta, stub);
}
