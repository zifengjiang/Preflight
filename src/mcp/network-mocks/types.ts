import type { NetworkMockRule } from "../visual-flow/types.js";

export type { NetworkMockRule, NetworkMockResponse } from "../visual-flow/types.js";

export interface NetworkMockRuleStats {
  urlPattern?: string;
  urlRegex?: string;
  description?: string;
  callCount: number;
}

export interface NetworkMockStats {
  running: boolean;
  port: number;
  rules: NetworkMockRuleStats[];
  /** Whether HTTPS MITM is active (root CA was generated successfully). */
  mitmEnabled: boolean;
}
