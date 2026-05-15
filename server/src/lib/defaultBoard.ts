// Helpers for the auto-managed default board (the "All projects" board
// created at first boot by seed.ts).
//
// Project lifecycle hooks call these so the board's project list stays in
// sync without each handler having to know whether the auto-include board
// exists. Each function is a no-op when there is no auto-include board.

import { and, eq } from "drizzle-orm";
import type { db as defaultDb } from "../db.js";
import * as schema from "../../drizzle/schema.js";

type Tx = typeof defaultDb;

export const DEFAULT_BOARD_DELETED_KEY = "default_board_deleted";

async function findAutoIncludeBoardId(tx: Tx): Promise<string | null> {
  const [row] = await tx
    .select({ id: schema.boards.id })
    .from(schema.boards)
    .where(eq(schema.boards.auto_include_all_projects, true))
    .limit(1);
  return row?.id ?? null;
}

export async function addProjectToDefaultBoard(tx: Tx, projectId: string): Promise<void> {
  const boardId = await findAutoIncludeBoardId(tx);
  if (!boardId) return;
  await tx
    .insert(schema.boardProjects)
    .values({ board_id: boardId, project_id: projectId })
    .onConflictDoNothing();
}

export async function removeProjectFromDefaultBoard(tx: Tx, projectId: string): Promise<void> {
  const boardId = await findAutoIncludeBoardId(tx);
  if (!boardId) return;
  await tx
    .delete(schema.boardProjects)
    .where(
      and(
        eq(schema.boardProjects.board_id, boardId),
        eq(schema.boardProjects.project_id, projectId),
      ),
    );
}
