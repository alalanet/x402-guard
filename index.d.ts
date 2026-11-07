export interface PreflightOption {
  network: string;
  asset: string;
  amount: string;
  price: string;
  usd?: number;
  pay_to: string;
  decision: "allow" | "hold" | "block";
  reasons?: string[];
  payment_hash: string;
}

export interface Decision {
  url: string;
  decision: "allow" | "hold" | "block";
  options: PreflightOption[];
  choose?: PreflightOption;
  expires_at: string;
  attestation?: unknown;
  service?: Record<string, unknown>;
  /** known flaws of the payment library you declared (client); not signed, not logged */
  client_advisories?: Advisory[];
}

export interface Advisory {
  id: string;
  package: string;
  below: string;
  from?: string;
  severity: "critical" | "high" | "medium";
  summary: string;
  fixed_in: string;
  source: string;
  published: string;
}

export interface Paid {
  url: string;
  /** false when the seller refused the payment (nothing was settled) */
  paid: boolean;
  status: number;
  /** settlement transaction hash from the PAYMENT-RESPONSE header */
  tx?: string;
  network?: string;
  payer?: string;
  usd: number;
  response: Response;
}

export interface GuardOptions {
  /** alalanet base URL (default https://alalanet.com) */
  api?: string;
  /** optional alalanet bearer token for higher limits */
  token?: string;
  /** options above this price are blocked by alalanet */
  maxUsdPerCall?: number;
  /** rolling 24 h budget kept in memory by this guard */
  maxUsdPerDay?: number;
  /** rolling 24 h budget per seller host, kept in memory by this guard */
  maxUsdPerHostPerDay?: number;
  /**
   * your x402 payment library and version, e.g. "@x402/fetch@2.23.0" (comma-separated for several).
   * Default: detected from the installed @x402/* packages (Node only). alalanet warns about known flaws.
   */
  client?: string;
  /** set false to skip detecting installed @x402/* versions */
  detectClient?: boolean;
  /** called once with known flaws of your payment library (default: console.warn) */
  onAdvisory?(advisories: Advisory[]): void;
  /** never pay these hosts ("api.example.com" or "*.example.com") */
  denyHosts?: string[];
  /** if set, pay only these hosts */
  allowHosts?: string[];
  /** what to do with "hold" options (default "block") */
  onHold?: "block" | "allow";
  /** if alalanet cannot be reached: pass the 402 through (true) or refuse to pay (false, default) */
  failOpen?: boolean;
  /** fetch used to call alalanet (default: globalThis.fetch) */
  fetch?: typeof fetch;
  onDecision?(d: Decision): void;
  /**
   * Report each paid call to alalanet (POST /v1/purchases, verified on chain; no key needed).
   * true: "delivered" for 2xx, "not_delivered" otherwise. A function returns the outcome
   * ("delivered" | "partial" | "wrong_content" | "not_delivered") or null to skip.
   */
  report?: boolean | ((p: Paid) => "delivered" | "partial" | "wrong_content" | "not_delivered" | null | undefined);
  onReport?(r: { url: string; outcome: string; ok: boolean; status: number; result: unknown }): void;
  /** called after every payment attempt (check `paid`); use it to report the outcome (alalanet report_purchase) */
  onPaid?(p: Paid): void | Promise<void>;
  /**
   * Double-pay protection (default true): hold the signed payment per purchase (method + URL + body)
   * and re-present it on a retry while it is valid; after that, ask alalanet (payment_status, read on
   * chain) before a new payment may be signed. Set false to disable.
   */
  holdPayments?: boolean;
  /** called when a retry re-presents the held payment instead of a newly signed one */
  onRepresent?(e: { url: string; info: PaymentInfo }): void;
  /** called with alalanet's payment_status answer when the hold window has closed */
  onReconcile?(e: { url: string; status: PaymentStatus }): void;
}

export interface PaymentInfo {
  kind: "evm" | "svm";
  network: string;
  /** payer wallet */
  from: string;
  /** EVM exact: EIP-3009 nonce and validBefore (unix seconds) */
  nonce?: string;
  validBefore?: number;
  asset?: string;
  /** Solana exact: recent blockhash of the signed transaction */
  blockhash?: string;
}

export interface PaymentStatus {
  network: string;
  tx?: string;
  state: "settled" | "failed" | "pending" | "not_settled" | "expired_unsettled";
  retry: "do_not_pay_again" | "resend_same" | "new_payment_ok" | "wait";
  safe_to_sign_new: boolean;
  advice: string;
}

/** what the guard reads from a PAYMENT-SIGNATURE / X-PAYMENT value; null if it cannot be read */
export declare function paymentInfo(headerValue: string): PaymentInfo | null;
export declare function solanaPaymentInfo(txBase64: string): { signers: string[]; feePayer: string; blockhash: string };

export declare class X402GuardError extends Error {
  code: "blocked" | "held" | "denied_host" | "not_allowed_host" | "over_budget" | "alalanet_unreachable" | "bad_402" | "already_paid" | "payment_outcome_unknown";
  /** already_paid: the settlement transaction of the earlier payment */
  tx?: string;
  status?: PaymentStatus;
  url?: string;
  decision?: string;
  reasons?: string[];
  verdict?: Decision;
}

export declare function guardFetch(inner: typeof fetch, opts?: GuardOptions): typeof fetch;
