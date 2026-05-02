import { z } from "zod";
import { Uuid, Timestamps } from "./common.js";
import { ProjectRef } from "./project.js";
import { TicketType, Priority, TicketSummary } from "./ticket.js";
import { StatusCategory } from "./status.js";

export const BoardLayout = z.enum(["kanban", "list"]);
export type BoardLayout = z.infer<typeof BoardLayout>;

// Optional filter applied on top of the board's project set.
export const BoardFilter = z
  .object({
    types: z.array(TicketType).optional(),
    priorities: z.array(Priority).optional(),
    label_ids: z.array(Uuid).optional(),
    assignee_ids: z.array(Uuid).optional(),
    text: z.string().optional(),
    include_archived_projects: z.boolean().optional(),
  })
  .partial();
export type BoardFilter = z.infer<typeof BoardFilter>;

export const Board = z
  .object({
    id: Uuid,
    name: z.string().min(1).max(200),
    layout: BoardLayout,
    projects: z.array(ProjectRef),
    filter: BoardFilter,
  })
  .merge(Timestamps);
export type Board = z.infer<typeof Board>;

export const CreateBoard = z.object({
  name: z.string().min(1).max(200),
  layout: BoardLayout.default("kanban"),
  project_ids: z.array(Uuid).min(1),
  filter: BoardFilter.optional(),
});
export type CreateBoard = z.infer<typeof CreateBoard>;

export const UpdateBoard = CreateBoard.partial();
export type UpdateBoard = z.infer<typeof UpdateBoard>;

// Kanban view: tickets grouped by canonical category.
// Display-name-based columns can be derived client-side from each ticket's status.display_name.
export const BoardColumns = z.object({
  board: Board,
  columns: z.array(
    z.object({
      category: StatusCategory,
      tickets: z.array(TicketSummary),
    })
  ),
});
export type BoardColumns = z.infer<typeof BoardColumns>;
