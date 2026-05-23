import type { Lease } from "./Lease.js";

export class LeaseManager {
  constructor(public readonly leases: Lease[]) {}
}
