export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class LeaseRequiredError extends DomainError {
  constructor(resourceId: string) {
    super(`resource ${resourceId} requires active lease`);
    this.name = "LeaseRequiredError";
  }
}

/** 设备已被其他租约占用，无法再 Acquire */
export class LeaseConflictError extends DomainError {
  constructor(public readonly resourceId: string) {
    super(`设备 ${resourceId} 已被占用（已有租约）`);
    this.name = "LeaseConflictError";
  }
}
