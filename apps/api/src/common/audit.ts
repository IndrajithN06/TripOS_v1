import { Tx } from '../db/db.service';

export interface AuditEntry {
  agencyId: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Writes inside the caller's transaction so the audit row commits atomically with the change. */
export async function audit(tx: Tx, e: AuditEntry) {
  await tx.auditLog.create({
    data: {
      agencyId: e.agencyId, actorUserId: e.actorUserId ?? null, action: e.action, entityType: e.entityType,
      entityId: e.entityId ?? null, metadata: (e.metadata ?? {}) as any,
    },
  });
}
