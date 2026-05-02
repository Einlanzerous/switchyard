import { z } from "zod";
import { Uuid, Timestamps } from "./common.js";

// Per-project status transition graph.
// If a project has 0 rows: any status change is allowed (zero-config).
// If a project has any rows: only listed transitions are allowed; unlisted ones return 422.
// from_status_id NULL is a wildcard — "any source -> to_status_id".
export const StatusTransition = z
  .object({
    id: Uuid,
    project_id: Uuid,
    from_status_id: Uuid.nullable(),
    to_status_id: Uuid,
  })
  .merge(Timestamps);
export type StatusTransition = z.infer<typeof StatusTransition>;

export const CreateStatusTransition = z.object({
  from_status_id: Uuid.nullable().optional(),
  to_status_id: Uuid,
});
export type CreateStatusTransition = z.infer<typeof CreateStatusTransition>;
