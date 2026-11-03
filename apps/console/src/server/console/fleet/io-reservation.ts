import type { TransactionSql } from "postgres";
import { FleetError, type FleetActor } from "./contract";

export type IoReservation = { inputHash: string; leaseId: string; expiresAt: string; completed: boolean };
export function assertReservation(reservation: IoReservation | null, leaseId: string, inputHash: string) {
  if (!reservation || reservation.leaseId !== leaseId || reservation.inputHash !== inputHash || reservation.completed ||
    Date.parse(reservation.expiresAt) <= Date.now()) throw new FleetError("operation_outcome_unknown", 409);
}
export function reservationConflict(reservation: IoReservation): never {
  throw new FleetError(Date.parse(reservation.expiresAt) > Date.now() ? "operation_in_progress" : "operation_outcome_unknown", 409);
}
export function postgresReservations(tx: TransactionSql, actor: FleetActor) {
  return {
    async reservation(id: string): Promise<IoReservation | null> {
      const [row] = await tx`select * from fleet_io_reservations where organization_id=${actor.organizationId} and operation_id=${id}`;
      if (!row) return null;
      if (row.actor_id !== actor.userId) throw new FleetError("idempotency_conflict", 409);
      return { inputHash: row.input_hash, leaseId: row.lease_id, expiresAt: new Date(row.expires_at).toISOString(), completed: !!row.completed_at };
    },
    async putReservation(id: string, value: IoReservation) {
      await tx`insert into fleet_io_reservations(organization_id,operation_id,actor_id,input_hash,lease_id,expires_at)
        values(${actor.organizationId},${id},${actor.userId},${value.inputHash},${value.leaseId},${value.expiresAt})`;
    },
    async renewReservation(id: string, previousLeaseId: string, value: IoReservation) {
      const rows = await tx`update fleet_io_reservations set lease_id=${value.leaseId}, expires_at=${value.expiresAt}
        where organization_id=${actor.organizationId} and operation_id=${id} and actor_id=${actor.userId}
          and lease_id=${previousLeaseId} and input_hash=${value.inputHash} and completed_at is null
        returning operation_id`;
      return rows.length === 1;
    },
    async finishReservation(id: string) {
      await tx`update fleet_io_reservations set completed_at=clock_timestamp() where organization_id=${actor.organizationId} and operation_id=${id}`;
    },
  };
}
