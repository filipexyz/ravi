export type OrganizationMemberStatus = "active" | "invited" | "suspended" | "removed";
export type OrganizationMember = {
  userId: string; name: string; email: string | null;
  status: OrganizationMemberStatus; version: string;
};
export type OrganizationMembers = { members: OrganizationMember[]; currentUserId: string };
export type MembershipChange = {
  operationId: string; userId: string; expectedVersion: string;
  status: "active" | "suspended" | "removed";
};
export type MembershipReceipt = { operationId: string; member: OrganizationMember; changed: boolean };
